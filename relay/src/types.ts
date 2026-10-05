// Shared types for the relay. Wire frames + tool definitions + env shape.

export interface Env {
  RELAY: DurableObjectNamespace
  WS_RATE_LIMIT: RateLimit
  MAX_SYNC_TOOL_MS: string
  HEARTBEAT_TIMEOUT_MS: string
  // How long a dropped app's session is held for resume. 0 disables resume.
  RESUME_GRACE_MS?: string
  DEBUG?: string
}

// Tool definition (as sent in the register frame).
// Note: `handler` lives only on the SDK side — the relay never sees it.
export interface ToolDef {
  method?: string  // defaults to "POST" if omitted
  path: string     // must start with "/", static (no path params in v0)
  description: string
  input_schema?: unknown  // JSON Schema, optional
}

// Wire frames — app ↔ relay (both directions)

export type Frame =
  | RegisterFrame
  | ResumeFrame
  | RegisterReplyFrame
  | MintAgentTokenFrame
  | MintAgentTokenReplyFrame
  | RevokeAgentTokenFrame
  | RevokeAgentTokenReplyFrame
  | ListAgentTokensFrame
  | ListAgentTokensReplyFrame
  | UpdateToolsFrame
  | UpdateToolsReplyFrame
  | ToolCallFrame
  | ToolReplyFrame
  | TaskCompleteFrame
  | PingFrame
  | PongFrame
  | EndFrame
  | EndReplyFrame

export interface RegisterFrame {
  type: "register"
  appId: string
  agentsMd: string
  appDescription?: string  // surfaced in tools.json's app.description
  tools: ToolDef[]
}

// Sent as the first frame on /v1/_ws?session=<sessionId> to reattach to a
// session whose socket dropped. Carries a full registration, which replaces
// the old one; tokens and async tasks carry over.
export interface ResumeFrame {
  type: "resume"
  sessionId: string
  secret: string  // register_reply.resumeSecret
  appId: string
  agentsMd: string
  appDescription?: string
  tools: ToolDef[]
  /** Tokens the app revoked while it was offline. */
  revokeTokens?: string[]
}

// Sent as the first frame on /v1/_ws?session=<sessionId> to end a session the
// app can't reach any more (e.g. the user pressed Stop while offline): proves
// the secret like `resume`, then the relay wipes the session at once.
export interface EndFrame {
  type: "end"
  sessionId: string
  secret: string
}

export interface EndReplyFrame {
  type: "end_reply"
  ok: boolean
  /** "resume_failed" (followed by close 4401) for a wrong secret or no session. */
  error?: { code: string; message?: string }
}

export interface RegisterReplyFrame {
  type: "register_reply"
  ok: boolean
  sessionId?: string
  /** On success: present with `resume` to reattach after a drop. */
  resumeSecret?: string
  /** True when this reply answers a `resume`. */
  resumed?: boolean
  /** "resume_failed" (followed by close 4401) when a resume is refused. */
  error?: { code: string; message?: string }
}

export interface MintAgentTokenFrame {
  type: "mint_agent_token"
  id: string
  label: string
}

export interface MintAgentTokenReplyFrame {
  type: "mint_agent_token_reply"
  id: string
  ok?: boolean
  token?: string
  url?: string
  label?: string
  expiresAt?: number | null
  error?: { code: string; message?: string }
}

export interface RevokeAgentTokenFrame {
  type: "revoke_agent_token"
  id: string
  token: string
}

export interface RevokeAgentTokenReplyFrame {
  type: "revoke_agent_token_reply"
  id: string
  ok: boolean
  error?: { code: string; message?: string }
}

export interface ListAgentTokensFrame {
  type: "list_agent_tokens"
  id: string
}

export interface ListAgentTokensReplyFrame {
  type: "list_agent_tokens_reply"
  id: string
  tokens: { token: string; url: string; label: string; mintedAt: number }[]
}

// Replaces the registered tool list (and agents.md, when given) mid-session.
// Validated exactly like register's tools/agentsMd; on any error nothing
// changes. Agent URLs stay the same.
export interface UpdateToolsFrame {
  type: "update_tools"
  id: string
  tools: ToolDef[]
  /** Omit to keep the current agents.md. */
  agentsMd?: string
}

export interface UpdateToolsReplyFrame {
  type: "update_tools_reply"
  id: string
  ok: boolean
  error?: { code: string; message?: string }
}

export interface ToolCallFrame {
  type: "tool_call"
  id: string
  method: string
  path: string
  // body is the agent's raw HTTP body forwarded verbatim as a string.
  // Apps typically `JSON.parse(body)` if their tool expects JSON.
  body: string
  headers: Record<string, string>
}

export interface ToolReplyFrame {
  type: "tool_reply"
  id: string
  status: number
  body?: unknown
  taskId?: string  // present when status === 202 (async)
  /**
   * Optional response headers. v0 only honors `content-type` and only when
   * `body` is a string — the relay sends the string verbatim with that
   * content-type. Any other headers are accepted-but-ignored by v0; bytes
   * (ArrayBuffer/Uint8Array) bodies are NOT yet supported and fall back
   * to JSON encoding.
   */
  headers?: Record<string, string>
}

export interface TaskCompleteFrame {
  type: "task_complete"
  taskId: string
  status: number
  body?: unknown
  /** Same shape as ToolReplyFrame.headers; honored on /_as_tasks/<id> poll. */
  headers?: Record<string, string>
}

export interface PingFrame {
  type: "ping"
  id: string
}

export interface PongFrame {
  type: "pong"
  id: string
}
