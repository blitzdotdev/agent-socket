// RelayServer — one Durable Object instance per session.
//
// Holds:
//   - the app's WebSocket connection
//   - the registered app-id (a label), agentsMd, tools list
//   - the session's agent-tokens (as verifier hashes + sealed tokens)
//   - the pending-request correlation map for in-flight tool calls
//   - async tasks
//
// Lifecycle: a fresh `register` starts the session and returns a resume
// secret. When the app socket drops (anything but a clean 1000 close) the
// session is held until `heldUntil` (RESUME_GRACE_MS, 24 h by default) so the
// app can reattach with `/v1/_ws?session=<id>` + a `resume` frame carrying the
// secret. In-flight tool calls still fail at the drop. A clean close, a
// protocol violation, an `end` frame, or the hold running out ends the session
// and wipes memory and storage.
//
// Durable: everything but in-flight calls is written to ctx.storage (the KV
// API, which both the key-value-backed production class and the SQLite-backed
// self-host class support) and reloaded in onStart, so a session survives
// hibernation, eviction and relay restarts. One alarm drives both deadlines:
// the hold's expiry while the app is away, and the liveness check while it is
// connected. Hibernation: the SDK's heartbeat ping is answered by the runtime
// (setWebSocketAutoResponse) without waking the object, and liveness counts
// those auto-responses (getWebSocketAutoResponseTimestamp).
//
// Storage layout (no "m" ⇒ no session ⇒ storage is empty):
//   "m"            SessionMeta: resume-secret check value, hold deadline, chunk count
//   "r:<i>"        the registration as JSON ({appId, appDescription, agentsMd,
//                  tools}), split into REG_CHUNK_CHARS-char chunks (a KV-backed
//                  value is capped at 128 KiB)
//   "t:<id>"       StoredToken; id = base64url SHA-256 of the verifier, so a
//                  request is checked by hashing its verifier. The token itself
//                  is kept only sealed (AES-256-GCM) under a key derived from the
//                  resume secret, which the relay holds only while the app's
//                  socket is open (in its attachment, not in storage).
//   "k:<taskId>"   StoredTask; body as UTF-8 JSON bytes
// plus partyserver's own "__ps_name" record, which a wipe removes too.

import { Server, type Connection } from "partyserver"
import type {
  Env,
  EndFrame,
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
import {
  deriveResumeKeys,
  generateResumeSecret,
  generateVerifier,
  makeAgentToken,
  matchResumeSecret,
  openToken,
  parseAgentToken,
  sealToken,
  verifierId,
} from "./tokens"
import { errorResponse } from "./errors"
// Source of truth for the framework's "how to call tools" reference card
// lives in the SDK so the constant doesn't drift between served bytes and
// the doc the SDK template emits.
import { FRAMEWORK_PREAMBLE, hasFrameworkContract } from "../../sdk/src/preamble"
import { HEARTBEAT_PING, HEARTBEAT_PONG } from "../../sdk/src/heartbeat"

const RESERVED_PATHS = new Set(["/agents.md", "/tools.json"])
const RESERVED_PREFIX = "_as_"
const MAX_INFLIGHT = 100
const MAX_TOKENS_PER_SESSION = 50
const MAX_AGENTS_MD_BYTES = 64 * 1024
// Async-task caps. Without these a misbehaving (or hostile) app can flood
// `task_complete` frames with arbitrary IDs and bodies and grow the session's
// memory and storage without bound.
const MAX_TASKS_PER_SESSION = 100
// UTF-8 bytes of the result body as JSON; also keeps a stored task under the
// 128 KiB value cap of a key-value-backed Durable Object.
const MAX_TASK_BODY_BYTES = 64 * 1024
// A task's content-type is stored with it; bounded like a token label.
const MAX_TASK_CONTENT_TYPE_CHARS = 256
const REGISTER_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const DEFAULT_RESUME_GRACE_MS = 24 * 60 * 60 * 1000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 50_000
// Registration chunk size in UTF-16 code units: at most 64 KiB serialized,
// well under the 128 KiB value cap.
const REG_CHUNK_CHARS = 32 * 1024
// put()/delete() take at most 128 keys per call.
const STORAGE_BATCH = 128
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
// Task IDs are app-supplied strings used as Map/storage keys and echoed in
// HTTP responses. Bound the shape so an app can't store control chars,
// oversized keys, or non-strings.
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// FRAMEWORK_PREAMBLE + hasFrameworkContract are imported from sdk/src/preamble.

interface PendingRequest {
  resolve: (r: Response) => void
  timer: ReturnType<typeof setTimeout>
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

interface SessionMeta {
  v: 1
  /** deriveResumeKeys(secret).check; the secret itself is never stored. */
  check: string
  /** Number of "r:<i>" registration chunks. */
  regChunks: number
  /** While the app is away: when the session ends. null while it is connected. */
  heldUntil: number | null
  /** When the app's socket went away (for the agent's "offline for" message). */
  detachedAt: number | null
}

interface StoredToken {
  label: string
  mintedAt: number
  /** sealToken(token, tokenKey) */
  sealed: string
}

interface StoredTask {
  status: number
  completed: boolean
  contentType?: string
  body?: Uint8Array
}

// Per-socket state, kept by the runtime with the socket (survives
// hibernation, gone when the socket closes; never in storage).
interface SocketState {
  /** "app": the session's app socket (registered or about to register).
   *  "candidate": on /v1/_ws?session=, hasn't proven the secret yet. */
  role: "app" | "candidate"
  since: number
  /** Last frame from this socket (heartbeat auto-responses are tracked by the runtime). */
  seenAt?: number
  /** The session's token-sealing key, once registered or resumed. */
  key?: string
}

function stateOf(c: Connection): SocketState | null {
  try { return (c.state as SocketState | null) ?? null } catch { return null }
}

export class RelayServer extends Server<Env> {
  static options = { hibernate: true }

  // ── Session state: mirrored in storage, reloaded by onStart ─────────
  /** null ⇔ no session. */
  meta: SessionMeta | null = null
  reg: Registration | null = null
  // Map "<METHOD> <path>" → ToolDef for fast routing
  toolByRoute: Map<string, ToolDef> = new Map()
  // verifierId(verifier) → token
  tokens: Map<string, StoredToken> = new Map()
  // For async / task polling
  tasks: Map<string, PendingTask> = new Map()
  // The registration JSON in storage, so an unchanged one isn't rewritten.
  regJson = ""

  // ── Memory only ─────────────────────────────────────────────────────
  // The app's socket; found again by its SocketState role after a wake.
  appWs: Connection | null = null
  pending: Map<string, PendingRequest> = new Map()
  // Register/resume deadlines by connection id. Cleared as soon as the socket
  // registers or resumes: a pending timer keeps the object from hibernating.
  deadlines: Map<string, ReturnType<typeof setTimeout>> = new Map()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The runtime answers the SDK's heartbeat itself, even while hibernated.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG))
  }

  // The worker routes with idFromName(sessionId), so the DO's name is the session-id.
  private get sessionId(): string {
    return this.name
  }

  private get debug(): boolean {
    return this.env.DEBUG === "1"
  }

  // ── Load (every cold start: first request, wake from hibernation, alarm) ──

  private loaded: Promise<void> | null = null

  // partyserver calls this before the first event; fetch() below may get there first.
  onStart(): Promise<void> {
    return this.loaded ??= this.load()
  }

  private async load(): Promise<void> {
    const all = await this.ctx.storage.list()
    const meta = all.get("m") as SessionMeta | undefined
    if (!meta) {
      // No session. Drop anything else (partyserver's name record, the rest
      // of an interrupted wipe) so an idle object holds no storage at all.
      if (all.size) await this.wipeStorage()
      return
    }
    let regJson = ""
    for (let i = 0; i < meta.regChunks; i++) regJson += (all.get(`r:${i}`) as string | undefined) ?? ""
    let reg: Registration
    try {
      reg = JSON.parse(regJson) as Registration
    } catch {
      console.error(`[DO] unreadable registration; ending session ${this.sessionId}`)
      await this.wipeStorage()
      return
    }
    this.meta = meta
    this.reg = reg
    this.regJson = regJson
    this.indexTools()
    for (const [k, v] of all) {
      if (k.startsWith("t:")) {
        this.tokens.set(k.slice(2), v as StoredToken)
      } else if (k.startsWith("k:")) {
        const t = v as StoredTask
        const body = t.body ? JSON.parse(new TextDecoder().decode(t.body)) : undefined
        this.tasks.set(k.slice(2), { status: t.status, completed: t.completed, body, contentType: t.contentType })
      }
    }
    // An app socket survives hibernation; a restart or eviction drops it.
    for (const c of this.getConnections()) {
      if (stateOf(c)?.role === "app") { this.appWs = c; break }
    }
    const now = Date.now()
    if (this.appWs) {
      if (meta.heldUntil !== null) this.markAttached(now)
    } else if (meta.heldUntil === null) {
      // The object lost its memory while the app was connected and the socket
      // went with it: start the hold now.
      this.detachApp()
    } else if (meta.heldUntil <= now) {
      this.endSession()
    }
    if (this.debug) console.log(`[DO] loaded sessionId=${this.sessionId} app=${this.appWs ? "attached" : "away"} tokens=${this.tokens.size} tasks=${this.tasks.size} heldUntil=${this.meta?.heldUntil ?? "-"}`)
  }

  // ── WS lifecycle ──────────────────────────────────────────────────

  // An upgrade this session will refuse gets a plain socket closed at once,
  // before partyserver accepts it as a hibernatable one: workerd completes the
  // server-side close of a hibernatable socket that never delivered a message
  // only when the object next goes idle (~10 s), so the client would sit in
  // CLOSING that long. onConnect re-checks for upgrades racing each other.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      await this.onStart()
      const refusal = this.upgradeRefusal(new URL(request.url))
      if (refusal) {
        const { 0: client, 1: server } = new WebSocketPair()
        server.accept()
        server.close(refusal.code, refusal.reason)
        return new Response(null, { status: 101, webSocket: client })
      }
    }
    return super.fetch(request)
  }

  private upgradeRefusal(url: URL, self?: Connection): { code: number; reason: string } | null {
    // The worker only forwards upgrades from /v1/_ws; re-check so no other
    // route can ever attach a socket as the app.
    if (url.pathname !== "/v1/_ws") return { code: 4400, reason: "websocket only on /v1/_ws" }
    if (url.searchParams.has("session")) {
      let waiting = 0
      for (const o of this.getConnections()) if (o.id !== self?.id && stateOf(o)?.role === "candidate") waiting++
      return waiting >= MAX_RESUME_CANDIDATES ? { code: 4409, reason: "too many resume attempts" } : null
    }
    // A plain upgrade may only start a session on an empty DO: not while an
    // app is attached, nor while a dropped one's session is held.
    if (this.appWs || this.meta) return { code: 4409, reason: "already connected" }
    return null
  }

  onConnect(c: Connection, ctx: { request: Request }): void {
    const url = new URL(ctx.request.url)
    const refusal = this.upgradeRefusal(url, c)
    if (refusal) {
      rejectSocket(c, refusal.code, refusal.reason)
      return
    }
    // /v1/_ws?session=<id> is a resume (or end) attempt. The socket gets no
    // access until its first frame proves the secret, so it can't disturb the
    // live app.
    if (url.searchParams.has("session")) {
      c.setState({ role: "candidate", since: Date.now() } satisfies SocketState)
      this.setDeadline(c, () => {
        if (stateOf(c)?.role === "candidate") {
          try { c.close(4408, "resume timeout") } catch {}
        }
      })
      return
    }
    c.setState({ role: "app", since: Date.now() } satisfies SocketState)
    this.appWs = c
    // Don't let a socket that never registers pin this DO.
    this.setDeadline(c, () => {
      if (this.appWs?.id === c.id && this.meta === null) this.endSession(4408, "register timeout")
    })
    if (this.debug) console.log(`[DO] WS connected sessionId=${this.sessionId}, awaiting register`)
  }

  private setDeadline(c: Connection, onExpiry: () => void): void {
    this.deadlines.set(c.id, setTimeout(() => {
      this.deadlines.delete(c.id)
      onExpiry()
    }, REGISTER_TIMEOUT_MS))
  }

  private clearDeadline(c: Connection): void {
    const t = this.deadlines.get(c.id)
    if (t !== undefined) clearTimeout(t)
    this.deadlines.delete(c.id)
  }

  onClose(c: Connection, code: number): void {
    this.clearDeadline(c)
    // Resume candidates and replaced or rejected sockets don't affect the
    // session. A refused attempt on an empty object leaves partyserver's name
    // record behind: drop it, so an object without a session stores nothing.
    if (!this.appWs || c.id !== this.appWs.id) {
      if (this.meta === null && !this.appWs) this.write(this.wipeStorage())
      return
    }
    // 1000 is the SDK's close(): the app is done, so don't hold the session.
    if (code === 1000) this.endSession()
    else this.detachApp()
  }

  // The app socket is gone (or being closed with `code`). In-flight calls fail;
  // the session is held until meta.heldUntil so the app can resume.
  // Doesn't wait for onClose: a dead peer may never complete the handshake.
  private detachApp(code?: number, reason?: string, holdMs?: number): void {
    if (code !== undefined) {
      try { this.appWs?.close(code, reason) } catch {}
    }
    this.appWs = null
    this.failPending("App's WebSocket dropped")
    const graceMs = holdMs ?? parseInt(this.env.RESUME_GRACE_MS || String(DEFAULT_RESUME_GRACE_MS), 10)
    if (this.meta === null || !(graceMs > 0)) {
      this.endSession()
      return
    }
    const now = Date.now()
    this.meta = { ...this.meta, heldUntil: now + graceMs, detachedAt: now }
    this.write(this.ctx.storage.put("m", this.meta))
    this.write(this.ctx.storage.setAlarm(this.meta.heldUntil!))
    if (this.debug) console.log(`[DO] app detached sessionId=${this.sessionId} (${code ?? "closed"}${reason ? ` ${reason}` : ""}); holding ${graceMs} ms for resume`)
  }

  // `c` becomes the session's app socket.
  private attachApp(c: Connection, tokenKey: string): void {
    this.clearDeadline(c)
    const now = Date.now()
    c.setState({ role: "app", since: now, seenAt: now, key: tokenKey } satisfies SocketState)
    this.appWs = c
    this.markAttached(now)
  }

  // Session state for "app connected": no hold, liveness alarm armed.
  private markAttached(now: number): void {
    this.meta = { ...this.meta!, heldUntil: null, detachedAt: null }
    this.write(this.ctx.storage.put("m", this.meta))
    this.write(this.ctx.storage.setAlarm(now + this.heartbeatTimeoutMs()))
  }

  // End the session: close the app socket (if asked), fail in-flight calls,
  // and wipe memory and storage, so a later socket on this DO starts from scratch.
  private endSession(code?: number, reason?: string): void {
    if (code !== undefined) {
      try { this.appWs?.close(code, reason) } catch {}
    }
    this.appWs = null
    this.failPending("App's WebSocket dropped")
    this.meta = null
    this.reg = null
    this.regJson = ""
    this.toolByRoute.clear()
    this.tokens.clear()
    this.tasks.clear()
    this.write(this.wipeStorage())
    if (this.debug) console.log(`[DO] session ended sessionId=${this.sessionId}`)
  }

  private wipeStorage(): Promise<void> {
    // deleteAll() leaves the alarm in place before compatibility date 2026-02-24.
    this.write(this.ctx.storage.deleteAlarm())
    return this.ctx.storage.deleteAll()
  }

  // Storage writes aren't awaited: writes issued without an intervening await
  // commit together, and the runtime holds this object's outgoing messages
  // until they are durable (if a write fails, the object is reset instead).
  private write(p: Promise<unknown>): void {
    p.catch((e) => console.error(`[DO] storage write failed sessionId=${this.sessionId}:`, e))
  }

  private failPending(message: string): void {
    if (this.debug && this.pending.size) console.log("[DO] failing", this.pending.size, "pending")
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve(errorResponse("app_offline", message, 503))
    }
    this.pending.clear()
  }

  private heartbeatTimeoutMs(): number {
    return parseInt(this.env.HEARTBEAT_TIMEOUT_MS || String(DEFAULT_HEARTBEAT_TIMEOUT_MS), 10)
  }

  // Last sign of life from `c`: its last frame or the runtime's last
  // auto-response to its heartbeat, whichever is later.
  private lastSeen(c: Connection): number {
    const st = stateOf(c)
    let t = st?.seenAt ?? st?.since ?? 0
    try {
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(c)
      if (auto) t = Math.max(t, auto.getTime())
    } catch {}
    return t
  }

  // The one alarm: hold expiry while the app is away, liveness while it's here.
  async onAlarm(): Promise<void> {
    if (this.meta === null) {
      await this.wipeStorage()
      return
    }
    const now = Date.now()
    if (this.meta.heldUntil !== null) {
      if (now >= this.meta.heldUntil) {
        if (this.debug) console.log(`[DO] alarm: hold expired sessionId=${this.sessionId}`)
        this.endSession()
      } else this.write(this.ctx.storage.setAlarm(this.meta.heldUntil))
      return
    }
    if (!this.appWs) {
      this.detachApp()
      return
    }
    // The app pings every 25 s; silent for HEARTBEAT_TIMEOUT_MS ⇒ a half-open
    // socket that mustn't keep the session "live".
    const timeoutMs = this.heartbeatTimeoutMs()
    const last = this.lastSeen(this.appWs)
    if (now - last >= timeoutMs) this.detachApp(4408, "heartbeat timeout")
    else this.write(this.ctx.storage.setAlarm(last + timeoutMs))
  }

  onError(_c: Connection, error: unknown): void {
    if (this.debug) console.log("[DO] WS error:", error)
  }

  // ── Frame dispatch ────────────────────────────────────────────────

  onMessage(c: Connection, raw: string | ArrayBuffer): void {
    const candidate = stateOf(c)?.role === "candidate"
    if (!candidate && c.id !== this.appWs?.id) return
    // workerd's own limit is 32 MiB; parsing frames that big risks OOM for
    // every session sharing this isolate.
    if ((typeof raw === "string" ? raw.length : raw.byteLength) > MAX_FRAME_BYTES) {
      if (candidate) {
        try { c.close(1009, "frame too large") } catch {}
      } else {
        this.endSession(1009, "frame too large")
      }
      return
    }
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    let msg: Frame
    try { msg = JSON.parse(text) as Frame } catch {
      if (this.debug) console.log("[DO] dropped non-JSON frame")
      return
    }
    if (!msg || typeof msg !== "object") return

    // A resume socket's only allowed frames are `resume` and `end`; anything
    // else is dropped (the resume timeout bounds how long it can sit there).
    if (candidate) {
      if (msg.type === "resume") this.handleResume(c, msg)
      else if (msg.type === "end") this.handleEnd(c, msg)
      return
    }

    c.setState({ ...stateOf(c)!, seenAt: Date.now() })

    // Pre-register gate: only `register`, `ping`, `pong` allowed before app
    // is fully registered. Everything else returns a protocol_error reply
    // (or is dropped silently for tool_reply / task_complete since those
    // don't have a request id we can echo).
    const registered = this.meta !== null
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
        this.handleRegister(c, msg)
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
        // The exact heartbeat frame never gets here (the runtime answers it);
        // any other ping does.
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

  // ── Register / Resume / End ───────────────────────────────────────

  private handleRegister(c: Connection, msg: RegisterFrame): void {
    // Already-registered guard. A second register can't change app-id /
    // tools mid-session (a resume can).
    if (this.meta !== null) {
      this.send({ type: "register_reply", ok: false, error: { code: "protocol_error", message: "already registered" } })
      return
    }
    const v = validateRegistration(msg)
    if (!v.ok) {
      this.send({ type: "register_reply", ok: false, error: { code: v.error.code, message: v.error.message } })
      this.endSession(v.error.closeCode, v.error.closeReason)
      return
    }
    const resumeSecret = generateResumeSecret()
    const keys = deriveResumeKeys(resumeSecret)
    this.meta = { v: 1, check: keys.check, regChunks: 0, heldUntil: null, detachedAt: null }
    this.setRegistration(v.registration)
    this.attachApp(c, keys.tokenKey)
    this.send({ type: "register_reply", ok: true, sessionId: this.sessionId, resumeSecret })
    if (this.debug) console.log(`[DO] registered appId=${this.reg!.appId} sessionId=${this.sessionId} tools=${this.reg!.tools.length}`)
  }

  // The secret's derived keys if `secret` is this session's, else null. Same
  // answer for a wrong secret, an ended session and an empty DO.
  private checkSecret(sessionId: unknown, secret: unknown) {
    if (this.meta === null || sessionId !== this.sessionId) return null
    return matchResumeSecret(secret, this.meta.check)
  }

  // A socket from /v1/_ws?session=<id> claims the session. It must carry the
  // secret from register_reply; on success it becomes the app socket (closing
  // a still-attached old one, which is usually half-dead), the registration is
  // replaced by the frame's, and tokens + tasks carry over.
  private handleResume(c: Connection, msg: ResumeFrame): void {
    const reject = (code: string, message: string, closeCode: number, closeReason: string) => {
      this.clearDeadline(c)
      sendTo(c, { type: "register_reply", ok: false, error: { code, message } })
      try { c.close(closeCode, closeReason) } catch {}
    }
    const v = validateRegistration(msg)
    if (!v.ok) return reject(v.error.code, v.error.message ?? "", v.error.closeCode, v.error.closeReason)
    const keys = this.checkSecret(msg.sessionId, msg.secret)
    if (!keys) return reject("resume_failed", "unknown session or bad secret", 4401, "resume rejected")

    const old = this.appWs
    this.attachApp(c, keys.tokenKey)
    if (old) {
      // Calls sent down the old socket will never be answered.
      this.failPending("App reconnected")
      try { old.close(4410, "replaced by a resumed connection") } catch {}
    }
    this.setRegistration(v.registration)
    // Revokes the app made while it was offline, applied before it goes live.
    if (Array.isArray(msg.revokeTokens)) {
      for (const t of msg.revokeTokens.slice(0, MAX_TOKENS_PER_SESSION)) {
        const parsed = typeof t === "string" ? parseAgentToken(t) : null
        if (parsed && parsed.sessionId === this.sessionId) this.revoke(parsed.verifier)
      }
    }
    this.send({ type: "register_reply", ok: true, sessionId: this.sessionId, resumeSecret: msg.secret, resumed: true })
    if (this.debug) console.log(`[DO] resumed sessionId=${this.sessionId} tools=${this.reg!.tools.length} tokens=${this.tokens.size}`)
  }

  // Ends the session from a socket that proves the secret (the app went away
  // and wants its links dead now rather than when the hold runs out).
  private handleEnd(c: Connection, msg: EndFrame): void {
    this.clearDeadline(c)
    if (!this.checkSecret(msg.sessionId, msg.secret)) {
      sendTo(c, { type: "end_reply", ok: false, error: { code: "resume_failed", message: "unknown session or bad secret" } })
      try { c.close(4401, "end rejected") } catch {}
      return
    }
    this.endSession(1000, "session ended")
    sendTo(c, { type: "end_reply", ok: true })
    try { c.close(1000, "session ended") } catch {}
  }

  // Replace the registration (memory + storage).
  private setRegistration(r: Registration): void {
    this.reg = r
    this.indexTools()
    const json = JSON.stringify(r)
    if (json === this.regJson) return
    const meta = this.meta!
    const n = Math.max(1, Math.ceil(json.length / REG_CHUNK_CHARS))
    const entries: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) entries[`r:${i}`] = json.slice(i * REG_CHUNK_CHARS, (i + 1) * REG_CHUNK_CHARS)
    const stale: string[] = []
    for (let i = n; i < meta.regChunks; i++) stale.push(`r:${i}`)
    this.meta = { ...meta, regChunks: n }
    entries.m = this.meta
    const keys = Object.keys(entries)
    for (let i = 0; i < keys.length; i += STORAGE_BATCH) {
      const batch: Record<string, unknown> = {}
      for (const k of keys.slice(i, i + STORAGE_BATCH)) batch[k] = entries[k]
      this.write(this.ctx.storage.put(batch))
    }
    for (let i = 0; i < stale.length; i += STORAGE_BATCH) this.write(this.ctx.storage.delete(stale.slice(i, i + STORAGE_BATCH)))
    this.regJson = json
  }

  private indexTools(): void {
    this.toolByRoute.clear()
    for (const t of this.reg?.tools ?? []) this.toolByRoute.set(`${t.method} ${t.path}`, t)
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
    this.setRegistration({ ...this.reg!, tools: v.tools, ...(msg.agentsMd !== undefined ? { agentsMd: msg.agentsMd } : {}) })
    reply({ ok: true })
    if (this.debug) console.log(`[DO] update_tools sessionId=${this.sessionId} tools=${this.reg!.tools.length}`)
  }

  // ── Mint / Revoke / List agent-tokens ─────────────────────────────

  // The sealing key, held only while the app's socket is open.
  private tokenKey(): string | null {
    return (this.appWs && stateOf(this.appWs)?.key) || null
  }

  private handleMint(msg: { id: string; label: string }): void {
    if (this.tokens.size >= MAX_TOKENS_PER_SESSION) {
      this.send({ type: "mint_agent_token_reply", id: msg.id, ok: false, error: { code: "too_many_tokens" } })
      return
    }
    const key = this.tokenKey()
    if (!key) {
      this.send({ type: "mint_agent_token_reply", id: msg.id, ok: false, error: { code: "internal_error" } })
      return
    }
    const verifier = generateVerifier()
    const token = makeAgentToken(this.sessionId, verifier)
    const url = `__BASE__/v1/t/${token}/agents.md`  // SDK rewrites __BASE__ to actual host
    const label = typeof msg.label === "string" ? msg.label.slice(0, 256) : ""
    const stored: StoredToken = { label, mintedAt: Date.now(), sealed: sealToken(token, key) }
    const id = verifierId(verifier)
    this.tokens.set(id, stored)
    this.write(this.ctx.storage.put(`t:${id}`, stored))
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

  private revoke(verifier: string): boolean {
    const id = verifierId(verifier)
    if (!this.tokens.delete(id)) return false
    this.write(this.ctx.storage.delete(`t:${id}`))
    return true
  }

  private handleRevoke(msg: { id: string; token: string }): void {
    const parsed = typeof msg.token === "string" ? parseAgentToken(msg.token) : null
    const revoked = !!parsed && parsed.sessionId === this.sessionId && this.revoke(parsed.verifier)
    const reply: RevokeAgentTokenReplyFrame = {
      type: "revoke_agent_token_reply",
      id: msg.id,
      ok: revoked,
    }
    this.send(reply)
  }

  private handleList(msg: { id: string }): void {
    const key = this.tokenKey()
    const tokens: ListAgentTokensReplyFrame["tokens"] = []
    for (const t of this.tokens.values()) {
      const token = key ? openToken(t.sealed, key) : null
      if (token) tokens.push({ token, url: `__BASE__/v1/t/${token}/agents.md`, label: t.label, mintedAt: t.mintedAt })
    }
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
      if (this.debug) console.log("[DO] tool_reply with unknown id:", msg.id)
      return
    }
    clearTimeout(p.timer)
    this.pending.delete(msg.id)

    if (msg.status === 202 && msg.taskId) {
      // Async: app reports the call started; agent should poll /_as_tasks/<id>.
      // Validate the taskId shape and cap the per-session task count before
      // accepting — both are app-controlled inputs that otherwise grow the
      // session without bound.
      if (typeof msg.taskId !== "string" || !TASK_ID_RE.test(msg.taskId)) {
        p.resolve(errorResponse("protocol_error", "invalid taskId (use [A-Za-z0-9_-]{1,64})", 502))
        return
      }
      if (this.tasks.size >= MAX_TASKS_PER_SESSION) {
        p.resolve(errorResponse("too_many_tasks", `max ${MAX_TASKS_PER_SESSION} pending tasks per session`, 503))
        return
      }
      this.tasks.set(msg.taskId, { status: 0, body: undefined, completed: false })
      this.write(this.ctx.storage.put(`k:${msg.taskId}`, { status: 0, completed: false } satisfies StoredTask))
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
      if (this.debug) console.log("[DO] task_complete dropped: invalid taskId shape")
      return
    }
    // Only UPDATE an existing pending task — we never create entries here.
    // Combined with the cap on the 202 path, the Map size is bounded.
    if (!this.tasks.has(taskId)) {
      if (this.debug) console.log("[DO] task_complete dropped: taskId not pending:", taskId)
      return
    }
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
      if (this.debug) console.log("[DO] task_complete dropped: invalid status:", status)
      return
    }
    let serialized: Uint8Array
    try {
      serialized = new TextEncoder().encode(JSON.stringify(body ?? null))
    } catch {
      if (this.debug) console.log("[DO] task_complete dropped: body not JSON-serializable")
      return
    }
    if (serialized.byteLength > MAX_TASK_BODY_BYTES) {
      if (this.debug) console.log(`[DO] task_complete dropped: body ${serialized.byteLength} > ${MAX_TASK_BODY_BYTES} bytes`)
      return
    }
    const contentType = extractContentType(headers)
    if (contentType !== undefined && contentType.length > MAX_TASK_CONTENT_TYPE_CHARS) {
      if (this.debug) console.log("[DO] task_complete dropped: content-type too long")
      return
    }
    this.tasks.set(taskId, { status, body, completed: true, contentType })
    const stored: StoredTask = { status, completed: true, body: serialized, ...(contentType !== undefined ? { contentType } : {}) }
    this.write(this.ctx.storage.put(`k:${taskId}`, stored))
  }

  // ── HTTP entry ────────────────────────────────────────────────────

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const pathname = url.pathname

    // Debug-only inner paths from worker.ts. Token validation does not apply
    // (the paths don't follow /v1/t/<token>/...).
    if (this.debug && pathname.startsWith("/_as_debug/")) return this.handleDebug(url)

    // Strip the routing prefix `/v1/t/<token>` to get the user-facing path.
    // Worker entry already validated the token format and routed here.
    const m = pathname.match(/^\/v1\/t\/[^/]+(\/.*)?$/)
    const userPath = m?.[1] ?? "/"

    // App-offline check FIRST — with no session registered, every request
    // returns the same code regardless of token validity. Avoids leaking
    // session-lifecycle info ("does this token exist anywhere?"). While a
    // dropped app's session is held for resume, tokens are still checked and
    // the relay-served paths keep working; tool calls get 503 below.
    if (this.meta === null || this.reg === null) {
      return errorResponse("app_offline", APP_OFFLINE_MESSAGE, 503)
    }

    // Token verifier check — re-parse and check against the session's tokens.
    const tokenMatch = pathname.match(/^\/v1\/t\/([^/]+)\//)
    if (!tokenMatch) return errorResponse("not_found", "malformed url", 404)
    const tokenStr = tokenMatch[1]!
    const parsed = parseAgentToken(tokenStr)
    if (!parsed || parsed.sessionId !== this.sessionId) {
      return errorResponse("token_invalid", "token format or session mismatch", 401)
    }
    if (!this.tokens.has(verifierId(parsed.verifier))) {
      return errorResponse("token_invalid", "agent-token unknown or revoked", 401)
    }

    // The worker already buffered (and capped) the body, so returning above
    // without reading it is safe; read it only once the token is known good.
    const body = await req.text()

    // Reserved meta paths
    if (userPath === "/agents.md") {
      const appMd = this.reg.agentsMd || ""
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
          id: this.reg.appId,
          name: this.reg.appId,
          description: this.reg.appDescription,
        },
        tools: this.reg.tools.map((t) => ({
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
      // delivered. Without this the session's tasks pile up and, once
      // MAX_TASKS_PER_SESSION completed tasks accumulate, the cap check on the
      // 202 path permanently bricks the session's async path.
      this.tasks.delete(taskId)
      this.write(this.ctx.storage.delete(`k:${taskId}`))
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

    // The app dropped and may resume while the session is held.
    if (!this.appWs) {
      const away = this.meta.detachedAt !== null ? ` (offline for ${formatDuration(Date.now() - this.meta.detachedAt)})` : ""
      return errorResponse(
        "app_offline",
        `The app is reconnecting${away}. Retry in a few seconds. If it stays offline, ask the user to check that the app is open and online; this link keeps working once it reconnects.`,
        503,
        { "retry-after": RECONNECTING_RETRY_AFTER_S },
      )
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

  // ── Debug (DEBUG=1 only; worker.ts forwards /_debug/<op>/<sessionId>) ──

  private async handleDebug(url: URL): Promise<Response> {
    const op = url.pathname.slice("/_as_debug/".length)
    if (op === "kill-ws") {
      // Close the app socket, leaving the session resumable (?hold=<ms>
      // overrides RESUME_GRACE_MS for this drop); ?end=1 ends the session
      // instead, as if the hold had run out.
      const hold = url.searchParams.get("hold")
      if (url.searchParams.get("end") === "1") this.endSession(1011, "killed by debug endpoint")
      else if (this.appWs) this.detachApp(1011, "killed by debug endpoint", hold ? parseInt(hold, 10) : undefined)
      return new Response("ok", { status: 200 })
    }
    if (op === "state") {
      // What this object holds, without any secret material.
      const keys = [...(await this.ctx.storage.list()).keys()]
      let autoResponseAt: number | null = null
      try { autoResponseAt = this.appWs ? this.ctx.getWebSocketAutoResponseTimestamp(this.appWs)?.getTime() ?? null : null } catch {}
      return Response.json({
        session: this.meta !== null,
        appConnected: !!this.appWs,
        lastFrameAt: this.appWs ? stateOf(this.appWs)?.seenAt ?? null : null,
        autoResponseAt,
        heldUntil: this.meta?.heldUntil ?? null,
        alarm: await this.ctx.storage.getAlarm(),
        tokens: this.tokens.size,
        tasks: this.tasks.size,
        storageKeys: keys,
      })
    }
    if (op === "evict") {
      // Reset the object as an eviction or relay restart would: memory gone,
      // sockets dropped, storage and alarm kept.
      this.ctx.abort("evicted by debug endpoint")
    }
    return errorResponse("not_found", "unknown debug op", 404)
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private send(frame: Frame): boolean {
    return this.appWs ? sendTo(this.appWs, frame) : false
  }
}

// Close a socket from onConnect (only reached when two upgrades race past
// fetch()'s check). Closed a tick later so the 101 response goes out first.
function rejectSocket(c: Connection, code: number, reason: string): void {
  setTimeout(() => {
    try { c.close(code, reason) } catch {}
  }, 0)
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s`
  if (s < 90 * 60) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
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
