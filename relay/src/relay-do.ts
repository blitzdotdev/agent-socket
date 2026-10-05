// RelayServer — one Durable Object instance per session.
//
// Holds:
//   - the app's WebSocket connection
//   - the registered app-id (a label), agentsMd, tools list
//   - the set of valid agent-tokens (verifiers) minted in this session
//   - the pending-request correlation map for in-flight tool calls
//
// Lifecycle: a fresh `register` starts the session and returns a resume
// secret. When the app socket drops (anything but a clean 1000 close) the
// registration, tokens and async tasks are held for RESUME_GRACE_MS so the app
// can reattach with `/v1/_ws?session=<id>` + a `resume` frame carrying the
// secret. In-flight tool calls still fail at the drop. A clean close, a
// protocol violation, or the grace window running out ends the session and
// wipes everything. Memory only: if CF evicts the DO, resume fails and the app
// starts a fresh session.

import { Server, type Connection } from "partyserver"
import type {
  Env,
  Frame,
  RegisterFrame,
  ResumeFrame,
  ToolDef,
  ToolReplyFrame,
  MintAgentTokenReplyFrame,
  RevokeAgentTokenReplyFrame,
  ListAgentTokensReplyFrame,
  UpdateToolsFrame,
  UpdateToolsReplyFrame,
} from "./types"
import { generateResumeSecret, generateVerifier, makeAgentToken, parseAgentToken, resumeSecretMatches } from "./tokens"
import { errorResponse } from "./errors"
// Source of truth for the framework's "how to call tools" reference card
// lives in the SDK so the constant doesn't drift between served bytes and
// the doc the SDK template emits.
import { FRAMEWORK_PREAMBLE, hasFrameworkContract } from "../../sdk/src/preamble"

const RESERVED_PATHS = new Set(["/agents.md", "/tools.json"])
const RESERVED_PREFIX = "_as_"
const MAX_INFLIGHT = 100
const MAX_TOKENS_PER_SESSION = 50
const MAX_AGENTS_MD_BYTES = 64 * 1024
// Async-task caps. Without these a misbehaving (or hostile) app can flood
// `task_complete` frames with arbitrary IDs and bodies and grow the DO's
// in-memory `tasks` Map until workerd OOM-kills the isolate.
const MAX_TASKS_PER_SESSION = 100
const MAX_TASK_BODY_BYTES = 64 * 1024
const REGISTER_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const DEFAULT_RESUME_GRACE_MS = 60_000
// Sockets that arrived on /v1/_ws?session= and haven't presented the secret yet.
const MAX_RESUME_CANDIDATES = 4
// Retry-After (seconds) on a tool call that lands while the app is reconnecting.
const RECONNECTING_RETRY_AFTER_S = "2"
// Every request on a session with no app gets this, whether or not the session
// ever existed, so it tells the agent what to do without revealing which.
const APP_OFFLINE_MESSAGE =
  "The app is not connected to this link. If this keeps happening, the link is probably stale: ask the user to reconnect the app (in the Agent Socket extension: open it and copy the current link) and share the new link."

const TOOL_PATH_RE = /^\/[a-zA-Z0-9_\-/.]+$/
const APP_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/
// Task IDs are app-supplied strings used as Map keys and echoed in HTTP
// responses. Bound the shape so an app can't store control chars, oversized
// keys, or non-strings.
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// FRAMEWORK_PREAMBLE + hasFrameworkContract are imported from sdk/src/preamble.

interface PendingRequest {
  resolve: (r: Response) => void
  timer: ReturnType<typeof setTimeout>
}

interface MintedToken {
  token: string
  url: string
  label: string
  mintedAt: number
}

interface Registration {
  appId: string
  appDescription: string
  agentsMd: string
  tools: ToolDef[]
}

interface RegistrationError {
  code: string
  message?: string
  closeCode: number
  closeReason: string
}

interface PendingTask {
  status: number
  body: unknown
  completed: boolean
  /** Handler-supplied content-type for non-JSON responses (HTML, text, etc.). */
  contentType?: string
}

export class RelayServer extends Server<Env> {
  static options = { hibernate: false }

  appWs: Connection | null = null
  appId: string | null = null
  appDescription: string = ""
  agentsMd: string = ""
  tools: ToolDef[] = []
  // Map "<METHOD> <path>" → ToolDef for fast routing
  toolByRoute: Map<string, ToolDef> = new Map()
  // verifier → MintedToken
  validTokens: Map<string, MintedToken> = new Map()
  pending: Map<string, PendingRequest> = new Map()
  // For async / task polling
  tasks: Map<string, PendingTask> = new Map()
  // Fires when the app has been silent for HEARTBEAT_TIMEOUT_MS (the SDK pings
  // every 25 s), so a half-open socket doesn't keep the session "live".
  livenessTimer: ReturnType<typeof setTimeout> | null = null
  // Proves a reconnecting socket is the app that registered. Set by register,
  // kept for the session's life, never sent anywhere but that app.
  resumeSecret: string | null = null
  // Ends the session if the app doesn't resume within RESUME_GRACE_MS.
  graceTimer: ReturnType<typeof setTimeout> | null = null
  resumeCandidates: Set<Connection> = new Set()

  // ── WS lifecycle ──────────────────────────────────────────────────

  // The worker routes with idFromName(sessionId), so the DO's name is the session-id.
  private get sessionId(): string {
    return this.name
  }

  onConnect(c: Connection, ctx: { request: Request }): void {
    // The worker only forwards upgrades from /v1/_ws; re-check so no other
    // route can ever attach a socket as the app.
    const url = new URL(ctx.request.url)
    if (url.pathname !== "/v1/_ws") {
      c.close(4400, "websocket only on /v1/_ws")
      return
    }
    // /v1/_ws?session=<id> is a resume attempt. The socket gets no access until
    // its first frame proves the secret, so it can't disturb the live app.
    if (url.searchParams.has("session")) {
      if (this.resumeCandidates.size >= MAX_RESUME_CANDIDATES) {
        c.close(4409, "too many resume attempts")
        return
      }
      this.resumeCandidates.add(c)
      setTimeout(() => {
        if (this.resumeCandidates.delete(c)) {
          try { c.close(4408, "resume timeout") } catch {}
        }
      }, REGISTER_TIMEOUT_MS)
      return
    }
    // A plain upgrade may only start a session on an empty DO: not while an
    // app is attached, nor while a dropped one's registration is held.
    if (this.appWs || this.appId !== null) {
      c.close(4409, "already connected")
      return
    }
    this.appWs = c
    // Don't let a socket that never registers pin this DO.
    setTimeout(() => {
      if (this.appWs === c && this.appId === null) this.endSession(4408, "register timeout")
    }, REGISTER_TIMEOUT_MS)
    if (this.env.DEBUG === "1") console.log(`[DO] WS connected sessionId=${this.sessionId}, awaiting register`)
  }

  onClose(c: Connection, code: number): void {
    if (this.resumeCandidates.delete(c)) return
    // A rejected or replaced socket closing must not tear down the live app.
    if (c !== this.appWs) return
    // 1000 is the SDK's close(): the app is done, so don't hold the session.
    if (code === 1000) this.endSession()
    else this.detachApp()
  }

  // The app socket is gone (or being closed with `code`). In-flight calls fail;
  // the registration is held for the grace window so the app can resume.
  // Doesn't wait for onClose: a dead peer may never complete the handshake.
  private detachApp(code?: number, reason?: string): void {
    if (code !== undefined) {
      try { this.appWs?.close(code, reason) } catch {}
    }
    this.appWs = null
    clearTimeout(this.livenessTimer)
    this.failPending("App's WebSocket dropped")
    const graceMs = parseInt(this.env.RESUME_GRACE_MS || String(DEFAULT_RESUME_GRACE_MS), 10)
    if (this.appId === null || !(graceMs > 0)) {
      this.endSession()
      return
    }
    clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      if (!this.appWs) this.endSession()
    }, graceMs)
    if (this.env.DEBUG === "1") console.log(`[DO] app detached sessionId=${this.sessionId}; holding ${graceMs} ms for resume`)
  }

  // End the session: close the app socket (if asked), fail in-flight calls,
  // and wipe everything, so a later socket on this DO starts from scratch.
  private endSession(code?: number, reason?: string): void {
    if (code !== undefined) {
      try { this.appWs?.close(code, reason) } catch {}
    }
    this.appWs = null
    clearTimeout(this.livenessTimer)
    clearTimeout(this.graceTimer)
    this.graceTimer = null
    this.failPending("App's WebSocket dropped")
    // The app's async tasks can never be completed or polled meaningfully
    // again, so free them rather than pinning up to
    // MAX_TASKS_PER_SESSION × MAX_TASK_BODY_BYTES until CF evicts the DO.
    this.tasks.clear()
    this.appId = null
    this.appDescription = ""
    this.agentsMd = ""
    this.tools = []
    this.toolByRoute.clear()
    this.validTokens.clear()
    this.resumeSecret = null
    if (this.env.DEBUG === "1") console.log(`[DO] session ended sessionId=${this.sessionId}`)
  }

  private failPending(message: string): void {
    if (this.env.DEBUG === "1" && this.pending.size) console.log("[DO] failing", this.pending.size, "pending")
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve(errorResponse("app_offline", message, 503))
    }
    this.pending.clear()
  }

  private armLiveness(): void {
    clearTimeout(this.livenessTimer)
    this.livenessTimer = setTimeout(
      () => this.detachApp(4408, "heartbeat timeout"),
      parseInt(this.env.HEARTBEAT_TIMEOUT_MS || "50000", 10),
    )
  }

  onError(_c: Connection, error: unknown): void {
    if (this.env.DEBUG === "1") console.log("[DO] WS error:", error)
  }

  // ── Frame dispatch ────────────────────────────────────────────────

  onMessage(c: Connection, raw: string | ArrayBuffer): void {
    const candidate = c !== this.appWs && this.resumeCandidates.has(c)
    if (c !== this.appWs && !candidate) return
    // workerd's own limit is 32 MiB; parsing frames that big risks OOM for
    // every session sharing this isolate.
    if ((typeof raw === "string" ? raw.length : raw.byteLength) > MAX_FRAME_BYTES) {
      if (candidate) {
        this.resumeCandidates.delete(c)
        try { c.close(1009, "frame too large") } catch {}
      } else {
        this.endSession(1009, "frame too large")
      }
      return
    }
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    let msg: Frame
    try { msg = JSON.parse(text) as Frame } catch {
      if (this.env.DEBUG === "1") console.log("[DO] dropped non-JSON frame")
      return
    }
    if (!msg || typeof msg !== "object") return

    // A resume socket's only allowed frame is `resume`; anything else is
    // dropped (the resume timeout bounds how long it can sit there).
    if (candidate) {
      if (msg && msg.type === "resume") this.handleResume(c, msg)
      return
    }

    this.armLiveness()

    // Pre-register gate: only `register`, `ping`, `pong` allowed before app
    // is fully registered. Everything else returns a protocol_error reply
    // (or is dropped silently for tool_reply / task_complete since those
    // don't have a request id we can echo).
    const registered = this.appId !== null
    if (msg.type === "resume") {
      this.send({ type: "register_reply", ok: false, error: { code: "protocol_error", message: registered ? "already registered" : "resume needs /v1/_ws?session=<id>" } })
      if (!registered) this.endSession(4400, "resume needs ?session=")
      return
    }
    if (!registered && msg.type !== "register" && msg.type !== "ping" && msg.type !== "pong") {
      if ("id" in msg && typeof msg.id === "string") {
        // Best-effort error reply on the matching reply type
        const replyType = msg.type === "mint_agent_token" ? "mint_agent_token_reply"
          : msg.type === "revoke_agent_token" ? "revoke_agent_token_reply"
          : msg.type === "list_agent_tokens" ? "list_agent_tokens_reply"
          : msg.type === "update_tools" ? "update_tools_reply"
          : null
        if (replyType) {
          this.send({ type: replyType, id: msg.id, ok: false, error: { code: "protocol_error", message: "register first" } } as unknown as Frame)
        }
      }
      return
    }

    switch (msg.type) {
      case "register":
        this.handleRegister(msg)
        return
      case "mint_agent_token":
        this.handleMint(msg)
        return
      case "revoke_agent_token":
        this.handleRevoke(msg)
        return
      case "list_agent_tokens":
        this.handleList(msg)
        return
      case "update_tools":
        this.handleUpdateTools(msg)
        return
      case "tool_reply":
        this.handleToolReply(msg)
        return
      case "task_complete":
        this.handleTaskComplete(msg.taskId, msg.status, msg.body, msg.headers)
        return
      case "ping":
        this.send({ type: "pong", id: msg.id })
        return
      case "pong":
        // No-op for now; we don't track outgoing ping ids in v0
        return
      default:
        // Unknown frame type — ignore in v0 (forward-compat)
        return
    }
  }

  // ── Register / Resume ─────────────────────────────────────────────

  private handleRegister(msg: RegisterFrame): void {
    // Already-registered guard. A second register can't change app-id /
    // tools mid-session (a resume can).
    if (this.appId !== null) {
      this.send({ type: "register_reply", ok: false, error: { code: "protocol_error", message: "already registered" } })
      return
    }
    const v = validateRegistration(msg)
    if (!v.ok) {
      this.send({ type: "register_reply", ok: false, error: { code: v.error.code, message: v.error.message } })
      this.endSession(v.error.closeCode, v.error.closeReason)
      return
    }
    this.applyRegistration(v.registration)
    this.resumeSecret = generateResumeSecret()
    this.send({ type: "register_reply", ok: true, sessionId: this.sessionId, resumeSecret: this.resumeSecret })
    if (this.env.DEBUG === "1") console.log(`[DO] registered appId=${this.appId} sessionId=${this.sessionId} tools=${this.tools.length}`)
  }

  // A socket from /v1/_ws?session=<id> claims the session. It must carry the
  // secret from register_reply; on success it becomes the app socket (closing
  // a still-attached old one, which is usually half-dead), the registration is
  // replaced by the frame's, and tokens + tasks carry over.
  private handleResume(c: Connection, msg: ResumeFrame): void {
    this.resumeCandidates.delete(c)
    const reject = (code: string, message: string, closeCode: number, closeReason: string) => {
      sendTo(c, { type: "register_reply", ok: false, error: { code, message } })
      try { c.close(closeCode, closeReason) } catch {}
    }
    const v = validateRegistration(msg)
    if (!v.ok) return reject(v.error.code, v.error.message ?? "", v.error.closeCode, v.error.closeReason)
    const secretOk = this.resumeSecret !== null
      && this.appId !== null
      && msg.sessionId === this.sessionId
      && resumeSecretMatches(msg.secret, this.resumeSecret)
    if (!secretOk) {
      // Same answer for a wrong secret, an expired session and an empty DO.
      return reject("resume_failed", "unknown session or bad secret", 4401, "resume rejected")
    }

    const old = this.appWs
    this.appWs = c
    clearTimeout(this.graceTimer)
    this.graceTimer = null
    if (old) {
      // Calls sent down the old socket will never be answered.
      this.failPending("App reconnected")
      try { old.close(4410, "replaced by a resumed connection") } catch {}
    }
    this.applyRegistration(v.registration)
    // Revokes the app made while it was offline, applied before it goes live.
    if (Array.isArray(msg.revokeTokens)) {
      for (const t of msg.revokeTokens.slice(0, MAX_TOKENS_PER_SESSION)) {
        const parsed = typeof t === "string" ? parseAgentToken(t) : null
        if (parsed && parsed.sessionId === this.sessionId) this.validTokens.delete(parsed.verifier)
      }
    }
    this.armLiveness()
    this.send({ type: "register_reply", ok: true, sessionId: this.sessionId, resumeSecret: this.resumeSecret!, resumed: true })
    if (this.env.DEBUG === "1") console.log(`[DO] resumed sessionId=${this.sessionId} tools=${this.tools.length} tokens=${this.validTokens.size}`)
  }

  private applyRegistration(r: Registration): void {
    this.appId = r.appId
    this.appDescription = r.appDescription
    this.agentsMd = r.agentsMd
    this.setTools(r.tools)
  }

  private setTools(tools: ToolDef[]): void {
    this.tools = tools
    this.toolByRoute.clear()
    for (const t of tools) this.toolByRoute.set(`${t.method} ${t.path}`, t)
  }

  // Replaces the tool list (and agents.md, if the frame has one) on a live
  // session, so the same agent URLs serve the new tools. Validated exactly
  // like register; unlike register, a bad frame is answered with an error and
  // changes nothing, so the session keeps working with its current tools.
  // Calls already forwarded to the app are unaffected.
  private handleUpdateTools(msg: UpdateToolsFrame): void {
    if (typeof msg.id !== "string") return
    const reply = (r: Omit<UpdateToolsReplyFrame, "type" | "id">): void => { this.send({ type: "update_tools_reply", id: msg.id, ...r }) }
    if (msg.agentsMd !== undefined) {
      const md = validateAgentsMd(msg.agentsMd)
      if (md) return reply({ ok: false, error: { code: md.code, message: md.message } })
    }
    if (!Array.isArray(msg.tools)) {
      return reply({ ok: false, error: { code: "protocol_error", message: "tools must be an array" } })
    }
    const v = validateTools(msg.tools)
    if (!v.ok) return reply({ ok: false, error: { code: v.error.code, message: v.error.message } })
    if (msg.agentsMd !== undefined) this.agentsMd = msg.agentsMd
    this.setTools(v.tools)
    reply({ ok: true })
    if (this.env.DEBUG === "1") console.log(`[DO] update_tools sessionId=${this.sessionId} tools=${this.tools.length}`)
  }

  // ── Mint / Revoke / List agent-tokens ─────────────────────────────

  private handleMint(msg: { id: string; label: string }): void {
    if (this.validTokens.size >= MAX_TOKENS_PER_SESSION) {
      this.send({ type: "mint_agent_token_reply", id: msg.id, ok: false, error: { code: "too_many_tokens" } })
      return
    }
    const verifier = generateVerifier()
    const token = makeAgentToken(this.sessionId, verifier)
    const url = `__BASE__/v1/t/${token}/agents.md`  // SDK rewrites __BASE__ to actual host
    const label = typeof msg.label === "string" ? msg.label.slice(0, 256) : ""
    const minted: MintedToken = {
      token,
      url,
      label,
      mintedAt: Date.now(),
    }
    this.validTokens.set(verifier, minted)
    const reply: MintAgentTokenReplyFrame = {
      type: "mint_agent_token_reply",
      id: msg.id,
      ok: true,
      token,
      url,
      label,
      expiresAt: null,
    }
    this.send(reply)
  }

  private handleRevoke(msg: { id: string; token: string }): void {
    const parsed = parseAgentToken(msg.token)
    let revoked = false
    if (parsed && parsed.sessionId === this.sessionId) {
      revoked = this.validTokens.delete(parsed.verifier)
    }
    const reply: RevokeAgentTokenReplyFrame = {
      type: "revoke_agent_token_reply",
      id: msg.id,
      ok: revoked,
    }
    this.send(reply)
  }

  private handleList(msg: { id: string }): void {
    const tokens = Array.from(this.validTokens.values()).map((t) => ({ ...t }))
    const reply: ListAgentTokensReplyFrame = {
      type: "list_agent_tokens_reply",
      id: msg.id,
      tokens,
    }
    this.send(reply)
  }

  // ── Tool call correlation ─────────────────────────────────────────

  private handleToolReply(msg: ToolReplyFrame): void {
    const p = this.pending.get(msg.id)
    if (!p) {
      if (this.env.DEBUG === "1") console.log("[DO] tool_reply with unknown id:", msg.id)
      return
    }
    clearTimeout(p.timer)
    this.pending.delete(msg.id)

    if (msg.status === 202 && msg.taskId) {
      // Async: app reports the call started; agent should poll /_as_tasks/<id>.
      // Validate the taskId shape and cap the per-session task count before
      // accepting — both are app-controlled inputs that otherwise grow the
      // DO's memory unboundedly.
      if (typeof msg.taskId !== "string" || !TASK_ID_RE.test(msg.taskId)) {
        p.resolve(errorResponse("protocol_error", "invalid taskId (use [A-Za-z0-9_-]{1,64})", 502))
        return
      }
      if (this.tasks.size >= MAX_TASKS_PER_SESSION) {
        p.resolve(errorResponse("too_many_tasks", `max ${MAX_TASKS_PER_SESSION} pending tasks per session`, 503))
        return
      }
      this.tasks.set(msg.taskId, { status: 0, body: undefined, completed: false })
      p.resolve(new Response(JSON.stringify({ taskId: msg.taskId }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      }))
      return
    }

    p.resolve(buildToolResponse(msg.status, msg.body, msg.headers))
  }

  private handleTaskComplete(taskId: string, status: number, body: unknown, headers?: Record<string, string>): void {
    // task_complete is fire-and-forget (no reply frame), so unhealthy frames
    // are dropped silently with a debug-log breadcrumb. The protections below
    // prevent a hostile or buggy app from preloading the tasks Map with
    // arbitrary keys, oversized bodies, or invalid status codes.
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) {
      if (this.env.DEBUG === "1") console.log("[DO] task_complete dropped: invalid taskId shape")
      return
    }
    // Only UPDATE an existing pending task — we never create entries here.
    // Combined with the cap on the 202 path, the Map size is bounded.
    if (!this.tasks.has(taskId)) {
      if (this.env.DEBUG === "1") console.log("[DO] task_complete dropped: taskId not pending:", taskId)
      return
    }
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
      if (this.env.DEBUG === "1") console.log("[DO] task_complete dropped: invalid status:", status)
      return
    }
    let serialized: string
    try {
      serialized = JSON.stringify(body ?? null)
    } catch {
      if (this.env.DEBUG === "1") console.log("[DO] task_complete dropped: body not JSON-serializable")
      return
    }
    if (serialized.length > MAX_TASK_BODY_BYTES) {
      if (this.env.DEBUG === "1") console.log(`[DO] task_complete dropped: body ${serialized.length} > ${MAX_TASK_BODY_BYTES} bytes`)
      return
    }
    const contentType = extractContentType(headers)
    this.tasks.set(taskId, { status, body, completed: true, contentType })
  }

  // ── HTTP entry ────────────────────────────────────────────────────

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const pathname = url.pathname

    // Debug-only inner path from worker.ts → force-close the WS. Token
    // validation does not apply (the path doesn't follow /v1/t/<token>/...).
    // ?end=1 also ends the session, as if the grace window had run out.
    if (this.env.DEBUG === "1" && pathname === "/_as_kill-ws") {
      if (url.searchParams.get("end") === "1") this.endSession(1011, "killed by debug endpoint")
      else if (this.appWs) this.detachApp(1011, "killed by debug endpoint")
      return new Response("ok", { status: 200 })
    }

    // Strip the routing prefix `/v1/t/<token>` to get the user-facing path.
    // Worker entry already validated the token format and routed here.
    const m = pathname.match(/^\/v1\/t\/[^/]+(\/.*)?$/)
    const userPath = m?.[1] ?? "/"

    // App-offline check FIRST — with no session registered, every request
    // returns the same code regardless of token validity. Avoids leaking
    // session-lifecycle info ("does this token exist anywhere?"). While a
    // dropped app's session is held for resume, tokens are still checked and
    // the relay-served paths keep working; tool calls get 503 below.
    if (!this.appId) {
      return errorResponse("app_offline", APP_OFFLINE_MESSAGE, 503)
    }

    // Token verifier check — re-parse and check against our validTokens set.
    const tokenMatch = pathname.match(/^\/v1\/t\/([^/]+)\//)
    if (!tokenMatch) return errorResponse("not_found", "malformed url", 404)
    const tokenStr = tokenMatch[1]!
    const parsed = parseAgentToken(tokenStr)
    if (!parsed || parsed.sessionId !== this.sessionId) {
      return errorResponse("token_invalid", "token format or session mismatch", 401)
    }
    if (!this.validTokens.has(parsed.verifier)) {
      return errorResponse("token_invalid", "agent-token unknown or revoked", 401)
    }

    // The worker already buffered (and capped) the body, so returning above
    // without reading it is safe; read it only once the token is known good.
    const body = await req.text()

    // Reserved meta paths
    if (userPath === "/agents.md") {
      const appMd = this.agentsMd || ""
      // Prepend the calling contract unless the app's own doc already ships
      // it. hasFrameworkContract checks for the explicit marker
      // (FRAMEWORK_CONTRACT_MARKER, emitted by defaultAgentsMd) first and
      // falls back to a "tools.json" substring match for legacy / hand-
      // written docs.
      const body = hasFrameworkContract(appMd) ? appMd : FRAMEWORK_PREAMBLE + appMd
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      })
    }
    if (userPath === "/tools.json") {
      const body = {
        version: "1.0",
        app: {
          id: this.appId,
          name: this.appId,
          description: this.appDescription,
        },
        tools: this.tools.map((t) => ({
          method: t.method,
          path: t.path,
          description: t.description,
          ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
        })),
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      })
    }
    if (userPath.startsWith("/_as_tasks/")) {
      const taskId = userPath.slice("/_as_tasks/".length)
      const task = this.tasks.get(taskId)
      if (!task) return errorResponse("not_found", "task unknown", 404)
      if (!task.completed) {
        return new Response(JSON.stringify({ taskId, completed: false }), {
          status: 202,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        })
      }
      // Honor the content-type the app set when it called task_complete
      // (carried through PendingTask.contentType), same as the sync path.
      const resp = buildToolResponse(
        task.status,
        task.body ?? null,
        task.contentType ? { "content-type": task.contentType } : undefined,
      )
      // Single-read consumption: free the slot once a completed task has been
      // delivered. Without this the `tasks` Map grows for the DO's lifetime
      // and, once MAX_TASKS_PER_SESSION completed tasks accumulate, the cap
      // check on the 202 path permanently bricks the session's async path.
      this.tasks.delete(taskId)
      return resp
    }
    if (userPath.startsWith("/_as_")) {
      return errorResponse("not_found", "unknown internal path", 404)
    }

    // CSRF defense on the user-tool surface. Tool paths run user-defined
    // handlers and can have arbitrary side effects, so a browser-initiated
    // cross-site request to one is a CSRF attempt. Browsers always send
    // Sec-Fetch-Site (Forbidden Header — JS can't spoof it); non-browser
    // HTTP clients (curl, Python requests, Node fetch, server-side AI
    // runtimes) don't send it. Block anything other than "none" (which is
    // user-initiated navigation: address-bar paste, bookmark, link from
    // a non-web context like a desktop app or terminal).
    //
    // Read-only meta paths (/agents.md, /tools.json, /_as_tasks/<id>) are
    // matched above and bypass this check — they're served by the relay
    // (no user code), have no side effects, and clicking the URL from
    // Gmail / web chat to "preview" is a normal user flow we want to
    // keep working.
    const sfs = req.headers.get("sec-fetch-site")
    if (sfs && sfs !== "none") {
      return errorResponse("csrf_denied", "tool calls not allowed from browser context", 403)
    }

    // The app dropped and may resume within the grace window.
    if (!this.appWs) {
      return errorResponse("app_offline", "The app is reconnecting. Retry in a few seconds.", 503, { "retry-after": RECONNECTING_RETRY_AFTER_S })
    }

    // User tool call
    if (this.pending.size >= MAX_INFLIGHT) {
      return errorResponse("too_many_inflight", `max ${MAX_INFLIGHT} concurrent calls`, 429)
    }

    const method = req.method.toUpperCase()
    const tool = this.toolByRoute.get(`${method} ${userPath}`)
    if (!tool) {
      return errorResponse("not_found", `no tool for ${method} ${userPath}`, 404)
    }

    const id = crypto.randomUUID()
    const headers: Record<string, string> = {}
    // Forward content-type and the agent's own X-* headers, but not the
    // proxy headers Cloudflare adds (x-real-ip, x-forwarded-*): they carry the
    // agent's IP. cf-* never matches the x- rule.
    for (const [k, v] of req.headers.entries()) {
      const lk = k.toLowerCase()
      if (lk === "x-real-ip" || lk.startsWith("x-forwarded-")) continue
      if (lk === "content-type" || lk.startsWith("x-")) headers[lk] = v
    }

    const timeoutMs = parseInt(this.env.MAX_SYNC_TOOL_MS || "30000", 10)
    const promise = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(errorResponse("tool_timeout", `tool exceeded ${timeoutMs}ms`, 504))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
    })

    // Send the tool_call; if send() fails (WS closed mid-flight), reject the
    // pending entry immediately rather than waiting for the timeout.
    const sent = this.send({
      type: "tool_call",
      id,
      method,
      path: userPath,
      body,
      headers,
    })
    if (!sent) {
      const p = this.pending.get(id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.resolve(errorResponse("app_offline", "WS unavailable mid-call", 503))
      }
    }

    return await promise
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private send(frame: Frame): boolean {
    return this.appWs ? sendTo(this.appWs, frame) : false
  }
}

function sendTo(c: Connection, frame: Frame): boolean {
  try {
    c.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

// Validates a register (or resume) frame's app-id, agentsMd and tools.
function validateRegistration(msg: RegisterFrame | ResumeFrame): { ok: true; registration: Registration } | { ok: false; error: RegistrationError } {
  // app-id is a free-form label shown in tools.json, not a credential:
  // any app can claim any id, so there's nothing to look up.
  if (typeof msg.appId !== "string" || !APP_ID_RE.test(msg.appId)) {
    return validationFailure("invalid_app_id", "use [A-Za-z0-9_.-]{1,64}", 4001, "invalid app_id")
  }
  const md = validateAgentsMd(msg.agentsMd)
  if (md) return { ok: false, error: md }
  if (msg.tools !== undefined && !Array.isArray(msg.tools)) {
    return validationFailure("protocol_error", "tools must be an array", 4400, "invalid tools")
  }
  const v = validateTools(msg.tools ?? [])
  if (!v.ok) return v
  return {
    ok: true,
    registration: {
      appId: msg.appId,
      appDescription: typeof msg.appDescription === "string" ? msg.appDescription.slice(0, 1024) : "",
      agentsMd: msg.agentsMd,
      tools: v.tools,
    },
  }
}

function validationFailure(code: string, message: string | undefined, closeCode: number, closeReason: string) {
  return { ok: false as const, error: { code, message, closeCode, closeReason } }
}

// null when valid. Shared by register, resume and update_tools.
function validateAgentsMd(agentsMd: unknown): RegistrationError | null {
  if (typeof agentsMd !== "string" || agentsMd.length > MAX_AGENTS_MD_BYTES) {
    return validationFailure("agents_md_too_large", undefined, 4413, "agents.md too large").error
  }
  return null
}

// Validates and normalizes a tool list. Shared by register, resume and update_tools.
function validateTools(input: unknown[]): { ok: true; tools: ToolDef[] } | { ok: false; error: RegistrationError } {
  const tools: ToolDef[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const t = raw as Partial<ToolDef> | null
    if (!t || typeof t !== "object"
      || (t.method !== undefined && typeof t.method !== "string")
      || (t.description !== undefined && typeof t.description !== "string")) {
      return validationFailure("protocol_error", "each tool needs a path and string method/description", 4400, "invalid tool")
    }
    const path = t.path
    const method = (t.method ?? "POST").toUpperCase()
    if (typeof path !== "string" || !TOOL_PATH_RE.test(path)) {
      return validationFailure("reserved_path", `invalid path: ${path}`, 4400, "invalid tool path")
    }
    // Reserve both the exact meta paths AND any path that shadows them
    // as a prefix (e.g. `/agents.md/x`, `/tools.jsonx`). Belt-and-suspenders
    // against future meta-routing changes (e.g. `/agents.md/<lang>`) that
    // would otherwise let a previously-registered tool become invokable
    // from a Sec-Fetch-Site: none user-paste expecting to read a doc.
    const lowerPath = path.toLowerCase()
    const isReserved = RESERVED_PATHS.has(path)
      || path.startsWith(`/${RESERVED_PREFIX}`)
      || lowerPath === "/agents.md" || lowerPath.startsWith("/agents.md/")
      || lowerPath === "/tools.json" || lowerPath.startsWith("/tools.json/")
    if (isReserved) {
      return validationFailure("reserved_path", `path is reserved: ${path}`, 4400, "reserved path")
    }
    const key = `${method} ${path}`
    if (seen.has(key)) {
      return validationFailure("protocol_error", `duplicate tool: ${key}`, 4400, "duplicate tool")
    }
    seen.add(key)
    tools.push({
      method,
      path,
      description: t.description ?? "",
      ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
    })
  }
  return { ok: true, tools }
}

// ────────────────────────────────────────────────────────────────────
// Response builders honoring handler-supplied content-type.
//
// v0 contract: handler can declare a content-type via `headers` on its
// tool_reply / task_complete frame. The relay sends the body verbatim
// only when (a) the declared content-type is present AND (b) `body` is
// a string. Anything else (object body, undefined body, missing header)
// falls back to JSON-encoding with `application/json; charset=utf-8`.
//
// Bytes (ArrayBuffer/Uint8Array) are NOT supported in v0 — the wire
// frame is JSON-encoded and binary doesn't round-trip cleanly. Future
// work: add an explicit `bodyEncoding: "base64"` field, or move binary
// onto a separate WS frame type.
// ────────────────────────────────────────────────────────────────────

function extractContentType(headers: Record<string, string> | undefined): string | undefined {
  if (!headers || typeof headers !== "object") return undefined
  // Case-insensitive lookup so handlers can use "Content-Type" or "content-type".
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" && k.toLowerCase() === "content-type") return v
  }
  return undefined
}

// Content-types a browser will execute script in. An app's tool/task response
// is served from the relay's own origin (agentsocket.dev) and the meta/task
// surfaces are reachable by a plain browser GET, so we must never hand back
// app-controlled markup that runs as HTML/SVG-script on our origin. These get
// downgraded to text/plain (the body is still returned, just inert), as is
// any *+xml type. APP_RESPONSE_CSP is the backstop for anything that slips by.
const APP_RESPONSE_CSP = "sandbox; default-src 'none'"
const SCRIPT_CAPABLE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
])

// Never throws: an app reply that can't become a Response (bad status, a
// header value with a newline) must still resolve the agent's request.
function buildToolResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    return errorResponse("protocol_error", "app replied with an invalid status (use 200-599)", 502)
  }
  const contentType = extractContentType(headers)
  try {
    // Handler opted into a custom content-type AND gave us a string body — pass
    // it through, but neutralize script-capable types (XSS on our origin) and
    // always send nosniff so the browser can't sniff a safe type into HTML.
    if (contentType && typeof body === "string") {
      const essence = contentType.split(";")[0]!.trim().toLowerCase()
      const safeType = SCRIPT_CAPABLE_TYPES.has(essence) || essence.endsWith("+xml")
        ? "text/plain; charset=utf-8"
        : contentType
      return new Response(body, {
        status,
        headers: {
          "content-type": safeType,
          "x-content-type-options": "nosniff",
          "content-security-policy": APP_RESPONSE_CSP,
        },
      })
    }
    return new Response(
      body !== undefined ? JSON.stringify(body) : "",
      {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
          "content-security-policy": APP_RESPONSE_CSP,
        },
      },
    )
  } catch {
    return errorResponse("protocol_error", "app reply is not a valid HTTP response", 502)
  }
}
