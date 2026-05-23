// Minimal agent-socket client for the Chrome extension service worker.
//
// Speaks the same WS frame protocol as @agent-socket/sdk, but bundled inline
// (no module resolution, no `ws` peer dep). Exposes:
//
//   new ASClient({ baseUrl, appId, agentsMd, appDescription, tools })
//   client.connect()         → resolves on register_reply { ok: true }
//   client.mintToken(label)  → resolves with { token, url, label }
//   client.listTokens()
//   client.revokeToken(t)
//   client.close()
//
// `tools` is [{ method?, path, description, input_schema?, handler }].
// handler receives { method, path, body, headers } and returns either a raw
// value (body, status 200) or { status, body }.

const DEFAULT_BASE = "https://agentsocket.dev"

export class ASClient {
  constructor(opts) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "")
    this.appId = opts.appId
    this.agentsMd = opts.agentsMd ?? ""
    this.appDescription = opts.appDescription ?? ""
    this.toolsByRoute = new Map()
    this.toolDefs = (opts.tools ?? []).map((t) => {
      const def = {
        method: (t.method ?? "POST").toUpperCase(),
        path: t.path,
        description: t.description ?? "",
        ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
      }
      this.toolsByRoute.set(`${def.method} ${def.path}`, t.handler)
      return def
    })

    this.ws = null
    this.sessionId = ""
    this.registered = false
    this.pendingFrameReplies = new Map()
    this.onStatusChange = opts.onStatusChange ?? (() => {})
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 25_000
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 50_000
    this._heartbeatTimer = null
    this._heartbeatDeadlineTimer = null
    this._pendingPingId = null
    this._closed = false
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === 1 && this.registered
  }

  async connect() {
    if (this._closed) throw new Error("client is closed")
    this._emitStatus("connecting")
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/v1/_ws"
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    await new Promise((resolve, reject) => {
      const onOpen = () => { ws.removeEventListener("error", onError); resolve() }
      const onError = (e) => { ws.removeEventListener("open", onOpen); reject(new Error("ws open failed")) }
      ws.addEventListener("open", onOpen, { once: true })
      ws.addEventListener("error", onError, { once: true })
    })

    ws.addEventListener("message", (ev) => this._onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)))
    ws.addEventListener("close", (ev) => this._onClose(ev.code, ev.reason))
    ws.addEventListener("error", () => { /* close will follow */ })

    this._send({
      type: "register",
      appId: this.appId,
      agentsMd: this.agentsMd,
      appDescription: this.appDescription,
      tools: this.toolDefs,
    })

    const reply = await this._waitForFrame((m) => m.type === "register_reply", 10_000)
    if (!reply.ok) {
      const code = reply.error?.code ?? "unknown"
      throw new Error(`register failed: ${code}`)
    }
    this.sessionId = reply.sessionId
    this.registered = true
    this._scheduleNextPing()
    this._emitStatus("connected")
  }

  async mintToken(label) {
    const id = uid()
    this._send({ type: "mint_agent_token", id, label: label ?? "" })
    const reply = await this._awaitReply(id, 10_000)
    if (!reply.ok) throw new Error(`mint failed: ${reply.error?.code ?? "unknown"}`)
    const url = String(reply.url).replace(/^__BASE__/, this.baseUrl)
    return { token: reply.token, url, label: reply.label ?? label ?? "" }
  }

  async listTokens() {
    const id = uid()
    this._send({ type: "list_agent_tokens", id })
    const reply = await this._awaitReply(id, 10_000)
    return (reply.tokens ?? []).map((t) => ({
      token: t.token,
      url: String(t.url).replace(/^__BASE__/, this.baseUrl),
      label: t.label ?? "",
      mintedAt: t.mintedAt ?? 0,
    }))
  }

  async revokeToken(token) {
    const id = uid()
    this._send({ type: "revoke_agent_token", id, token })
    const reply = await this._awaitReply(id, 10_000)
    return !!reply.ok
  }

  /** Replace the registered toolset. Requires a fresh connection. */
  setTools(tools) {
    this.toolsByRoute.clear()
    this.toolDefs = tools.map((t) => {
      const def = {
        method: (t.method ?? "POST").toUpperCase(),
        path: t.path,
        description: t.description ?? "",
        ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
      }
      this.toolsByRoute.set(`${def.method} ${def.path}`, t.handler)
      return def
    })
  }

  close() {
    this._closed = true
    this._teardownHeartbeat()
    try { this.ws?.close(1000, "client closed") } catch {}
    this.ws = null
    this.registered = false
    this._emitStatus("closed")
  }

  // ── internals ───────────────────────────────────────────────────

  _send(frame) {
    if (!this.ws || this.ws.readyState !== 1) return false
    try { this.ws.send(JSON.stringify(frame)); return true } catch { return false }
  }

  _onMessage(data) {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    this._scheduleNextPing()
    switch (msg.type) {
      case "tool_call": void this._handleToolCall(msg); return
      case "ping": this._send({ type: "pong", id: msg.id }); return
      case "pong":
        if (msg.id === this._pendingPingId) {
          this._pendingPingId = null
          if (this._heartbeatDeadlineTimer) { clearTimeout(this._heartbeatDeadlineTimer); this._heartbeatDeadlineTimer = null }
        }
        return
      default: {
        if (typeof msg.id === "string") {
          const p = this.pendingFrameReplies.get(msg.id)
          if (p) { this.pendingFrameReplies.delete(msg.id); p.resolve(msg); return }
        }
      }
    }
  }

  async _handleToolCall(msg) {
    const route = `${String(msg.method).toUpperCase()} ${msg.path}`
    const handler = this.toolsByRoute.get(route)
    if (!handler) {
      this._send({
        type: "tool_reply", id: msg.id, status: 404,
        body: { error: { code: "not_found", message: `no handler for ${route}` } },
      })
      return
    }
    try {
      const result = await handler({
        method: msg.method,
        path: msg.path,
        body: msg.body ?? "",
        headers: msg.headers ?? {},
      })
      const { status, body } = normalizeResult(result)
      this._send({ type: "tool_reply", id: msg.id, status, body })
    } catch (e) {
      this._send({
        type: "tool_reply", id: msg.id, status: 500,
        body: { error: { code: "handler_error", message: e?.message ?? String(e) } },
      })
    }
  }

  _onClose(code, reason) {
    if (this._closed) return
    this.registered = false
    this._teardownHeartbeat()
    for (const p of this.pendingFrameReplies.values()) p.reject(new Error("ws closed"))
    this.pendingFrameReplies.clear()
    this.ws = null
    this._emitStatus("disconnected", { code, reason })
  }

  _waitForFrame(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (!ws) return reject(new Error("no ws"))
      const timer = setTimeout(() => {
        ws.removeEventListener("message", listener)
        reject(new Error(`waitForFrame timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const listener = (ev) => {
        let msg
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) } catch { return }
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeEventListener("message", listener)
          resolve(msg)
        }
      }
      ws.addEventListener("message", listener)
    })
  }

  _awaitReply(id, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFrameReplies.delete(id)
        reject(new Error(`awaitReply(${id}) timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingFrameReplies.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })
  }

  _scheduleNextPing() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer)
    this._heartbeatTimer = setTimeout(() => this._sendPing(), this.heartbeatIntervalMs)
  }

  _sendPing() {
    if (!this.ws || this.ws.readyState !== 1) return
    this._pendingPingId = uid()
    this._send({ type: "ping", id: this._pendingPingId })
    if (this._heartbeatDeadlineTimer) clearTimeout(this._heartbeatDeadlineTimer)
    this._heartbeatDeadlineTimer = setTimeout(() => {
      try { this.ws?.close(1011, "dead heartbeat") } catch {}
    }, this.heartbeatTimeoutMs)
  }

  _teardownHeartbeat() {
    if (this._heartbeatTimer) { clearTimeout(this._heartbeatTimer); this._heartbeatTimer = null }
    if (this._heartbeatDeadlineTimer) { clearTimeout(this._heartbeatDeadlineTimer); this._heartbeatDeadlineTimer = null }
    this._pendingPingId = null
  }

  _emitStatus(status, extra) {
    try { this.onStatusChange({ status, sessionId: this.sessionId, ...extra }) } catch {}
  }
}

function normalizeResult(result) {
  if (result && typeof result === "object" && "status" in result && typeof result.status === "number") {
    return { status: result.status, body: result.body }
  }
  return { status: 200, body: result }
}

function uid() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4)
}
