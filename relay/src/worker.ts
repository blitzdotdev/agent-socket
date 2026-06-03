// Worker entry. Routes incoming requests to the right Durable Object.
//
// URL surface (per design doc §5.2):
//   GET  /_debug/health                       → "ok" (DEBUG=1 only)
//   GET  /_debug/sessions                     → list module-registered sessions (DEBUG=1)
//   POST /_debug/sessions/<id>/kill-ws        → close that session's WS (DEBUG=1)
//   WSS  /v1/_ws                              → upgrade, route to a fresh session DO
//   *    /v1/t/<token>/<path>                 → route to existing session DO
//
// The WS upgrade path is special: we don't yet know the session-id (the
// relay generates it on register). For the WS, we pick a temporary
// routing key by generating a random session-id at the edge — this is
// the same key the DO will return in register_reply. The DO uses
// idFromName(sessionId) to derive a stable name.

import { RelayServer } from "./relay-do"
import type { Env } from "./types"
import { generateSessionId, parseAgentToken, validateTokenPrefix } from "./tokens"
import { errorResponse } from "./errors"
import { lookupApp } from "./apps"
import { PRIVACY_HTML } from "./privacy"

export { RelayServer }

// Validate TOKEN_PREFIX at module-top-level so a misconfigured deploy
// fails fast rather than returning 500 to the first user request.
// (Validated again per-isolate; cheap and reads from `env` which isn't
// available at module scope, hence the lazy first-call check too.)
let prefixValidated = false
function ensurePrefixValid(env: Env): void {
  if (prefixValidated) return
  validateTokenPrefix(env.TOKEN_PREFIX)
  prefixValidated = true
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    ensurePrefixValid(env)
    const url = new URL(req.url)
    const pathname = url.pathname

    // ── Debug endpoints (DEBUG=1 only) ─────────────────────────────
    if (env.DEBUG === "1" && pathname.startsWith("/_debug/")) {
      return await handleDebug(req, env, pathname)
    }

    // ── Privacy policy (required by Chrome Web Store) ─────────────
    if (pathname === "/privacy") {
      return new Response(PRIVACY_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      })
    }

    // ── WS upgrade for app connections ─────────────────────────────
    // Path: /v1/_ws
    // The DO routes by session-id, but we don't have one yet — we mint
    // one here and pass it via a header so the DO knows its own name.
    if (pathname === "/v1/_ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return errorResponse("protocol_error", "expected ws upgrade", 400)
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
      const id = env.RELAY.idFromName(sessionId)
      // Forward the request to the DO. We rewrite the URL so the DO knows
      // its session-id (DOs can't ask "what's my idFromName"). Use a
      // header for clarity.
      const fwd = new Request(req.url, req)
      fwd.headers.set("x-as-session-id", sessionId)
      return env.RELAY.get(id).fetch(fwd)
    }

    // ── Agent HTTPS to a token-scoped path ────────────────────────
    // Path: /v1/t/<agent-token>/<rest>
    const tokenMatch = pathname.match(/^\/v1\/t\/([^/]+)(?:\/|$)/)
    if (tokenMatch) {
      const tokenStr = tokenMatch[1]!
      const parsed = parseAgentToken(env.TOKEN_PREFIX, tokenStr)
      if (!parsed) return errorResponse("not_found", "bad token format", 404)
      const id = env.RELAY.idFromName(parsed.sessionId)
      return env.RELAY.get(id).fetch(req)
    }

    return errorResponse("not_found", "no route", 404)
  },
} satisfies ExportedHandler<Env>

// ────────────────────────────────────────────────────────────────────
// Debug endpoints — only when DEBUG=1. Never enabled in prod wrangler.toml.
// ────────────────────────────────────────────────────────────────────

async function handleDebug(req: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === "/_debug/health") {
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
  }
  if (pathname === "/_debug/apps") {
    const sample = lookupApp("as_app_anon")
    return new Response(JSON.stringify({ as_app_anon: sample }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
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
