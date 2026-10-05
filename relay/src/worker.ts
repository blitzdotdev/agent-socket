// Worker entry. Routes incoming requests to the right Durable Object.
//
// URL surface:
//   GET  /, /privacy                          → static pages from relay/public (served before the Worker runs)
//   GET  /download                            → latest Chrome extension zip on GitHub releases
//   GET  /_debug/health                       → "ok" (DEBUG=1 only)
//   POST /_debug/kill-ws/<sessionId>          → close that session's WS (DEBUG=1 only)
//   GET  /_debug/state/<sessionId>            → what that session's DO holds (DEBUG=1 only)
//   POST /_debug/evict/<sessionId>            → reset that session's DO (DEBUG=1 only)
//   WSS  /v1/_ws                              → upgrade, route to a fresh session DO (rate-limited per IP)
//   WSS  /v1/_ws?session=<sessionId>          → resume: route to that session's DO, which checks the secret
//   *    /v1/t/<token>/<path>                 → route to existing session DO (no WS upgrades, body ≤ 1 MiB)
//
// The WS upgrade mints a random session-id at the edge and routes to
// idFromName(sessionId); the DO reads it back as `this.name`. A resume names
// its session in ?session=; the session-id is public (it's in every agent
// URL), so the DO only lets the socket in once its first frame proves the
// resume secret.

import { RelayServer } from "./relay-do"
import type { Env } from "./types"
import { SESSION_ID_RE, generateSessionId, parseAgentToken } from "./tokens"
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
      // Resume names its session; otherwise generate a session-id at the
      // edge — or, when DEBUG=1, honor a ?force_session= query param so the
      // harness can drive the "second WS rejected" path. Never honored in prod.
      let sessionId: string
      const resumeParam = url.searchParams.get("session")
      const forceParam = url.searchParams.get("force_session")
      if (resumeParam !== null) {
        if (!SESSION_ID_RE.test(resumeParam)) return errorResponse("protocol_error", "bad session id", 400)
        sessionId = resumeParam
      } else if (env.DEBUG === "1" && forceParam && SESSION_ID_RE.test(forceParam)) {
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
  // Per-session ops, forwarded to the session's DO at /_as_debug/<op>:
  //   POST /_debug/kill-ws/<id>[?end=1|?hold=<ms>]  close the app's WS, leaving
  //        the session resumable (?hold= overrides the hold time for this
  //        drop); ?end=1 ends the session instead.
  //   GET  /_debug/state/<id>   what the DO holds (no secrets): storage keys,
  //        alarm, hold deadline, counts.
  //   POST /_debug/evict/<id>   reset the DO like an eviction or restart:
  //        memory and sockets gone, storage and alarm kept.
  // Drive the harness's reconnect and durability scenarios. Never enabled in prod.
  const m = pathname.match(/^\/_debug\/(kill-ws|state|evict)\/([0-9A-HJKMNP-TV-Z]{8})$/)
  if (m && req.method === (m[1] === "state" ? "GET" : "POST")) {
    const [, op, sessionId] = m
    const innerUrl = new URL(req.url)
    innerUrl.pathname = `/_as_debug/${op}`  // keeps the query
    const stub = env.RELAY.get(env.RELAY.idFromName(sessionId!))
    const res = stub.fetch(new Request(innerUrl.toString(), { method: req.method }))
    // An evicted object fails the request that evicted it.
    return op === "evict" ? res.then(() => new Response("ok"), () => new Response("ok")) : res
  }
  return errorResponse("not_found", "unknown debug path", 404)
}
