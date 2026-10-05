// Worker entry. Routes incoming requests to the right Durable Object.
//
// URL surface:
//   GET  /, /privacy                          → static pages from relay/public (served before the Worker runs)
//   GET  /download                            → latest Chrome extension zip on GitHub releases
//   GET  /_debug/health                       → "ok" (DEBUG=1 only)
//   POST /_debug/kill-ws/<sessionId>          → close that session's WS (DEBUG=1 only)
//   WSS  /v1/_ws                              → upgrade, route to a fresh session DO (rate-limited per IP)
//   *    /v1/t/<token>/<path>                 → route to existing session DO (no WS upgrades, body ≤ 1 MiB)
//
// The WS upgrade mints a random session-id at the edge and routes to
// idFromName(sessionId); the DO reads it back as `this.name`.

import { RelayServer } from "./relay-do"
import type { Env } from "./types"
import { generateSessionId, parseAgentToken } from "./tokens"
import { errorResponse } from "./errors"

export { RelayServer }

const MAX_REQUEST_BODY_BYTES = 1024 * 1024
// GitHub serves the newest release's asset at this URL, so the zip name must stay fixed.
const EXTENSION_DOWNLOAD_URL = "https://github.com/blitzdotdev/agent-socket/releases/latest/download/agent-socket-extension.zip"

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname === "/download") return Response.redirect(EXTENSION_DOWNLOAD_URL, 302)

    // ── Debug endpoints (DEBUG=1 only) ─────────────────────────────
    if (env.DEBUG === "1" && pathname.startsWith("/_debug/")) {
      return await handleDebug(req, env, pathname)
    }

    // ── WS upgrade for app connections ─────────────────────────────
    // Path: /v1/_ws
    if (pathname === "/v1/_ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return errorResponse("protocol_error", "expected ws upgrade", 400)
      }
      const ip = req.headers.get("cf-connecting-ip") ?? ""
      if (!(await env.WS_RATE_LIMIT.limit({ key: ip })).success) {
        return errorResponse("rate_limited", "too many connections from this address", 429)
      }
      // Generate a session-id at the edge — or, when DEBUG=1, honor a
      // ?force_session= query param so the harness can drive the
      // "second WS rejected" path. Never honored in prod.
      let sessionId: string
      const forceParam = url.searchParams.get("force_session")
      if (env.DEBUG === "1" && forceParam && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(forceParam)) {
        sessionId = forceParam
      } else {
        sessionId = generateSessionId()
      }
      return env.RELAY.get(env.RELAY.idFromName(sessionId)).fetch(req)
    }

    // ── Agent HTTPS to a token-scoped path ────────────────────────
    // Path: /v1/t/<agent-token>/<rest>
    // CSRF defense lives inside the DO (relay-do.ts onRequest) so it can
    // skip the gate for read-only meta paths (/agents.md, /tools.json,
    // /_as_tasks/<id>) while still blocking browser-initiated requests
    // to user-defined tool paths.
    const tokenMatch = pathname.match(/^\/v1\/t\/([^/]+)(?:\/|$)/)
    if (tokenMatch) {
      const tokenStr = tokenMatch[1]!
      const parsed = parseAgentToken(tokenStr)
      if (!parsed) return errorResponse("not_found", "bad token format", 404)
      // Only /v1/_ws may open a session's WebSocket. An upgrade here would let
      // anyone holding an agent URL attach to the session as the app.
      if (req.headers.get("upgrade")) {
        return errorResponse("protocol_error", "websocket upgrade only on /v1/_ws", 400)
      }
      // Buffer the body here, capped, so no DO ever holds an agent's request
      // stream: an unread stream left open when the DO responds early (e.g. a
      // junk verifier) throws in workerd and resets the session.
      let body: ArrayBuffer | null = null
      if (req.body) {
        body = await readBodyCapped(req.body, MAX_REQUEST_BODY_BYTES)
        if (!body) return errorResponse("body_too_large", `max ${MAX_REQUEST_BODY_BYTES} bytes`, 413)
      }
      const id = env.RELAY.idFromName(parsed.sessionId)
      return env.RELAY.get(id).fetch(new Request(req, { body }))
    }

    return errorResponse("not_found", "no route", 404)
  },
} satisfies ExportedHandler<Env>

// Returns the body, or null once it exceeds `max` bytes.
async function readBodyCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<ArrayBuffer | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(size)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return buf.buffer
}

// ────────────────────────────────────────────────────────────────────
// Debug endpoints — only when DEBUG=1. Never enabled in prod wrangler.jsonc.
// ────────────────────────────────────────────────────────────────────

async function handleDebug(req: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === "/_debug/health") {
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
  }
  // POST /_debug/kill-ws/<sessionId> — force-closes that session's WS.
  // Drives the harness's reconnect scenarios. Never enabled in prod.
  const km = pathname.match(/^\/_debug\/kill-ws\/([0-9A-HJKMNP-TV-Z]{8})$/)
  if (km && req.method === "POST") {
    const sessionId = km[1]!
    const id = env.RELAY.idFromName(sessionId)
    // Forward to the DO via an internal-only path. Reuses /_as_kill-ws inside
    // the DO so the public agent surface doesn't accidentally hit it.
    const innerUrl = new URL(req.url)
    innerUrl.pathname = "/_as_kill-ws"
    return env.RELAY.get(id).fetch(new Request(innerUrl.toString(), { method: "POST" }))
  }
  return errorResponse("not_found", "unknown debug path", 404)
}
