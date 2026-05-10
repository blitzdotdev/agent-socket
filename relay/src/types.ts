// Shared types for the relay. Wire frames + tool definitions + env shape.

export interface Env {
  RELAY: DurableObjectNamespace
  TOKEN_PREFIX: string
  MAX_SYNC_TOOL_MS: string
  HEARTBEAT_INTERVAL_MS: string
  HEARTBEAT_TIMEOUT_MS: string
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

// App entry from apps.json
export interface AppEntry {
  allowedOrigins: string[]  // exact origins or "*"
  label: string
}

export type AppsRegistry = Record<string, AppEntry>

// Wire frames — app ↔ relay (both directions)

export type Frame =
  | RegisterFrame
  | RegisterReplyFrame
  | MintAgentTokenFrame
  | MintAgentTokenReplyFrame
  | RevokeAgentTokenFrame
  | RevokeAgentTokenReplyFrame
  | ListAgentTokensFrame
  | ListAgentTokensReplyFrame
  | ToolCallFrame
  | ToolReplyFrame
  | TaskCompleteFrame
  | PingFrame
  | PongFrame

export interface RegisterFrame {
  type: "register"
  appId: string
  agentsMd: string
  tools: ToolDef[]
}

export interface RegisterReplyFrame {
  type: "register_reply"
  ok: boolean
  sessionId?: string
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

export interface ToolCallFrame {
  type: "tool_call"
  id: string
  method: string
  path: string
  body: string
  headers: Record<string, string>
}

export interface ToolReplyFrame {
  type: "tool_reply"
  id: string
  status: number
  body?: unknown
  taskId?: string  // present when status === 202 (async)
}

export interface TaskCompleteFrame {
  type: "task_complete"
  taskId: string
  status: number
  body?: unknown
}

export interface PingFrame {
  type: "ping"
  id: string
}

export interface PongFrame {
  type: "pong"
  id: string
}
