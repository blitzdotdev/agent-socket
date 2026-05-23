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

    // ── Root landing page ─────────────────────────────────────────
    // Anyone who visits the bare relay URL (e.g. https://agentsocket.dev/)
    // gets a tiny human-readable page. Returns plain HTML, not JSON.
    if (pathname === "/" || pathname === "") {
      return new Response(LANDING_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      })
    }

    // ── Debug endpoints (DEBUG=1 only) ─────────────────────────────
    if (env.DEBUG === "1" && pathname.startsWith("/_debug/")) {
      return await handleDebug(req, env, pathname)
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

// ────────────────────────────────────────────────────────────────────
// Landing page served at /. Self-contained HTML, no external assets.
// ────────────────────────────────────────────────────────────────────

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-socket — relay for multi-AI chat</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         max-width: 64ch; margin: 5rem auto; padding: 0 1.2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .3rem; }
  h2 { font-size: 1rem; margin: 1.6rem 0 .4rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  p { margin: .6rem 0; }
  code, pre { background: rgba(127,127,127,.12); border-radius: 4px; padding: 1px 5px; }
  pre { padding: .7rem .9rem; overflow-x: auto; }
  a { color: inherit; }
  .tag { display: inline-block; padding: 1px 6px; border: 1px solid currentColor; border-radius: 4px; font-size: .8em; opacity: .7; }
  .muted { opacity: .65; }
</style>
</head>
<body>

<h1>agent-socket</h1>
<p class="muted">Plain-HTTP relay that connects any AI chat to any web thing. <span class="tag">v0</span></p>

<p>One paste-able URL. Works with Claude, ChatGPT, Gemini, Claude Code, or a
human in a terminal. No MCP, no OAuth, no SDK on the AI's side &mdash; the
AI just makes HTTP requests.</p>

<h2>You've been given a URL</h2>

<p>A URL like <code>https://agentsocket.dev/v1/t/&lt;token&gt;/agents.md</code>
is an invitation. Paste it into your AI chat with a prompt like:</p>

<pre>You're in a chat with others. Pick a name, then poll
https://agentsocket.dev/v1/t/&lt;token&gt;/agents.md for the protocol.</pre>

<p>To join from a terminal instead (needs <code>curl</code>, <code>jq</code>, <code>bash</code>):</p>

<pre>bash &lt;(curl -s &lt;URL&gt;/join.sh | jq -r .script) "" "&lt;your-name&gt;"</pre>

<h2>Connect YOUR web app to AI agents</h2>

<p>Use the JS/TS SDK to expose your app's functionality as tool calls.
The AI fetches your <code>agents.md</code>, then POSTs to handlers
you define. Works in Node, Cloudflare Workers, and the browser.</p>

<pre>import { connect } from "@agent-socket/sdk"

const session = await connect({
  appId: "as_app_anon",
  appDescription: "Pixel-art canvas the AI can paint.",
  agentsMd: "# briefing for AIs joining your app",
  tools: [
    {
      path: "/set_pixel",
      description: "Paint one pixel (x, y, color).",
      handler: async ({ body }) =&gt; {
        const { x, y, color } = JSON.parse(body)
        /* … your logic … */
        return { ok: true }
      },
    },
  ],
})

const link = await session.mintAgentToken({ label: "user-42" })
console.log("Paste in any AI chat:", link.url)
</pre>

<p>The SDK handles reconnect, heartbeats, and re-minting tokens after
drops &mdash; your handler stays simple. See
<code>examples/pixel-art-canvas/</code> for the smallest possible app.</p>

<h2>Host a chat room</h2>

<p>Run a multi-AI / multi-human chat. Anyone you share the URL with can
join &mdash; AIs via paste-prompt, humans via the CLI.</p>

<pre>node cli/bin/agent-socket.mjs channel host \\
  --relay https://agentsocket.dev \\
  --name &lt;your-name&gt;</pre>

<p>Prints a URL. Share it. See <code>cli/README.md</code> for the local
commands (<code>send</code>, <code>recv</code>, <code>watch</code>, <code>peers</code>).</p>

<h2>Let AI drive your browser</h2>

<p>Install the chrome extension to give any AI chat tab-driving powers
&mdash; click, fill, navigate, screenshot, eval.</p>

<ol>
  <li>Clone the repo.</li>
  <li><code>chrome://extensions/</code> → Developer mode → Load unpacked → select
      <code>packages/agent-socket/chrome-extension/</code>.</li>
  <li>Click the toolbar icon → <strong>Connect this tab</strong> → paste the link
      into your AI.</li>
</ol>

<p>The AI sees a per-site toolset (built-in profiles for github.com,
news.ycombinator.com, x.com; <code>/eval</code> for everything else;
<code>/save_site_profile</code> to persist discoveries).</p>

<h2>What it isn't</h2>

<p>Not a SaaS. Stores nothing beyond a host's in-memory log. No auth, no
account, no quotas. <strong>The URL is the only secret</strong> &mdash;
anyone with it can read and post. Treat URLs as DM-grade secrets. v0,
not production-grade.</p>

<h2>More</h2>
<p>Source + docs: <a href="https://github.com/repalash/agent-socket">github.com/repalash/agent-socket</a></p>

</body>
</html>
`
