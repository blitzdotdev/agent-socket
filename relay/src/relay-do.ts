// RelayServer — one Durable Object instance per session.
//
// Holds:
//   - the app's WebSocket connection
//   - the registered app-id, agentsMd, tools list
//   - the set of valid agent-tokens (verifiers) minted in this session
//   - the pending-request correlation map for in-flight tool calls
//
// Lifecycle: dies on WS disconnect. No persistence in v0.

import { Server, type Connection } from "partyserver"
import type {
  Env,
  Frame,
  RegisterFrame,
  ToolDef,
  ToolReplyFrame,
  MintAgentTokenReplyFrame,
  RevokeAgentTokenReplyFrame,
  ListAgentTokensReplyFrame,
} from "./types"
import { generateVerifier, makeAgentToken, parseAgentToken } from "./tokens"
import { lookupApp, checkOrigin } from "./apps"
import { errorResponse } from "./errors"

const RESERVED_PATHS = new Set(["/agents.md", "/tools.json"])
const RESERVED_PREFIX = "_as_"
const MAX_INFLIGHT = 10
const MAX_TOKENS_PER_SESSION = 50
const MAX_AGENTS_MD_BYTES = 64 * 1024

const TOOL_PATH_RE = /^\/[a-zA-Z0-9_\-/.]+$/

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

interface PendingTask {
  status: number
  body: unknown
  completed: boolean
}

export class RelayServer extends Server<Env> {
  static options = { hibernate: false }

  appWs: Connection | null = null
  sessionId: string | null = null
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

  // ── WS lifecycle ──────────────────────────────────────────────────

  onConnect(c: Connection, ctx: { request: Request }): void {
    if (this.appWs) {
      c.close(4409, "already connected")
      return
    }
    // The Worker generated our session-id and stuffed it into a header on
    // the upgrade request. Stash it now; we hand it back in register_reply.
    const sessionId = ctx.request.headers.get("x-as-session-id")
    if (!sessionId) {
      c.close(4500, "missing session-id header")
      return
    }
    this.sessionId = sessionId
    // Stash the Origin header for the later origin-check on register.
    const origin = ctx.request.headers.get("origin")
    ;(c as Connection & { origin?: string | null }).origin = origin
    this.appWs = c
    if (this.env.DEBUG === "1") console.log(`[DO] WS connected sessionId=${sessionId}, awaiting register`)
  }

  onClose(): void {
    if (this.env.DEBUG === "1") console.log("[DO] WS closed; failing", this.pending.size, "pending")
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve(errorResponse("app_offline", "App's WebSocket dropped", 503))
    }
    this.pending.clear()
    this.appWs = null
    // Don't clear validTokens here — orphan agent-token requests will
    // still get routed to this DO (until CF evicts) and we want them to
    // see token_invalid (no app_offline since the token isn't recognized
    // either). Actually app_offline is correct because there's no WS.
    // Keeping the validTokens around allows the (rare) reconnect-same-DO
    // case to work without re-registering. But CF evicts ~70-140s; not
    // designed for it.
  }

  onError(_c: Connection, error: unknown): void {
    if (this.env.DEBUG === "1") console.log("[DO] WS error:", error)
  }

  // ── Frame dispatch ────────────────────────────────────────────────

  onMessage(_c: Connection, raw: string | ArrayBuffer): void {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    let msg: Frame
    try { msg = JSON.parse(text) as Frame } catch {
      if (this.env.DEBUG === "1") console.log("[DO] dropped non-JSON frame")
      return
    }

    // Pre-register gate: only `register`, `ping`, `pong` allowed before app
    // is fully registered. Everything else returns a protocol_error reply
    // (or is dropped silently for tool_reply / task_complete since those
    // don't have a request id we can echo).
    const registered = this.appId !== null
    if (!registered && msg.type !== "register" && msg.type !== "ping" && msg.type !== "pong") {
      if ("id" in msg && typeof msg.id === "string") {
        // Best-effort error reply on the matching reply type
        const replyType = msg.type === "mint_agent_token" ? "mint_agent_token_reply"
          : msg.type === "revoke_agent_token" ? "revoke_agent_token_reply"
          : msg.type === "list_agent_tokens" ? "list_agent_tokens_reply"
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
      case "tool_reply":
        this.handleToolReply(msg)
        return
      case "task_complete":
        this.handleTaskComplete(msg.taskId, msg.status, msg.body)
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

  // ── Register ──────────────────────────────────────────────────────

  private handleRegister(msg: RegisterFrame): void {
    // 0. Already-registered guard. A second register can't change app-id /
    //    origin allowlist / tools mid-session.
    if (this.appId !== null) {
      this.send({ type: "register_reply", ok: false, error: { code: "protocol_error", message: "already registered" } })
      return
    }

    // 1. Look up app-id.
    const app = lookupApp(msg.appId)
    if (!app) {
      this.send({ type: "register_reply", ok: false, error: { code: "unknown_app_id" } })
      this.appWs?.close(4001, "unknown app_id")
      return
    }

    // 2. Origin check (browsers only — non-browsers skip via "*" or absent origin).
    const origin = (this.appWs as Connection & { origin?: string | null }).origin ?? null
    if (!checkOrigin(app, origin)) {
      this.send({ type: "register_reply", ok: false, error: { code: "origin_denied" } })
      this.appWs?.close(4003, "origin denied")
      return
    }

    // 3. Validate agentsMd size.
    if (typeof msg.agentsMd !== "string" || msg.agentsMd.length > MAX_AGENTS_MD_BYTES) {
      this.send({ type: "register_reply", ok: false, error: { code: "agents_md_too_large" } })
      this.appWs?.close(4413, "agents.md too large")
      return
    }

    // 4. Validate + index tools.
    const validatedTools: ToolDef[] = []
    const seen = new Set<string>()
    for (const t of msg.tools ?? []) {
      const path = t.path
      const method = (t.method ?? "POST").toUpperCase()

      if (typeof path !== "string" || !TOOL_PATH_RE.test(path)) {
        this.send({ type: "register_reply", ok: false, error: { code: "reserved_path", message: `invalid path: ${path}` } })
        this.appWs?.close(4400, "invalid tool path")
        return
      }
      if (RESERVED_PATHS.has(path) || path.startsWith(`/${RESERVED_PREFIX}`)) {
        this.send({ type: "register_reply", ok: false, error: { code: "reserved_path", message: `path is reserved: ${path}` } })
        this.appWs?.close(4400, "reserved path")
        return
      }
      const key = `${method} ${path}`
      if (seen.has(key)) {
        this.send({ type: "register_reply", ok: false, error: { code: "protocol_error", message: `duplicate tool: ${key}` } })
        this.appWs?.close(4400, "duplicate tool")
        return
      }
      seen.add(key)

      const validated: ToolDef = {
        method,
        path,
        description: t.description ?? "",
        ...(t.input_schema !== undefined ? { input_schema: t.input_schema } : {}),
      }
      validatedTools.push(validated)
    }

    // 5. Store state, reply with the session-id assigned at WS handshake.
    if (!this.sessionId) {
      this.send({ type: "register_reply", ok: false, error: { code: "internal_error", message: "session-id not set" } })
      this.appWs?.close(4500, "internal: no session-id")
      return
    }
    this.appId = msg.appId
    this.appDescription = typeof msg.appDescription === "string" ? msg.appDescription.slice(0, 1024) : ""
    this.agentsMd = msg.agentsMd
    this.tools = validatedTools
    this.toolByRoute.clear()
    for (const t of validatedTools) {
      this.toolByRoute.set(`${t.method} ${t.path}`, t)
    }

    this.send({ type: "register_reply", ok: true, sessionId: this.sessionId })
    if (this.env.DEBUG === "1") console.log(`[DO] registered appId=${this.appId} sessionId=${this.sessionId} tools=${validatedTools.length}`)
  }

  // ── Mint / Revoke / List agent-tokens ─────────────────────────────

  private handleMint(msg: { id: string; label: string }): void {
    if (!this.sessionId) {
      this.send({ type: "mint_agent_token_reply", id: msg.id, ok: false, error: { code: "protocol_error", message: "register first" } })
      return
    }
    if (this.validTokens.size >= MAX_TOKENS_PER_SESSION) {
      this.send({ type: "mint_agent_token_reply", id: msg.id, ok: false, error: { code: "too_many_tokens" } })
      return
    }
    const verifier = generateVerifier()
    const token = makeAgentToken(this.env.TOKEN_PREFIX, this.sessionId, verifier)
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
    const parsed = parseAgentToken(this.env.TOKEN_PREFIX, msg.token)
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
      // Async: app reports the call started; agent should poll /_as_tasks/<id>
      this.tasks.set(msg.taskId, { status: 0, body: undefined, completed: false })
      p.resolve(new Response(JSON.stringify({ taskId: msg.taskId }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      }))
      return
    }

    p.resolve(new Response(
      msg.body !== undefined ? JSON.stringify(msg.body) : "",
      {
        status: msg.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    ))
  }

  private handleTaskComplete(taskId: string, status: number, body: unknown): void {
    this.tasks.set(taskId, { status, body, completed: true })
  }

  // ── HTTP entry ────────────────────────────────────────────────────

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const pathname = url.pathname

    // Debug-only inner path from worker.ts → force-close the WS. Token
    // validation does not apply (the path doesn't follow /v1/t/<token>/...).
    if (this.env.DEBUG === "1" && pathname === "/_as_kill-ws") {
      try { this.appWs?.close(1011, "killed by debug endpoint") } catch {}
      return new Response("ok", { status: 200 })
    }

    // Drain the request body up front. workerd throws an uncaught
    // "Can't read from request stream after response has been sent" error
    // (which destabilizes the DO) if we return a Response without consuming
    // the body. Reading once and reusing avoids that whole class of bugs.
    let body = ""
    try {
      body = await req.text()
    } catch {
      // Body unreadable for some reason (already-consumed, etc) — treat as empty
    }

    // Strip the routing prefix `/v1/t/<token>` to get the user-facing path.
    // Worker entry already validated the token format and routed here.
    const m = pathname.match(/^\/v1\/t\/[^/]+(\/.*)?$/)
    const userPath = m?.[1] ?? "/"

    // App-offline check FIRST — when no app is connected, every request
    // returns the same code regardless of token validity. Avoids leaking
    // session-lifecycle info ("does this token exist anywhere?").
    if (!this.appWs || !this.appId) {
      return errorResponse("app_offline", "no live WS for this session", 503)
    }

    // Token verifier check — re-parse and check against our validTokens set.
    const tokenMatch = pathname.match(/^\/v1\/t\/([^/]+)\//)
    if (!tokenMatch) return errorResponse("not_found", "malformed url", 404)
    const tokenStr = tokenMatch[1]!
    const parsed = parseAgentToken(this.env.TOKEN_PREFIX, tokenStr)
    if (!parsed || parsed.sessionId !== this.sessionId) {
      return errorResponse("token_invalid", "token format or session mismatch", 401)
    }
    if (!this.validTokens.has(parsed.verifier)) {
      return errorResponse("token_invalid", "agent-token unknown or revoked", 401)
    }

    // Reserved meta paths
    if (userPath === "/agents.md") {
      return new Response(this.agentsMd || "", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      })
    }
    if (userPath === "/tools.json") {
      const body = {
        version: "1.0",
        app: {
          id: this.appId,
          name: lookupApp(this.appId ?? "")?.label ?? this.appId,
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
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    if (userPath.startsWith("/_as_tasks/")) {
      const taskId = userPath.slice("/_as_tasks/".length)
      const task = this.tasks.get(taskId)
      if (!task) return errorResponse("not_found", "task unknown", 404)
      if (!task.completed) {
        return new Response(JSON.stringify({ taskId, completed: false }), {
          status: 202,
          headers: { "content-type": "application/json; charset=utf-8" },
        })
      }
      return new Response(JSON.stringify(task.body ?? null), {
        status: task.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    if (userPath.startsWith("/_as_")) {
      return errorResponse("not_found", "unknown internal path", 404)
    }
    // Note: the debug-only kill-ws path is matched at the start of onRequest
    // before token validation, see the early-return below.

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
    // Forward only safe-to-share headers — content-type and any X-* headers.
    for (const [k, v] of req.headers.entries()) {
      const lk = k.toLowerCase()
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
    if (!this.appWs) return false
    try {
      this.appWs.send(JSON.stringify(frame))
      return true
    } catch (e) {
      if (this.env.DEBUG === "1") console.log("[DO] send failed:", e)
      return false
    }
  }
}
