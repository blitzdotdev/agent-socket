// Session — the live SDK state, owns a WebSocket and routes frames.
//
// Public API matches design doc §4.2.

import type {
  AgentToken,
  ConnectOptions,
  ListedToken,
  Session,
  SessionChangeReason,
  Tool,
  ToolCallContext,
  ToolHandler,
  ToolResult,
} from "./types.js"
import { openWs, READY_STATE_OPEN, type MinWS } from "./transport.js"
import { exponentialBackoff } from "./backoff.js"
import { HEARTBEAT_ID, HEARTBEAT_PING } from "./heartbeat.js"

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
  /** Session the token belongs to; tokens from an ended session get re-minted. */
  sessionId: string
}

// The relay refused a resume: wrong secret, or the session already ended.
class ResumeRejected extends Error {
  constructor(readonly closeCode: number) { super("resume rejected") }
}

const RESUME_REJECTED_CLOSE = 4401
// The relay closed this socket because a resume with our secret replaced it.
const REPLACED_CLOSE = 4410
// Closing a socket whose handshake we abandoned. Not 1000, which tells the
// relay the app is done and ends the session.
const HANDSHAKE_ABORT_CLOSE = 4000

/** Open a session. Returns a Session object once register_reply { ok } is received. */
export async function connect(opts: ConnectOptions): Promise<Session> {
  const session = new SessionImpl(opts)
  const { resumed } = await session._connectAndRegister()
  // Resumed from a saved secret: adopt the session's live tokens so a later
  // fallback to a fresh session can re-mint them.
  if (resumed) await session._adoptTokens().catch(() => {})
  // A refused `resume` option shows as a new sessionId; nothing to report.
  session._freshCause = null
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
  onReconnect: ConnectOptions["onReconnect"]
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number

  ws: MinWS | null = null
  _sessionId = ""
  _resumeSecret: string | null = null
  // Tokens revoked while disconnected; the resume frame carries them.
  pendingRevokes: Set<string> = new Set()
  registered = false
  giveUpReconnect = false
  // Why the next registration will be (or was) a fresh session rather than a
  // resume. Reported via onSessionChanged once the reconnect lands.
  _freshCause: { reason: SessionChangeReason; closeCode?: number } | null = null
  // When the relay last sent us anything; measures how long we were offline.
  _lastSeenAt = 0

  attempt = 0
  pendingFrameReplies: Map<string, PendingRequest> = new Map()
  // Tokens we've minted in *this* session (for autoReconnect remint)
  myTokens: Map<string, MintedTokenInfo> = new Map()  // keyed by full token string

  // updateTools calls run one at a time, in call order.
  toolsChain: Promise<unknown> = Promise.resolve()
  // Callers waiting for the session to be (re)connected.
  connectedWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []

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
    this.onDisconnect = opts.onDisconnect ?? (this.autoReconnect ? exponentialBackoff() : ({ giveUp }) => giveUp())
    this.onSessionChanged = opts.onSessionChanged
    this.onReconnect = opts.onReconnect
    if (opts.resume) {
      this._sessionId = opts.resume.sessionId
      this._resumeSecret = opts.resume.secret
    }
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  }

  get sessionId(): string { return this._sessionId }
  get resumeSecret(): string | null { return this._resumeSecret }
  get connected(): boolean { return this.registered && this.ws !== null && this.ws.readyState === READY_STATE_OPEN }

  // Resume the current session if we hold its secret; if the relay refuses
  // (4401: bad secret or session ended), fall back to a fresh one at once.
  // Other failures (network, timeout) throw so the caller backs off and the
  // next attempt tries the resume again.
  async _connectAndRegister(): Promise<{ resumed: boolean }> {
    if (this._resumeSecret && this._sessionId) {
      try {
        await this._handshake(true)
        return { resumed: true }
      } catch (e) {
        if (!(e instanceof ResumeRejected)) throw e
        this._resumeSecret = null
        this.pendingRevokes.clear()  // those tokens died with the session
        this._freshCause = { reason: "resume_refused", closeCode: e.closeCode }
      }
    } else if (this._sessionId && !this._freshCause) {
      this._freshCause = { reason: "no_resume_secret" }
    }
    await this._handshake(false)
    return { resumed: false }
  }

  async _handshake(resume: boolean): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/v1/_ws"
      + (resume ? `?session=${encodeURIComponent(this._sessionId)}` : "")
    const ws = openWs(wsUrl)
    this.ws = ws
    try {
      await this._waitOpen(ws)
      // Always the current tool set: after updateTools, a resume or a fresh
      // session registers the updated tools, not the ones passed to connect().
      const registration = {
        appId: this.appId,
        agentsMd: this.agentsMd,
        appDescription: this.appDescription,
        tools: wireTools(this.toolDefs),
      }
      // The secret goes in the first frame, not the URL, so it stays out of logs.
      this._sendFrame(resume
        ? { type: "resume", sessionId: this._sessionId, secret: this._resumeSecret, ...registration, revokeTokens: [...this.pendingRevokes] }
        : { type: "register", ...registration })
      const reply = await this._waitForRegisterReply(ws, 10_000)
      if (!reply.ok) {
        if (resume && reply.error?.code === "resume_failed") throw new ResumeRejected(RESUME_REJECTED_CLOSE)
        throw new Error(`register failed: ${reply.error?.code ?? "unknown"}`)
      }
      if (this.giveUpReconnect) throw new Error("session closed")
      this._sessionId = reply.sessionId as string
      this._resumeSecret = typeof reply.resumeSecret === "string" ? reply.resumeSecret : null
      if (resume) this.pendingRevokes.clear()
    } catch (e) {
      if (resume && (e as { closeCode?: number }).closeCode === RESUME_REJECTED_CLOSE) e = new ResumeRejected(RESUME_REJECTED_CLOSE)
      // Handlers aren't installed yet, so this close can't trigger a reconnect.
      try { ws.close(this.giveUpReconnect ? 1000 : HANDSHAKE_ABORT_CLOSE, "handshake failed") } catch {}
      if (this.ws === ws) this.ws = null
      throw e
    }
    this._installHandlers(ws)
    this._lastSeenAt = Date.now()
    this.registered = true
    this._scheduleNextPing()
    this._settleConnectedWaiters(null)
  }

  // Track the live session's tokens as ours (after resuming from a saved secret).
  async _adoptTokens(): Promise<void> {
    for (const t of await this.listAgentTokens()) {
      if (!this.myTokens.has(t.token)) {
        this.myTokens.set(t.token, { token: t.token, url: t.url, label: t.label, mintedAt: t.mintedAt, sessionId: this._sessionId })
      }
    }
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
      sessionId: this._sessionId,
    }
    this.myTokens.set(token, info)
    return { token, url, label: info.label, expiresAt: (reply.expiresAt as number | null) ?? null }
  }

  async revokeAgentToken(token: string): Promise<{ ok: boolean }> {
    // Forget it first so a reconnect can't re-mint it. While disconnected the
    // relay may be holding the session for a resume, so the resume frame
    // revokes it before the app goes live again.
    const known = this.myTokens.delete(token)
    if (!this.connected) {
      if (this._resumeSecret) this.pendingRevokes.add(token)
      return { ok: known }
    }
    const id = this._uid()
    this._sendFrame({ type: "revoke_agent_token", id, token })
    const reply = await this._awaitReply(id, 10_000)
    return { ok: !!reply.ok || known }
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

  updateTools(tools: Tool[], agentsMd?: string): Promise<void> {
    const run = () => this._updateTools(tools, agentsMd)
    const p = this.toolsChain.then(run, run)
    this.toolsChain = p.catch(() => {})
    return p
  }

  async _updateTools(tools: Tool[], agentsMd: string | undefined): Promise<void> {
    if (!Array.isArray(tools)) throw new TypeError("updateTools: tools must be an array")
    if (agentsMd !== undefined && typeof agentsMd !== "string") throw new TypeError("updateTools: agentsMd must be a string")
    const defs = tools.map((t) => ({ ...t, method: (t.method ?? "POST").toUpperCase() }))
    for (const t of defs) {
      if (typeof t.handler !== "function") throw new TypeError(`updateTools: ${t.method} ${t.path} has no handler`)
    }
    for (;;) {
      if (this.giveUpReconnect) throw new Error("updateTools: session closed")
      // Disconnected: wait for the reconnect (whose resume re-sends the
      // current tools), then send the update on the new socket.
      if (!this.connected) { await this._waitConnected(); continue }
      const ws = this.ws
      // Serve old and new handlers until the relay confirms, so a call routed
      // just after the relay switched still finds its handler.
      const prev = this.toolsByRoute
      const during = new Map(prev)
      for (const t of defs) during.set(`${t.method} ${t.path}`, t.handler)
      this.toolsByRoute = during
      const id = this._uid()
      this._sendFrame({ type: "update_tools", id, tools: wireTools(defs), ...(agentsMd !== undefined ? { agentsMd } : {}) })
      let reply: any
      try {
        reply = await this._awaitReply(id, 10_000)
      } catch (e) {
        if (this.toolsByRoute === during) this.toolsByRoute = prev
        // The socket dropped before the reply. The relay may or may not have
        // applied it, but the resume replaces its tools with ours (the old
        // set), so just send the update again once reconnected.
        if (this.ws !== ws || !this.connected) continue
        throw e
      }
      if (!reply.ok) {
        if (this.toolsByRoute === during) this.toolsByRoute = prev
        const code = reply.error?.code ?? "unknown"
        throw Object.assign(new Error(`update_tools failed: ${code}${reply.error?.message ? ` (${reply.error.message})` : ""}`), { code })
      }
      this.toolDefs = defs
      this.toolsByRoute = new Map(defs.map((t) => [`${t.method} ${t.path}`, t.handler]))
      if (agentsMd !== undefined) this.agentsMd = agentsMd
      return
    }
  }

  _waitConnected(): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => this.connectedWaiters.push({ resolve, reject }))
  }

  _settleConnectedWaiters(err: Error | null): void {
    const waiters = this.connectedWaiters
    this.connectedWaiters = []
    for (const w of waiters) err ? w.reject(err) : w.resolve()
  }

  completeTask(taskId: string, result?: { status?: number; body?: unknown; headers?: Record<string, string> }): void {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("completeTask: taskId must be a non-empty string")
    }
    if (!this.connected) {
      throw new Error("completeTask: WS not open")
    }
    const status = result?.status ?? 200
    const frame: Record<string, unknown> = { type: "task_complete", taskId, status, body: result?.body }
    if (result?.headers && typeof result.headers === "object") {
      frame.headers = result.headers
    }
    this._sendFrame(frame)
  }

  ping(): void {
    if (!this.connected) return
    if (this.pendingPingId !== null) return
    this._sendPing()
  }

  close(): void {
    // Not connected (offline, or mid-reconnect): the relay may be holding the
    // session for a resume, so its links still answer. Ask it to end now.
    const endHeld = !this.giveUpReconnect && !this.connected && !!this._resumeSecret && !!this._sessionId
    this.giveUpReconnect = true
    this.registered = false
    this._teardownHeartbeat()
    this._failPending()
    this._settleConnectedWaiters(new Error("session closed"))
    try { this.ws?.close(1000, "client closed") } catch {}
    this.ws = null
    if (endHeld) this._endHeldSession()
    this._resumeSecret = null
    this.pendingRevokes.clear()
  }

  // Best effort: prove the secret on a resume socket with an `end` frame; the
  // relay wipes the session. If the relay can't be reached, the session ends
  // when the relay's hold runs out.
  _endHeldSession(): void {
    const sessionId = this._sessionId
    const secret = this._resumeSecret
    let ws: MinWS
    try {
      ws = openWs(this.baseUrl.replace(/^http/, "ws") + `/v1/_ws?session=${encodeURIComponent(sessionId)}`)
    } catch { return }
    const done = (): void => {
      clearTimeout(timer)
      try { ws.close(1000, "session ended") } catch {}
    }
    const timer = setTimeout(done, 10_000)
    ;(timer as { unref?: () => void }).unref?.()
    ws.addListener("open", () => { try { ws.send(JSON.stringify({ type: "end", sessionId, secret })) } catch { done() } })
    ws.addListener("message", () => done())
    ws.addListener("close", () => clearTimeout(timer))
    ws.addListener("error", () => {})
  }

  // ── Internals ───────────────────────────────────────────────────────

  _uid(): string { return Math.random().toString(36).slice(2, 12) }

  _waitOpen(ws: MinWS): Promise<void> {
    if (ws.readyState === READY_STATE_OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (e: unknown) => { cleanup(); reject(e instanceof Error ? e : new Error("ws failed to open")) }
      const onClose = () => onError(null)
      const cleanup = () => {
        ws.removeListener("open", onOpen as any)
        ws.removeListener("error", onError as any)
        ws.removeListener("close", onClose)
      }
      ws.addListener("open", onOpen as any)
      ws.addListener("error", onError as any)
      ws.addListener("close", onClose)
    })
  }

  _installHandlers(ws: MinWS): void {
    ws.addListener("message", (data: any) => { if (ws === this.ws) this._onMessage(String(data)) })
    ws.addListener("close", (...args: any[]) => {
      if (ws === this.ws) this._onClose(args[0] as number ?? 1006, args[1] as string ?? "")
    })
    ws.addListener("error", (_e: any) => { /* errors typically followed by close */ })
  }

  _onMessage(data: string): void {
    let msg: any
    try { msg = JSON.parse(data) } catch { return }
    this._lastSeenAt = Date.now()
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
    // Validate the frame BEFORE building the route. A malformed tool_call
    // (missing/non-string method or path) used to throw here on
    // `.toUpperCase()` — outside the try below — producing an unhandled
    // rejection (the call site is `void this._handleToolCall(msg)`) AND no
    // tool_reply, so the agent's HTTP request hung until the relay's
    // tool_timeout. Reply with an error instead so the agent gets a prompt
    // response for any frame carrying an id.
    if (typeof msg.method !== "string" || typeof msg.path !== "string") {
      if (typeof msg.id === "string") {
        this._sendFrame({
          type: "tool_reply",
          id: msg.id,
          status: 400,
          body: { error: { code: "bad_tool_call", message: "tool_call requires string method and path" } },
        })
      }
      return
    }
    const route = `${msg.method.toUpperCase()} ${msg.path}`
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
      const { status, body, taskId, headers } = normalizeResult(result)
      const frame: Record<string, unknown> = { type: "tool_reply", id: msg.id, status, body }
      if (status === 202 && typeof taskId === "string" && taskId.length > 0) {
        frame.taskId = taskId
      }
      if (headers && typeof headers === "object") {
        frame.headers = headers
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

  _onClose(code: number, reason: string): void {
    this.registered = false
    this._teardownHeartbeat()
    this._failPending()
    this.ws = null
    // Another connection resumed this session with our secret, so it's theirs
    // now. Start a fresh session on reconnect rather than taking it back.
    if (code === REPLACED_CLOSE) {
      this._resumeSecret = null
      this.pendingRevokes.clear()
      this._freshCause = { reason: "replaced", closeCode: REPLACED_CLOSE }
    }
    this._disconnected(reason || "ws closed", code)
  }

  // The single reconnect path: after a drop and after each failed attempt.
  _disconnected(reason: string, code?: number): void {
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
      this._settleConnectedWaiters(new Error("session closed"))
    }
    void this.onDisconnect({ reason, ...(code !== undefined ? { code } : {}), attempt: this.attempt, reconnect, giveUp })
  }

  async _reconnectAndRemint(): Promise<void> {
    const priorSessionId = this._sessionId
    const lastSeenAt = this._lastSeenAt  // a successful handshake resets it
    let resumed: boolean
    try {
      ({ resumed } = await this._connectAndRegister())
    } catch (e) {
      const code = (e as { closeCode?: unknown } | null)?.closeCode
      this._disconnected(e instanceof Error ? e.message : "reconnect failed", typeof code === "number" ? code : undefined)
      return
    }
    this.attempt = 0
    const offlineMs = Math.max(0, Date.now() - lastSeenAt)
    const cause = this._freshCause
    this._freshCause = null

    // A resume keeps every token. A fresh session doesn't: re-mint the ones
    // still in myTokens (revoke removes them) under the new session-id. A
    // resume can still find stale ones when an earlier re-mint was cut short.
    const tokensRemapped = new Map<string, string>()
    if (!resumed && !this.autoReconnect) this.myTokens.clear()
    for (const old of Array.from(this.myTokens.values())) {
      if (old.sessionId === this._sessionId || !this.myTokens.has(old.token)) continue
      let fresh: AgentToken
      try {
        fresh = await this.mintAgentToken({ label: old.label })
      } catch {
        if (!this.connected) break  // dropped again; the next reconnect retries the rest
        this.myTokens.delete(old.token)
        continue
      }
      if (!this.myTokens.delete(old.token)) {
        void this.revokeAgentToken(fresh.token).catch(() => {})  // revoked while re-minting
        continue
      }
      tokensRemapped.set(old.url, fresh.url)
    }

    if ((priorSessionId !== this._sessionId || tokensRemapped.size > 0) && this.onSessionChanged) {
      const sessionChanged = priorSessionId !== this._sessionId
      void this.onSessionChanged({
        priorSessionId,
        sessionId: this._sessionId,
        tokensRemapped,
        reason: sessionChanged ? cause?.reason ?? "resume_refused" : "remint",
        ...(sessionChanged && cause?.closeCode !== undefined ? { closeCode: cause.closeCode } : {}),
        offlineMs,
      })
    }
    if (this.onReconnect) void this.onReconnect({ sessionId: this._sessionId, resumed })
  }

  _failPending(): void {
    for (const p of this.pendingFrameReplies.values()) p.reject(new Error("ws closed"))
    this.pendingFrameReplies.clear()
  }

  _sendFrame(frame: unknown): void {
    if (!this.ws) return
    try { this.ws.send(JSON.stringify(frame)) } catch {}
  }

  _waitForRegisterReply(ws: MinWS, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const done = (err: Error | null, msg?: unknown) => {
        clearTimeout(timer)
        ws.removeListener("message", onMessage)
        ws.removeListener("close", onClose)
        err ? reject(err) : resolve(msg)
      }
      const onMessage = (data: unknown) => {
        let msg: any
        try { msg = JSON.parse(String(data)) } catch { return }
        if (msg.type === "register_reply") done(null, msg)
      }
      const onClose = (...args: unknown[]) => {
        const closeCode = (args[0] as number | undefined) ?? 1006
        done(Object.assign(new Error(`ws closed before register_reply (${closeCode})`), { closeCode }))
      }
      const timer = setTimeout(() => done(new Error(`register_reply timeout after ${timeoutMs}ms`)), timeoutMs)
      ws.addListener("message", onMessage)
      ws.addListener("close", onClose)
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
    // A fixed frame, so the relay's runtime can answer it without waking a
    // hibernated session (see heartbeat.ts).
    this.pendingPingId = HEARTBEAT_ID
    try { this.ws.send(HEARTBEAT_PING) } catch {}
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

function wireTools(defs: Tool[]): Array<Omit<Tool, "handler">> {
  return defs.map((t) => ({
    method: t.method,
    path: t.path,
    description: t.description,
    ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
  }))
}

function normalizeResult(result: ToolResult): { status: number; body: unknown; taskId?: string; headers?: Record<string, string> } {
  if (result && typeof result === "object" && "status" in (result as any) && typeof (result as any).status === "number") {
    const r = result as { status: number; body?: unknown; taskId?: string; headers?: Record<string, string> }
    return { status: r.status, body: r.body, taskId: r.taskId, headers: r.headers }
  }
  return { status: 200, body: result }
}
