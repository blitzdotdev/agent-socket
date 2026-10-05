// Standard error response builder. Per §5.2: all non-2xx responses share
// the body shape `{ error: { code, message } }`.

export type ErrorCode =
  | "token_invalid"
  | "app_offline"
  | "tool_timeout"
  | "too_many_inflight"
  | "too_many_tokens"
  | "invalid_app_id"
  | "rate_limited"
  | "not_found"
  | "reserved_path"
  | "agents_md_too_large"
  | "protocol_error"
  | "internal_error"
  | "csrf_denied"
  | "too_many_tasks"
  | "body_too_large"

export function errorResponse(code: ErrorCode, message: string, status: number, headers?: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        ...headers,
      },
    },
  )
}
