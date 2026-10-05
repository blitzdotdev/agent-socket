// Public SDK types.

export interface Tool {
  /** HTTP method. Defaults to "POST" if omitted. */
  method?: string
  /**
   * URL path including the leading slash. Identifier and routing target.
   * In v0 must be static (no `:id` params).
   */
  path: string
  description: string
  /** Optional JSON Schema describing the request body. */
  input_schema?: unknown
  /**
   * Handler invoked when an agent calls this tool. Body is the agent's
   * raw HTTP body as a string — typically JSON; the handler should parse.
   */
  handler: ToolHandler
}

export interface ToolCallContext {
  method: string
  path: string
  body: string
  headers: Record<string, string>
}

export type ToolResult =
  | {
      status?: number
      body?: unknown
      taskId?: string
      /**
       * Optional response headers. The relay only honors `content-type`
       * in v0 (and only when `body` is a string — the relay sends the
       * string verbatim with the declared content-type). Other headers
       * are accepted-but-ignored; non-string bodies fall back to JSON.
       *
       * Use for tools that serve HTML, plain text, CSV, shell scripts,
       * etc. — anything where the AI's HTTP client needs a specific
       * content-type to render or parse correctly.
       */
      headers?: Record<string, string>
    }
  | unknown  // shorthand: returned value becomes the body with status 200

export type ToolHandler = (ctx: ToolCallContext) => Promise<ToolResult> | ToolResult

export interface ConnectOptions {
  /** Free-form app label, [A-Za-z0-9_.-]{1,64} (e.g. "as_app_anon"); shown in tools.json. */
  appId: string
  /** Markdown briefing served at GET /v1/t/<token>/agents.md. */
  agentsMd: string
  /** Optional 1–3 sentence app description, surfaced in tools.json. */
  appDescription?: string
  tools: Tool[]
  /**
   * Base URL of the relay. Default: "https://agentsocket.dev".
   * Override for self-hosted or local dev.
   * Note: "https://aisocket.dev" is also served by the same Worker.
   */
  baseUrl?: string
  /**
   * When true (default), the SDK auto-reconnects after WS drops. It first
   * resumes the same session, so every agent URL keeps working; only if the
   * relay refuses (the session ended, e.g. the app was away longer than the
   * relay's grace window) does it open a fresh session and re-mint the
   * previously-minted agent-tokens under it, reporting {oldUrl → newUrl} via
   * onSessionChanged.
   * When false, the SDK neither reconnects nor re-mints; onDisconnect
   * (if given) still fires and may call reconnect() itself, which resumes
   * the same way but doesn't re-mint if it lands in a fresh session.
   */
  autoReconnect?: boolean
  /**
   * Resume a session this app opened earlier (e.g. before a page or
   * service-worker restart): pass the `sessionId` and `resumeSecret` it had.
   * If the relay refuses (the session ended), connect() opens a fresh
   * session instead — compare `session.sessionId` to tell. Store the secret
   * only where the session's own agent URLs could be stored.
   */
  resume?: { sessionId: string; secret: string }
  /**
   * Called when the WS drops, and again after each failed reconnect.
   * App decides when (or whether) to reconnect. Not called when the
   * initial connect() fails — that promise rejects instead.
   * Default: exponentialBackoff() (or giveUp with autoReconnect:false).
   */
  onDisconnect?: DisconnectHandler
  /**
   * Called after a reconnect when agent URLs changed: the resume failed and
   * the SDK opened a fresh session (sessionId changed), or it re-minted
   * tokens an earlier interrupted re-mint missed. Not called after a
   * successful resume. tokensRemapped is non-empty only when autoReconnect:true.
   */
  onSessionChanged?: SessionChangedHandler
  /**
   * Called after every successful reconnect, once any re-minting is done.
   * `resumed` is true when the same session (and every agent URL) survived.
   */
  onReconnect?: ReconnectHandler
  /**
   * Optional: heartbeat send interval (ms). Default 25000.
   */
  heartbeatIntervalMs?: number
  /**
   * Optional: max time to wait for a pong before closing as dead (ms).
   * Default 50000.
   */
  heartbeatTimeoutMs?: number
}

export interface DisconnectInfo {
  reason: string
  /**
   * WebSocket close code, when a socket closed: the dropped connection's on
   * the first call, a failed attempt's when its socket closed during the
   * handshake. Absent when an attempt failed otherwise (timeout, network
   * error, register refused).
   */
  code?: number
  /** Attempt number (1 for first reconnect attempt after a drop). */
  attempt: number
  /** Call this to attempt the next reconnect. */
  reconnect: () => void
  /** Call this to give up; SDK won't try to reconnect. */
  giveUp: () => void
}
export type DisconnectHandler = (info: DisconnectInfo) => void | Promise<void>

export interface SessionChangedInfo {
  priorSessionId: string
  sessionId: string
  /**
   * Map of old paste-link URL → new paste-link URL. With autoReconnect:true,
   * the SDK has already re-minted; the app should update any UI showing old URLs.
   * With autoReconnect:false this is empty (SDK didn't re-mint).
   */
  tokensRemapped: Map<string, string>
  /**
   * Why the links changed:
   * - "resume_refused": the relay refused the resume (close 4401). The
   *   session had ended: the app was away longer than the relay's hold
   *   (24 h on agentsocket.dev), or it was ended or lost on the relay. The
   *   relay gives the same answer for a wrong secret.
   * - "replaced": another connection resumed this session with its secret
   *   (close 4410), so the SDK started a fresh one instead of taking it back.
   * - "no_resume_secret": the relay never issued a resume secret, so there
   *   was nothing to resume.
   * - "remint": same session (a resume worked), but links an earlier,
   *   interrupted re-mint missed were minted now.
   */
  reason: SessionChangeReason
  /** The close code behind `reason`: 4401 for "resume_refused", 4410 for "replaced". */
  closeCode?: number
  /**
   * Milliseconds from the last frame the relay sent on the old connection to
   * the moment the new session was registered: roughly how long the app was
   * unreachable (it can overstate a quiet connection by up to one heartbeat
   * interval). Compare with the relay's grace window to tell an outage that
   * outlasted it from a relay restart.
   */
  offlineMs: number
}
export type SessionChangeReason = "resume_refused" | "replaced" | "no_resume_secret" | "remint"
export type SessionChangedHandler = (info: SessionChangedInfo) => void | Promise<void>

export interface ReconnectInfo {
  sessionId: string
  /** True when the reconnect resumed the same session. */
  resumed: boolean
}
export type ReconnectHandler = (info: ReconnectInfo) => void | Promise<void>

export interface AgentToken {
  /** Full agent-token string. Used as the URL secret AND the revoke handle. */
  token: string
  /** Pre-formatted paste URL (host-rewritten). */
  url: string
  label: string
  expiresAt: number | null
}

export interface ListedToken extends AgentToken {
  mintedAt: number
}

/**
 * Public Session interface returned from connect(). Methods are async.
 */
export interface Session {
  /** Current session-id (changes only when a reconnect can't resume). */
  readonly sessionId: string
  /**
   * Secret that lets this app resume the session after a drop (see
   * ConnectOptions.resume). The SDK uses it itself on auto-reconnect; read
   * it only to persist the session across a restart. Anyone holding it and
   * the session-id can take the session over, so treat it like the
   * session's agent URLs. null when there is no session to resume.
   */
  readonly resumeSecret: string | null
  /** Whether the WebSocket is open and the session registered (or resumed). */
  readonly connected: boolean
  /** Mint a new agent-token. */
  mintAgentToken(opts: { label: string }): Promise<AgentToken>
  /** Revoke an agent-token by its full token string. */
  revokeAgentToken(token: string): Promise<{ ok: boolean }>
  /** List currently-active agent-tokens. */
  listAgentTokens(): Promise<ListedToken[]>
  /**
   * Replace the session's tools (and agents.md, if given) without changing
   * any agent URL: the relay serves the new list in tools.json and routes
   * calls to the new handlers. The relay validates the list exactly like
   * connect()'s; if it refuses (e.g. a duplicate or reserved path) this
   * rejects with an Error whose `code` is the relay's error code, and the
   * old tools stay live. Once it resolves, later resumes and fresh sessions
   * register the new set.
   *
   * Calls run one at a time in call order. While disconnected it waits for
   * the reconnect and then applies; it rejects if the session is closed (or
   * onDisconnect gives up) first.
   */
  updateTools(tools: Tool[], agentsMd?: string): Promise<void>
  /**
   * Complete an async task. The handler must have previously returned
   * `{ status: 202, taskId }`. The agent's poll on `<URL>/_as_tasks/<taskId>`
   * will then return the supplied status + body.
   *
   * Fire-and-forget — no reply frame. Throws if the WS is not currently
   * open, or if taskId is missing. Async tasks survive a resumed
   * reconnect but not a fresh session (the relay's task map lives in DO
   * memory); completing a task from a prior session is a no-op on the relay.
   */
  completeTask(taskId: string, result?: { status?: number; body?: unknown; headers?: Record<string, string> }): void
  /**
   * Send a heartbeat ping immediately. No-op if the WS isn't open or
   * there's already a ping in flight. Intended for environments where
   * the runtime can suspend setTimeout-based heartbeats (e.g. Chrome MV3
   * service workers, which use chrome.alarms to wake periodically and
   * call ping() to exercise the WS path).
   */
  ping(): void
  /** Close the WS and give up. */
  close(): void
}
