// Session — the live SDK state, owns a WebSocket and routes frames.
//
// Public API matches design doc §4.2.

import type {
  AgentToken,
  ConnectOptions,
  ListedToken,
  Session,
  Tool,
  ToolCallContext,
  ToolHandler,
  ToolResult,
} from "./types.js"
import { openWs, READY_STATE_OPEN, type MinWS } from "./transport.js"
import { exponentialBackoff } from "./backoff.js"

const DEFAULT_BASE_URL = "https://agentsocket.dev"
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 50_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

interface MintedTokenInfo {
  token: string
  url: string
  label: string
  mintedAt: number
}

/** Open a session. Returns a Session object once register_reply { ok } is received. */
export async function connect(opts: ConnectOptions): Promise<Session> {
  const session = new SessionImpl(opts)
  await session._connectAndRegister()
  return session
}

class SessionImpl implements Session {
  baseUrl: string
  appId: string
  agentsMd: string
  appDescription: string
  // Tools by `${METHOD} ${path}` for fast dispatch
  toolsByRoute: Map<string, ToolHandler> = new Map()
  toolDefs: Tool[]
  autoReconnect: boolean
  onDisconnect: NonNullable<ConnectOptions["onDisconnect"]>
  onSessionChanged: ConnectOptions["onSessionChanged"]
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number

  ws: MinWS | null = null
  _sessionId = ""
  registered = false
  giveUpReconnect = false

  attempt = 0
  pendingFrameReplies: Map<string, PendingRequest> = new Map()
  // Tokens we've minted in *this* session (for autoReconnect remint)
  myTokens: Map<string, MintedTokenInfo> = new Map()  // keyed by full token string

  // Heartbeat state
  heartbeatPingTimer: ReturnType<typeof setTimeout> | null = null
  heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  pendingPingId: string | null = null

  constructor(opts: ConnectOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.appId = opts.appId
    this.agentsMd = opts.agentsMd
    this.appDescription = opts.appDescription ?? ""
    this.toolDefs = opts.tools.map((t) => ({
      ...t,
      method: (t.method ?? "POST").toUpperCase(),
    }))
    for (const t of this.toolDefs) {
      this.toolsByRoute.set(`${t.method} ${t.path}`, t.handler)
    }
    this.autoReconnect = opts.autoReconnect ?? true
    this.onDisconnect = opts.onDisconnect ?? exponentialBackoff()
    this.onSessionChanged = opts.onSessionChanged
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  }

  get sessionId(): string { return this._sessionId }
  get connected(): boolean { return this.ws !== null && this.ws.readyState === READY_STATE_OPEN }

  async _connectAndRegister(): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/v1/_ws"
    this.ws = await openWs(wsUrl)
    await this._waitOpen(this.ws)
    this._installHandlers(this.ws)

    // Send register
    const tools = this.toolDefs.map((t) => ({
      method: t.method,
      path: t.path,
      description: t.description,
      ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
    }))
    this._sendFrame({
      type: "register",
      appId: this.appId,
      agentsMd: this.agentsMd,
      appDescription: this.appDescription,
      tools,
    })

    // Wait for register_reply
    const reply = await this._waitForFrame((m) => m.type === "register_reply", 10_000)
    if (!reply.ok) {
      const code = reply.error?.code ?? "unknown"
      throw new Error(`register failed: ${code}`)
    }
    this._sessionId = reply.sessionId as string
    this.registered = true
    this._scheduleNextPing()
  }

  // ── Public methods ──────────────────────────────────────────────────

  async mintAgentToken(opts: { label: string }): Promise<AgentToken> {
    const id = this._uid()
    this._sendFrame({ type: "mint_agent_token", id, label: opts.label })
    const reply = await this._awaitReply(id, 10_000)
    if (!reply.ok) {
      const code = (reply.error as any)?.code ?? "unknown"
      throw new Error(`mint failed: ${code}`)
    }
    const token = reply.token as string
    const url = this._rewriteUrl(reply.url as string)
    const info: MintedTokenInfo = {
      token,
      url,
      label: (reply.label as string) ?? opts.label,
      mintedAt: Date.now(),
    }
    this.myTokens.set(token, info)
    return { token, url, label: info.label, expiresAt: (reply.expiresAt as number | null) ?? null }
  }

  async revokeAgentToken(token: string): Promise<{ ok: boolean }> {
    const id = this._uid()
    this._sendFrame({ type: "revoke_agent_token", id, token })
    const reply = await this._awaitReply(id, 10_000)
    this.myTokens.delete(token)
    return { ok: !!reply.ok }
  }

  async listAgentTokens(): Promise<ListedToken[]> {
    const id = this._uid()
    this._sendFrame({ type: "list_agent_tokens", id })
    const reply = await this._awaitReply(id, 10_000)
    const tokens = (reply.tokens as Array<Record<string, unknown>>) ?? []
    return tokens.map((t) => ({
      token: t.token as string,
      url: this._rewriteUrl(t.url as string),
      label: (t.label as string) ?? "",
      expiresAt: null,
      mintedAt: (t.mintedAt as number) ?? 0,
    }))
  }

  completeTask(taskId: string, result?: { status?: number; body?: unknown }): void {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("completeTask: taskId must be a non-empty string")
    }
    if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) {
      throw new Error("completeTask: WS not open")
    }
    const status = result?.status ?? 200
    this._sendFrame({ type: "task_complete", taskId, status, body: result?.body })
  }

  ping(): void {
    if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) return
    if (this.pendingPingId !== null) return
    this._sendPing()
  }

  close(): void {
    this.giveUpReconnect = true
    this._teardownHeartbeat()
    this.ws?.close(1000, "client closed")
    this.ws = null
  }

  // ── Internals ───────────────────────────────────────────────────────

  _uid(): string { return Math.random().toString(36).slice(2, 12) }

  _waitOpen(ws: MinWS): Promise<void> {
    if (ws.readyState === READY_STATE_OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (e: unknown) => { cleanup(); reject(e instanceof Error ? e : new Error(String(e))) }
      const cleanup = () => {
        ws.removeListener("open", onOpen as any)
        ws.removeListener("error", onError as any)
      }
      ws.addListener("open", onOpen as any)
      ws.addListener("error", onError as any)
    })
  }

  _installHandlers(ws: MinWS): void {
    ws.addListener("message", (data: any) => this._onMessage(String(data)))
    ws.addListener("close", (...args: any[]) => this._onClose(args[0] as number ?? 1006, args[1] as string ?? ""))
    ws.addListener("error", (_e: any) => { /* errors typically followed by close */ })
  }

  _onMessage(data: string): void {
    let msg: any
    try { msg = JSON.parse(data) } catch { return }
    this._scheduleNextPing()  // any inbound traffic resets the idle timer

    switch (msg.type) {
      case "tool_call":
        void this._handleToolCall(msg)
        return
      case "ping":
        this._sendFrame({ type: "pong", id: msg.id })
        return
      case "pong":
        if (msg.id === this.pendingPingId) {
          this.pendingPingId = null
          if (this.heartbeatTimeoutTimer) { clearTimeout(this.heartbeatTimeoutTimer); this.heartbeatTimeoutTimer = null }
        }
        return
      default: {
        if (typeof msg.id === "string") {
          const p = this.pendingFrameReplies.get(msg.id)
          if (p) {
            this.pendingFrameReplies.delete(msg.id)
            p.resolve(msg)
            return
          }
        }
        // unmatched — ignore
      }
    }
  }

  async _handleToolCall(msg: any): Promise<void> {
    const route = `${(msg.method as string).toUpperCase()} ${msg.path as string}`
    const handler = this.toolsByRoute.get(route)
    if (!handler) {
      this._sendFrame({
        type: "tool_reply",
        id: msg.id,
        status: 404,
        body: { error: { code: "not_found", message: `no handler for ${route}` } },
      })
      return
    }
    const ctx: ToolCallContext = {
      method: msg.method as string,
      path: msg.path as string,
      body: (msg.body as string) ?? "",
      headers: (msg.headers as Record<string, string>) ?? {},
    }
    try {
      const result = await handler(ctx)
      const { status, body, taskId } = normalizeResult(result)
      const frame: Record<string, unknown> = { type: "tool_reply", id: msg.id, status, body }
      if (status === 202 && typeof taskId === "string" && taskId.length > 0) {
        frame.taskId = taskId
      }
      this._sendFrame(frame)
    } catch (e: unknown) {
      // Prefer a duck-typed `.message` over String(e) — handlers that throw
      // plain objects like `{message, code}` (idiomatic in older JS without
      // Error subclasses) otherwise stringify to "[object Object]".
      const eMaybe = e as { message?: unknown } | null | undefined
      const message = typeof eMaybe?.message === "string"
        ? eMaybe.message
        : (e instanceof Error ? e.message : String(e))
      this._sendFrame({
        type: "tool_reply",
        id: msg.id,
        status: 500,
        body: { error: { code: "handler_error", message } },
      })
    }
  }

  _onClose(_code: number, reason: string): void {
    this.registered = false
    this._teardownHeartbeat()
    // Fail any in-flight frame-reply waiters
    for (const p of this.pendingFrameReplies.values()) p.reject(new Error("ws closed"))
    this.pendingFrameReplies.clear()
    this.ws = null

    if (this.giveUpReconnect) return

    this.attempt += 1
    let resolved = false
    const reconnect = (): void => {
      if (resolved) return
      resolved = true
      // Re-check giveUpReconnect at fire-time. A consumer's onDisconnect can
      // schedule reconnect() via setTimeout (e.g. exponentialBackoff). If the
      // app calls session.close() during that delay, the timer still fires —
      // without this check it would open a brand-new WS on a closed session.
      if (this.giveUpReconnect) return
      void this._reconnectAndRemint()
    }
    const giveUp = (): void => {
      if (resolved) return
      resolved = true
      this.giveUpReconnect = true
    }
    void this.onDisconnect({
      reason: reason || "ws closed",
      attempt: this.attempt,
      reconnect,
      giveUp,
    })
  }

  async _reconnectAndRemint(): Promise<void> {
    if (this.giveUpReconnect) return  // close() raced with backoff timer
    const priorSessionId = this._sessionId
    const priorTokens = Array.from(this.myTokens.values())
    this.myTokens.clear()

    try {
      await this._connectAndRegister()
      this.attempt = 0  // success: reset
    } catch (e) {
      // Reconnect failed — schedule the next attempt by re-firing onDisconnect
      this.attempt += 1
      let resolved = false
      const reconnect = () => { if (!resolved) { resolved = true; void this._reconnectAndRemint() } }
      const giveUp = () => { if (!resolved) { resolved = true; this.giveUpReconnect = true } }
      void this.onDisconnect({
        reason: e instanceof Error ? e.message : "reconnect failed",
        attempt: this.attempt,
        reconnect,
        giveUp,
      })
      return
    }

    const tokensRemapped = new Map<string, string>()
    if (this.autoReconnect && priorTokens.length > 0) {
      // Re-mint all previously-active tokens under the new session-id.
      for (const old of priorTokens) {
        try {
          const fresh = await this.mintAgentToken({ label: old.label })
          tokensRemapped.set(old.url, fresh.url)
        } catch {
          // Skip — tokens that failed remint stay dead.
        }
      }
    }

    if (priorSessionId !== this._sessionId && this.onSessionChanged) {
      void this.onSessionChanged({
        priorSessionId,
        sessionId: this._sessionId,
        tokensRemapped,
      })
    }
  }

  _sendFrame(frame: unknown): void {
    if (!this.ws) return
    try { this.ws.send(JSON.stringify(frame)) } catch {}
  }

  _waitForFrame(predicate: (m: any) => boolean, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws?.removeListener("message", listener as any)
        reject(new Error(`waitForFrame timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const listener = (data: any) => {
        let msg: any
        try { msg = JSON.parse(String(data)) } catch { return }
        if (predicate(msg)) {
          clearTimeout(timer)
          this.ws?.removeListener("message", listener as any)
          resolve(msg)
        }
      }
      this.ws?.addListener("message", listener as any)
    })
  }

  _awaitReply(id: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFrameReplies.delete(id)
        reject(new Error(`awaitReply(${id}) timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingFrameReplies.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
        reject: (e: Error) => { clearTimeout(timer); reject(e) },
      })
    })
  }

  _rewriteUrl(url: string): string {
    return url.replace(/^__BASE__/, this.baseUrl)
  }

  _scheduleNextPing(): void {
    if (this.heartbeatPingTimer) clearTimeout(this.heartbeatPingTimer)
    this.heartbeatPingTimer = setTimeout(() => this._sendPing(), this.heartbeatIntervalMs)
  }

  _sendPing(): void {
    if (!this.ws || this.ws.readyState !== READY_STATE_OPEN) return
    this.pendingPingId = this._uid()
    this._sendFrame({ type: "ping", id: this.pendingPingId })
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer)
    this.heartbeatTimeoutTimer = setTimeout(() => {
      // No pong in window — close as dead.
      try { this.ws?.close(1011, "dead heartbeat") } catch {}
    }, this.heartbeatTimeoutMs)
  }

  _teardownHeartbeat(): void {
    if (this.heartbeatPingTimer) { clearTimeout(this.heartbeatPingTimer); this.heartbeatPingTimer = null }
    if (this.heartbeatTimeoutTimer) { clearTimeout(this.heartbeatTimeoutTimer); this.heartbeatTimeoutTimer = null }
    this.pendingPingId = null
  }
}

function normalizeResult(result: ToolResult): { status: number; body: unknown; taskId?: string } {
  if (result && typeof result === "object" && "status" in (result as any) && typeof (result as any).status === "number") {
    const r = result as { status: number; body?: unknown; taskId?: string }
    return { status: r.status, body: r.body, taskId: r.taskId }
  }
  return { status: 200, body: result }
}
