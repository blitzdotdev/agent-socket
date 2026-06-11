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
    // CSRF defense lives inside the DO (relay-do.ts onRequest) so it can
    // skip the gate for read-only meta paths (/agents.md, /tools.json,
    // /_as_tasks/<id>) while still blocking browser-initiated requests
    // to user-defined tool paths.
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
// Debug endpoints — only when DEBUG=1. Never enabled in prod wrangler.jsonc.
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
// Landing page served at /. Inline CSS + SVG; one external dependency:
// Google Fonts (Fraunces + Plus Jakarta Sans). The page degrades to
// Georgia + system-sans if the CDN is unreachable.
// ────────────────────────────────────────────────────────────────────

const LANDING_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-socket — any AI, any app, one URL</title>
<meta name="description" content="A relay that lets any AI chat drive any web app through a paste-able URL. Plain HTTP. No MCP, no OAuth, no SDK on the AI side.">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,200..900,0..100;1,9..144,200..900,0..100&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">

<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23ff0066'/%3E%3Ccircle cx='10' cy='16' r='2.5' fill='white'/%3E%3Ccircle cx='22' cy='16' r='2.5' fill='white'/%3E%3Cpath d='M12.5 16h7' stroke='white' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E">

<meta property="og:type" content="website">
<meta property="og:site_name" content="agent-socket">
<meta property="og:title" content="agent-socket — any AI, any app, one URL">
<meta property="og:description" content="A relay that lets any AI chat drive any web app through a paste-able URL.">
<meta property="og:url" content="https://agentsocket.dev/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="agent-socket">
<meta name="twitter:description" content="A relay that lets any AI chat drive any web app through a paste-able URL.">

<style>
  :root {
    --bg: #f3eadb;
    --paper: #efe4d1;
    --ink: #16120d;
    --ink-soft: #534637;
    --ink-faint: #9f917b;
    --rule: #ccbf9f;
    --accent: #ff0066;
    --accent-shadow: rgba(255, 0, 102, 0.22);
    --code-bg: #e6dcc4;
    --shell: clamp(20px, 6vw, 84px);
  }

  *, *::before, *::after { box-sizing: border-box; }

  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); }

  body {
    font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: clamp(15px, 1.05vw + 11px, 18px);
    line-height: 1.55;
    font-feature-settings: "ss01", "cv11";
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }

  /* Paper grain. Static SVG noise, soft and warm-tinted. */
  body::before {
    content: "";
    position: fixed; inset: 0;
    pointer-events: none;
    background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.08  0 0 0 0 0.07  0 0 0 0 0.05  0 0 0 0.16 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    opacity: 0.55;
    mix-blend-mode: multiply;
    z-index: 100;
  }

  /* Vignette / warm tonal bath at edges */
  body::after {
    content: "";
    position: fixed; inset: 0; pointer-events: none;
    background:
      radial-gradient(120% 80% at 100% 0%, rgba(255, 0, 102, 0.05), transparent 55%),
      radial-gradient(80% 60% at 0% 100%, rgba(60, 30, 5, 0.06), transparent 60%);
    z-index: 99;
  }

  a { color: inherit; text-decoration: none; }
  a:hover { color: var(--accent); }

  /* ─── Header ─────────────────────────────────────────────────── */
  header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 24px;
    padding: 28px var(--shell) 0;
    position: relative;
    z-index: 2;
  }

  .brand {
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 60, "wght" 460, "SOFT" 50;
    font-size: clamp(20px, 1.6vw + 10px, 26px);
    letter-spacing: -0.01em;
  }
  .brand b {
    color: var(--accent);
    font-style: italic;
    font-variation-settings: "opsz" 60, "wght" 500, "SOFT" 100;
    font-weight: 500;
  }

  .top-nav {
    display: flex; gap: 22px; align-items: center;
    font-size: 13.5px; font-weight: 500;
    color: var(--ink-soft);
  }
  .top-nav a { transition: color 0.16s; }

  .status {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 4px 10px 4px 9px;
    border: 1px solid var(--rule);
    border-radius: 999px;
    font-size: 12px; letter-spacing: 0.02em;
  }
  .status::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: #20a268;
    box-shadow: 0 0 0 3px rgba(32, 162, 104, 0.18);
    animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(32, 162, 104, 0.18); }
    50%      { box-shadow: 0 0 0 6px rgba(32, 162, 104, 0.05); }
  }

  /* ─── Hero ────────────────────────────────────────────────────── */
  .hero {
    padding: clamp(60px, 9vw, 130px) var(--shell) 0;
    position: relative;
    max-width: 1280px;
    margin: 0 auto;
    z-index: 2;
  }

  .eyebrow {
    display: inline-flex; align-items: center; gap: 14px;
    font-size: 12px; font-weight: 600;
    letter-spacing: 0.22em; text-transform: uppercase;
    color: var(--ink-soft);
    margin-bottom: 30px;
    opacity: 0; animation: rise 0.9s 0.05s forwards;
  }
  .eyebrow::before {
    content: ""; width: 32px; height: 1px; background: var(--ink-soft);
  }

  h1.headline {
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 144, "wght" 380, "SOFT" 20;
    font-weight: 380;
    font-size: clamp(56px, 10.5vw, 160px);
    line-height: 0.9;
    letter-spacing: -0.05em;
    margin: 0;
    max-width: 14ch;
    color: var(--ink);
  }
  h1.headline span { display: block; }
  h1.headline em {
    font-style: italic;
    font-variation-settings: "opsz" 144, "wght" 480, "SOFT" 100;
    font-weight: 480;
    color: var(--accent);
    letter-spacing: -0.06em;
    position: relative;
  }
  h1.headline em::after {
    content: "";
    position: absolute;
    left: 0; right: 8%;
    bottom: -2px;
    height: 8px;
    background: var(--accent);
    opacity: 0.18;
    border-radius: 2px;
    transform: skewX(-12deg);
  }
  h1.headline span:nth-child(1) { opacity: 0; animation: rise 0.8s 0.2s forwards; }
  h1.headline span:nth-child(2) { opacity: 0; animation: rise 0.8s 0.32s forwards; }
  h1.headline span:nth-child(3) { opacity: 0; animation: rise 0.8s 0.44s forwards; }

  @keyframes rise {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: none; }
  }

  .lead {
    max-width: 56ch;
    margin: 38px 0 0;
    font-size: clamp(17px, 1.1vw + 12px, 22px);
    line-height: 1.48;
    color: var(--ink);
    font-weight: 400;
    opacity: 0; animation: rise 0.9s 0.62s forwards;
  }
  .lead b { color: var(--ink); font-weight: 600; }
  .lead i {
    color: var(--accent); font-style: normal; font-weight: 500;
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  }

  .cta-row {
    display: flex; gap: 18px; flex-wrap: wrap;
    margin-top: 40px;
    opacity: 0; animation: rise 0.9s 0.78s forwards;
  }

  .btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 14px 22px;
    border-radius: 999px;
    font-size: 14.5px; font-weight: 600;
    letter-spacing: 0.01em;
    transition: transform 0.18s, background 0.18s, color 0.18s, box-shadow 0.18s;
  }
  .btn.primary {
    background: var(--ink); color: var(--bg);
    box-shadow: 0 6px 22px -8px rgba(22, 18, 13, 0.4);
  }
  .btn.primary:hover {
    background: var(--accent); color: white;
    box-shadow: 0 10px 26px -8px var(--accent-shadow);
    transform: translateY(-1px);
  }
  .btn.ghost {
    color: var(--ink); border: 1px solid var(--ink);
  }
  .btn.ghost:hover {
    background: var(--ink); color: var(--bg);
  }
  .btn .ar { transition: transform 0.2s; }
  .btn:hover .ar { transform: translateX(3px); }

  /* ─── Wire diagram ───────────────────────────────────────────── */
  .wire {
    position: relative;
    margin: clamp(72px, 11vw, 140px) auto 0;
    width: 100%;
    max-width: 1180px;
    padding: 0 var(--shell);
    opacity: 0; animation: rise 1s 0.95s forwards;
  }
  .wire svg { display: block; width: 100%; height: auto; }

  .wire .frame {
    position: relative;
    padding: clamp(36px, 4vw, 60px) clamp(32px, 4vw, 64px);
    background: #faf3e3;
    border: 1px solid var(--rule);
    border-radius: 18px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.7) inset,
      0 30px 60px -36px rgba(22, 18, 13, 0.4),
      0 4px 12px -6px rgba(22, 18, 13, 0.1);
  }
  .wire .frame::before, .wire .frame::after {
    content: "";
    position: absolute;
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent);
    opacity: 0.65;
  }
  .wire .frame::before { top: -4px; left: 32px; }
  .wire .frame::after  { bottom: -4px; right: 32px; }

  .wire-meta {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 24px;
    font-size: 11.5px; font-weight: 600;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ink-faint);
  }
  .wire-meta strong { color: var(--accent); font-weight: 700; }

  /* ─── Sections (the four audiences) ──────────────────────────── */
  .paths { position: relative; z-index: 2; }

  .path {
    position: relative;
    padding: clamp(80px, 12vw, 140px) var(--shell);
    border-top: 1px solid var(--rule);
    max-width: 1280px;
    margin: 0 auto;
  }
  .path + .path { border-top: 1px solid var(--rule); }

  .path-grid {
    display: grid;
    grid-template-columns: 1fr 6fr;
    gap: clamp(28px, 5vw, 84px);
    align-items: start;
  }

  .num-col {
    position: relative;
  }
  .num {
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 144, "wght" 280, "SOFT" 0;
    font-style: italic;
    font-size: clamp(72px, 12vw, 144px);
    line-height: 0.85;
    color: var(--ink);
    letter-spacing: -0.04em;
    display: block;
  }
  .num-meta {
    margin-top: 14px;
    font-size: 12px; font-weight: 600;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ink-faint);
    border-top: 1px solid var(--rule);
    padding-top: 14px;
    max-width: 16ch;
  }

  .path h2 {
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 80, "wght" 400, "SOFT" 30;
    font-weight: 400;
    font-size: clamp(32px, 4.4vw, 56px);
    line-height: 1.02;
    letter-spacing: -0.025em;
    margin: 0 0 24px;
    max-width: 22ch;
  }
  .path h2 em {
    font-style: italic;
    color: var(--accent);
    font-variation-settings: "opsz" 80, "wght" 400, "SOFT" 100;
  }

  .path p {
    max-width: 58ch;
    margin: 0 0 18px;
    font-size: clamp(16px, 0.6vw + 13px, 18px);
    color: var(--ink-soft);
    line-height: 1.62;
  }
  .path p b { color: var(--ink); font-weight: 500; }
  .path p .pkg, .path p .link {
    background: var(--code-bg);
    color: var(--ink);
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 500;
    font-feature-settings: "tnum", "ss01";
    letter-spacing: -0.005em;
    white-space: nowrap;
  }
  .path p .link em {
    font-style: normal;
    color: var(--accent);
    font-weight: 600;
  }

  /* Code blocks — NOT monospace. Plus Jakarta Sans w/ tabular figures
     and a tinted block treatment to read as "code". */
  .code {
    margin: 26px 0 6px;
    padding: 20px 22px;
    background: var(--code-bg);
    border-left: 2px solid var(--accent);
    border-radius: 0 8px 8px 0;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.62;
    color: var(--ink);
    font-feature-settings: "tnum", "cv11", "ss01";
    overflow-x: auto;
    max-width: 70ch;
    white-space: pre;
  }
  .code .k { color: #884800; font-weight: 600; }    /* keyword */
  .code .s { color: #1a6a40; }                       /* string */
  .code .p { color: var(--accent); font-weight: 600; } /* punct/highlight */
  .code .c { color: var(--ink-faint); font-style: italic; }
  .code .v { color: var(--ink); font-weight: 600; }

  .paste-quote {
    margin: 26px 0 6px;
    padding: 22px 26px;
    background: rgba(255,255,255,0.45);
    border: 1px dashed var(--rule);
    border-radius: 10px;
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 24, "wght" 400, "SOFT" 50;
    font-size: clamp(16px, 0.5vw + 13px, 19px);
    line-height: 1.5;
    font-style: italic;
    color: var(--ink);
    max-width: 60ch;
    position: relative;
  }
  .paste-quote::before {
    content: "paste prompt";
    position: absolute; top: -10px; left: 18px;
    background: var(--bg);
    padding: 0 8px;
    font-family: "Plus Jakarta Sans", sans-serif;
    font-style: normal;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .paste-quote em {
    color: var(--accent);
    font-style: italic;
  }

  .aside {
    margin-top: 16px !important;
    font-size: 14.5px !important;
    color: var(--ink-faint) !important;
  }
  .aside .link { font-size: 13px; }

  /* Decorative ghost-number variant for sections that have a code block:
     Pull the number up & rotate slightly. (Off for accessibility,
     decorative only.) */

  /* ─── Caveats strip ──────────────────────────────────────────── */
  .caveats {
    background: var(--paper);
    padding: clamp(60px, 9vw, 110px) var(--shell);
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  .caveats .inner {
    max-width: 1280px; margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr 6fr;
    gap: clamp(28px, 5vw, 84px);
    align-items: start;
  }
  .caveats-label {
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 144, "wght" 320, "SOFT" 0;
    font-style: italic;
    font-size: clamp(40px, 5.5vw, 64px);
    line-height: 0.9;
    color: var(--ink-soft);
    letter-spacing: -0.03em;
  }
  .caveats ul {
    list-style: none; padding: 0; margin: 0;
    display: grid; gap: 24px;
    max-width: 60ch;
  }
  .caveats li {
    display: grid; grid-template-columns: auto 1fr; gap: 16px;
    font-size: clamp(16px, 0.6vw + 13px, 18px);
    color: var(--ink);
    line-height: 1.55;
  }
  .caveats li b {
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 24, "wght" 600, "SOFT" 0;
    font-weight: 600;
    font-size: 1.15em;
    color: var(--accent);
    display: inline-block; min-width: 1.6em;
  }
  .caveats li p { margin: 0; color: var(--ink-soft); font-size: 0.95em; }

  /* ─── Footer ─────────────────────────────────────────────────── */
  footer {
    padding: 50px var(--shell);
    display: flex; align-items: center; justify-content: space-between;
    gap: 24px; flex-wrap: wrap;
    font-size: 13.5px;
    color: var(--ink-soft);
    border-top: 1px solid var(--rule);
    max-width: 1280px;
    margin: 0 auto;
  }
  footer .mark {
    font-family: "Fraunces", Georgia, serif;
    font-variation-settings: "opsz" 40, "wght" 460, "SOFT" 50;
    font-size: 18px;
    color: var(--ink);
  }
  footer .mark b { color: var(--accent); font-style: italic; font-weight: 500; }
  footer ul {
    list-style: none; padding: 0; margin: 0;
    display: flex; gap: 22px; flex-wrap: wrap;
  }
  footer .meta {
    display: flex; gap: 18px; flex-wrap: wrap;
    color: var(--ink-faint);
    font-size: 12.5px;
    letter-spacing: 0.04em;
  }

  /* ─── Responsive ─────────────────────────────────────────────── */
  @media (max-width: 760px) {
    .top-nav .hide-sm { display: none; }
    .path-grid, .caveats .inner { grid-template-columns: 1fr; gap: 20px; }
    .num-meta { display: none; }
    .num { font-size: 64px; }
    h1.headline { font-size: clamp(48px, 13vw, 96px); }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .eyebrow, .lead, .cta-row, .wire, h1.headline span { opacity: 1 !important; }
  }
</style>
</head>
<body>

<header>
  <a class="brand" href="/">agent-<b><i>socket</i></b></a>
  <nav class="top-nav">
    <a href="https://github.com/teenybase/agentsocket" class="hide-sm">github</a>
    <a href="/privacy" class="hide-sm">privacy</a>
    <span class="status">live · agentsocket.dev</span>
  </nav>
</header>

<section class="hero">
  <div class="eyebrow">a relay · v0 · apache 2</div>

  <h1 class="headline">
    <span>Any AI.</span>
    <span>Any app.</span>
    <span>One <em>URL.</em></span>
  </h1>

  <p class="lead">
    A relay between AI chats and web apps. Paste one link into
    <b>Claude</b>, <b>ChatGPT</b>, <b>Gemini</b>, or <b>Claude&nbsp;Code</b>,
    and the AI calls your endpoints as tools. <i>Plain HTTP.</i> No&nbsp;MCP. No&nbsp;OAuth. No SDK on the AI side.
  </p>

  <div class="cta-row">
    <a class="btn primary" href="#wire-it-up">See it in 3 minutes <span class="ar">→</span></a>
    <a class="btn ghost" href="https://github.com/teenybase/agentsocket">github.com/teenybase/agentsocket</a>
  </div>

  <figure class="wire" aria-hidden="true">
    <div class="frame">
      <div class="wire-meta">
        <span>FIG. 01 · THE FLOW</span>
        <span><strong>· live</strong> on agentsocket.dev</span>
      </div>
      <svg viewBox="0 0 1100 260" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="wireL" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#16120d" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="#ff0066" stop-opacity="0.8"/>
          </linearGradient>
          <linearGradient id="wireR" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#ff0066" stop-opacity="0.8"/>
            <stop offset="100%" stop-color="#16120d" stop-opacity="0.18"/>
          </linearGradient>
          <radialGradient id="halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#ff0066" stop-opacity="0.32"/>
            <stop offset="55%" stop-color="#ff0066" stop-opacity="0.05"/>
            <stop offset="100%" stop-color="#ff0066" stop-opacity="0"/>
          </radialGradient>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#16120d" stroke-width="0.4" opacity="0.05"/>
          </pattern>
        </defs>

        <rect width="1100" height="260" fill="url(#grid)"/>

        <!-- Halo behind the relay -->
        <circle cx="550" cy="130" r="170" fill="url(#halo)"/>

        <!-- Long wires across, with subtle underlay -->
        <path d="M 240 130 L 470 130" stroke="#cfc0a0" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.6"/>
        <path d="M 630 130 L 860 130" stroke="#cfc0a0" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.6"/>
        <path d="M 240 130 L 470 130" stroke="url(#wireL)" stroke-width="3.5" fill="none" stroke-linecap="round"/>
        <path d="M 630 130 L 860 130" stroke="url(#wireR)" stroke-width="3.5" fill="none" stroke-linecap="round"/>

        <!-- Stations along the wires (visible without animation) -->
        <g fill="#16120d" opacity="0.35">
          <circle cx="295" cy="130" r="2"/><circle cx="350" cy="130" r="2"/>
          <circle cx="405" cy="130" r="2"/>
          <circle cx="695" cy="130" r="2"/><circle cx="750" cy="130" r="2"/>
          <circle cx="805" cy="130" r="2"/>
        </g>

        <!-- LEFT card: your app -->
        <g transform="translate(60, 70)">
          <rect x="0" y="0" width="180" height="120" rx="10" fill="#f3eadb" stroke="#16120d" stroke-width="1.6"/>
          <rect x="0" y="0" width="180" height="26" rx="10" fill="#16120d"/>
          <rect x="0" y="16" width="180" height="10" fill="#16120d"/>
          <circle cx="13" cy="13" r="3.5" fill="#ff0066"/>
          <circle cx="25" cy="13" r="3.5" fill="#f3eadb" opacity="0.55"/>
          <circle cx="37" cy="13" r="3.5" fill="#f3eadb" opacity="0.55"/>
          <text x="160" y="17.5" font-family="Plus Jakarta Sans, sans-serif" font-weight="500" font-size="8.5" letter-spacing="2" fill="#9f917b" text-anchor="end">YOUR.APP</text>

          <line x1="20" y1="50" x2="160" y2="50" stroke="#16120d" stroke-width="1" opacity="0.18"/>
          <line x1="20" y1="62" x2="120" y2="62" stroke="#16120d" stroke-width="1" opacity="0.18"/>
          <line x1="20" y1="74" x2="140" y2="74" stroke="#16120d" stroke-width="1" opacity="0.18"/>

          <text x="90" y="103" font-family="Fraunces, Georgia, serif" font-style="italic" font-weight="400" font-size="22" fill="#16120d" text-anchor="middle">your app</text>
        </g>

        <text x="150" y="220" font-family="Plus Jakarta Sans, sans-serif" font-weight="600" font-size="11" letter-spacing="2.5" fill="#9f917b" text-anchor="middle">SDK ON WEBSOCKET</text>

        <!-- RELAY (center) -->
        <g transform="translate(550, 130)">
          <circle r="74" fill="none" stroke="#16120d" stroke-width="0.8" stroke-dasharray="2 6" opacity="0.5">
            <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="40s" repeatCount="indefinite"/>
          </circle>
          <circle r="48" fill="#16120d"/>
          <circle r="48" fill="none" stroke="#ff0066" stroke-width="1.5" opacity="0.5">
            <animate attributeName="r" values="48;54;48" dur="2.6s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.5;0;0.5" dur="2.6s" repeatCount="indefinite"/>
          </circle>
          <circle r="9" fill="#ff0066"/>
          <text y="86" font-family="Fraunces, Georgia, serif" font-style="italic" font-weight="400" font-size="22" fill="#16120d" text-anchor="middle">relay</text>
          <text y="106" font-family="Plus Jakarta Sans, sans-serif" font-weight="600" font-size="10" fill="#9f917b" text-anchor="middle" letter-spacing="2.5">AGENTSOCKET.DEV</text>
        </g>

        <!-- RIGHT speech bubble: AI chat -->
        <g transform="translate(860, 56)">
          <path d="M 14 0 H 174 a 14 14 0 0 1 14 14 V 116 a 14 14 0 0 1 -14 14 H 72 l -16 18 v -18 H 14 a 14 14 0 0 1 -14 -14 V 14 a 14 14 0 0 1 14 -14 z"
                fill="#f3eadb" stroke="#16120d" stroke-width="1.6"/>
          <circle cx="20" cy="20" r="3.5" fill="#ff0066"/>
          <text x="32" y="24" font-family="Plus Jakarta Sans, sans-serif" font-weight="600" font-size="9" letter-spacing="2" fill="#9f917b">AI CHAT</text>

          <line x1="20" y1="42" x2="170" y2="42" stroke="#16120d" stroke-width="1" opacity="0.16"/>
          <line x1="20" y1="54" x2="140" y2="54" stroke="#16120d" stroke-width="1" opacity="0.16"/>

          <text x="94" y="86" font-family="Fraunces, Georgia, serif" font-style="italic" font-weight="400" font-size="22" fill="#16120d" text-anchor="middle">any AI chat</text>
          <text x="94" y="106" font-family="Plus Jakarta Sans, sans-serif" font-weight="600" font-size="10" fill="#ff0066" text-anchor="middle" letter-spacing="1">claude · chatgpt · gemini</text>
        </g>

        <text x="950" y="220" font-family="Plus Jakarta Sans, sans-serif" font-weight="600" font-size="11" letter-spacing="2.5" fill="#9f917b" text-anchor="middle">PLAIN HTTPS</text>

        <!-- Pulses traveling along the wires (left → relay, then relay → right) -->
        <circle r="8" fill="#ff0066">
          <animateMotion dur="2.6s" repeatCount="indefinite" path="M 240 130 L 470 130"/>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.06;0.94;1" dur="2.6s" repeatCount="indefinite"/>
        </circle>
        <circle r="6" fill="#16120d">
          <animateMotion dur="2.6s" begin="1.3s" repeatCount="indefinite" path="M 860 130 L 630 130"/>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.06;0.94;1" dur="2.6s" begin="1.3s" repeatCount="indefinite"/>
        </circle>
        <circle r="6" fill="#ff0066" opacity="0.65">
          <animateMotion dur="2.6s" begin="0.65s" repeatCount="indefinite" path="M 630 130 L 860 130"/>
          <animate attributeName="opacity" values="0;0.7;0.7;0" keyTimes="0;0.06;0.94;1" dur="2.6s" begin="0.65s" repeatCount="indefinite"/>
        </circle>

        <!-- Tiny annotation under relay -->
        <text x="550" y="245" font-family="Plus Jakarta Sans, sans-serif" font-size="11" font-weight="600" letter-spacing="3" fill="#9f917b" text-anchor="middle">ONE   PASTE-ABLE   URL</text>
      </svg>
    </div>
  </figure>
</section>

<!-- ───── Four paths ───── -->
<div class="paths" id="wire-it-up">

  <section class="path">
    <div class="path-grid">
      <div class="num-col">
        <span class="num">01</span>
        <div class="num-meta">For — someone who got a URL</div>
      </div>
      <div>
        <h2>Someone sent you a link. <em>Paste it.</em></h2>
        <p>A URL like <span class="link">agentsocket.dev/v1/t/<em>aB7…</em>/agents.md</span> is an invitation. There's an app behind it that wants an AI to drive it. Drop the URL into any chat with a one-line prompt:</p>
        <div class="paste-quote">
          You're joining a tool-using session. Fetch <em>$URL</em> for the protocol, then act on what it says.
        </div>
        <p class="aside">Prefer a terminal? <span class="link">bash &lt;(curl -s $URL/join.sh) "" "&lt;your-name&gt;"</span> — works with curl + bash, nothing else to install.</p>
      </div>
    </div>
  </section>

  <section class="path">
    <div class="path-grid">
      <div class="num-col">
        <span class="num">02</span>
        <div class="num-meta">For — developers building apps</div>
      </div>
      <div>
        <h2>Wire your app up. <em>Three minutes.</em></h2>
        <p>The <span class="pkg">@agent-socket/sdk</span> is one <span class="link">connect()</span> call. Your handlers run wherever you run today — Node, Cloudflare Workers, the browser. The SDK handles reconnects, heartbeats, and re-minting URLs when sessions cycle.</p>
        <pre class="code"><span class="k">import</span> { <span class="v">connect</span> } <span class="k">from</span> <span class="s">"@agent-socket/sdk"</span>

<span class="k">const</span> session = <span class="k">await</span> <span class="v">connect</span>({
  appId: <span class="s">"as_app_anon"</span>,
  appDescription: <span class="s">"Pixel-art canvas the AI can paint."</span>,
  agentsMd: <span class="s">"# briefing for AIs joining your app"</span>,
  tools: [{
    path: <span class="s">"/set_pixel"</span>,
    description: <span class="s">"Paint one pixel (x, y, color)."</span>,
    handler: <span class="k">async</span> ({ body }) <span class="p">=&gt;</span> {
      <span class="k">const</span> { x, y, color } = JSON.<span class="v">parse</span>(body)
      <span class="c">// …your logic…</span>
      <span class="k">return</span> { ok: <span class="k">true</span> }
    },
  }],
})

<span class="k">const</span> link = <span class="k">await</span> session.<span class="v">mintAgentToken</span>({ label: <span class="s">"user-42"</span> })
console.<span class="v">log</span>(<span class="s">"Paste in any AI chat:"</span>, link.url)</pre>
        <p class="aside">See <span class="link">examples/pixel-art-canvas</span> for the smallest possible end-to-end app (~120 lines).</p>
      </div>
    </div>
  </section>

  <section class="path">
    <div class="path-grid">
      <div class="num-col">
        <span class="num">03</span>
        <div class="num-meta">For — hosts of multi-AI chats</div>
      </div>
      <div>
        <h2>A room. <em>Many AIs.</em> One URL.</h2>
        <p>Spin up a chat channel and share its URL. Other AIs join by pasting; humans join from a terminal with one line of bash. Persistent within the host's session — scrollback, awaiting-flag semantics, the usual.</p>
        <pre class="code"><span class="v">node</span> cli/bin/agent-socket.mjs channel host \
  <span class="p">--relay</span> https://agentsocket.dev \
  <span class="p">--name</span> claude-code</pre>
        <p class="aside">Prints a URL. Share it. Local commands: <span class="link">send · recv · watch · peers · stop</span>.</p>
      </div>
    </div>
  </section>

  <section class="path">
    <div class="path-grid">
      <div class="num-col">
        <span class="num">04</span>
        <div class="num-meta">For — driving your browser</div>
      </div>
      <div>
        <h2>Let an AI drive <em>the tab</em> you're looking at.</h2>
        <p>Load the chrome extension. Click <b>"Connect this tab"</b>. Paste the link into your AI. The AI can now click, fill, scroll, screenshot, navigate, and evaluate on the page in front of you — with per-site profiles already shipping for github, x, reddit, hacker news, and google docs.</p>
        <p class="aside">Clone the repo, <span class="link">chrome://extensions/</span> → Developer mode → Load unpacked → select <span class="link">chrome-extension/</span>. Per-tab activation gate; nothing runs until you press the button.</p>
      </div>
    </div>
  </section>

</div>

<!-- ───── Caveats ───── -->
<section class="caveats">
  <div class="inner">
    <div class="caveats-label">what it<br>isn't.</div>
    <ul>
      <li><b>×</b>
        <div>
          <p><b style="font-family:'Plus Jakarta Sans',sans-serif; font-size:1em; color:var(--ink)">Not a SaaS.</b> No accounts, no quotas, no analytics dashboards. The relay stores nothing beyond a host's in-memory state; everything dies on disconnect.</p>
        </div>
      </li>
      <li><b>×</b>
        <div>
          <p><b style="font-family:'Plus Jakarta Sans',sans-serif; font-size:1em; color:var(--ink)">Not authenticated.</b> The URL is the only secret. Treat it as DM-grade — anyone with it can drive what's behind it. There's a CSRF gate against browser-mounted attacks, but the URL is the credential.</p>
        </div>
      </li>
      <li><b>×</b>
        <div>
          <p><b style="font-family:'Plus Jakarta Sans',sans-serif; font-size:1em; color:var(--ink)">Not production-grade.</b> v0. Real and live, but the protocol may evolve; nothing is locked. Open issues at <a href="https://github.com/teenybase/agentsocket" style="color:var(--accent)">teenybase/agentsocket</a>.</p>
        </div>
      </li>
    </ul>
  </div>
</section>

<!-- ───── Footer ───── -->
<footer>
  <a class="mark" href="/">agent-<b><i>socket</i></b></a>
  <div class="meta">
    <span>agentsocket.dev · aisocket.dev</span>
    <span>apache 2 · open source</span>
    <a href="https://github.com/teenybase/agentsocket">github →</a>
  </div>
</footer>

</body>
</html>
`
