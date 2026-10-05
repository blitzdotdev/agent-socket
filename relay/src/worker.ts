// Worker entry. Routes incoming requests to the right Durable Object.
//
// URL surface (per design doc §5.2):
//   GET  /_debug/health                       → "ok" (DEBUG=1 only)
//   GET  /_debug/sessions                     → list module-registered sessions (DEBUG=1)
//   POST /_debug/sessions/<id>/kill-ws        → close that session's WS (DEBUG=1)
//   WSS  /v1/_ws                              → upgrade, route to a fresh session DO
//   *    /v1/t/<token>/<path>                 → route to existing session DO (no WS upgrades)
//
// The WS upgrade mints a random session-id at the edge and routes to
// idFromName(sessionId); the DO reads it back as `this.name`.

import { RelayServer } from "./relay-do"
import type { Env } from "./types"
import { generateSessionId, parseAgentToken } from "./tokens"
import { errorResponse } from "./errors"
import { PRIVACY_HTML } from "./privacy"

export { RelayServer }

const MAX_REQUEST_BODY_BYTES = 1024 * 1024

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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

// ────────────────────────────────────────────────────────────────────
// Landing page served at /. Inline CSS, single external dependency:
// Google Fonts (Geist). Degrades to system-sans if the CDN is
// unreachable.
// ────────────────────────────────────────────────────────────────────

const LANDING_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-socket — a relay between AI chats and web apps</title>
<meta name="description" content="A relay that lets any AI chat drive any web app over plain HTTPS. Paste a URL into Claude, ChatGPT, Gemini, or Claude Code. No MCP, no OAuth, no SDK on the AI side.">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&display=swap">

<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23ff0066'/%3E%3Ccircle cx='10' cy='16' r='2.5' fill='white'/%3E%3Ccircle cx='22' cy='16' r='2.5' fill='white'/%3E%3Cpath d='M12.5 16h7' stroke='white' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E">

<meta property="og:type" content="website">
<meta property="og:site_name" content="agent-socket">
<meta property="og:title" content="agent-socket">
<meta property="og:description" content="A relay between AI chats and web apps. Plain HTTPS. No MCP, no OAuth.">
<meta property="og:url" content="https://agentsocket.dev/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="agent-socket">
<meta name="twitter:description" content="A relay between AI chats and web apps. Plain HTTPS. No MCP, no OAuth.">

<style>
  :root {
    --bg: #0a0b0d;
    --bg-elev: #14161a;
    --fg: #e7e7ea;
    --fg-2: #b3b3b8;
    --fg-3: #71727a;
    --fg-4: #4a4b53;
    --rule: #232629;
    --rule-hi: #2e3138;
    --accent: #ff2674;
    --accent-glow: rgba(255, 38, 116, 0.18);
    --code-bg: #111317;
    --shell: clamp(20px, 5vw, 56px);
    --maxw: 1200px;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html { color-scheme: dark; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  html { max-width: 100vw; overflow-x: hidden; }

  body {
    font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 15.5px;
    line-height: 1.55;
    font-feature-settings: "cv11", "ss01", "ss03";
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
    position: relative;
    max-width: 100vw;
  }

  /* Critical: long unbreakable strings (URLs, code) propagate
     min-content-width up the DOM and make the page wider than the
     viewport on mobile. Force min-width: 0 on layout containers
     and let inner code blocks scroll horizontally on their own. */
  .topbar-inner, .hero, .demo, .demo-frame, .sect, .sect-grid > *,
  .caveats, .caveats-inner, footer, .footer-inner {
    min-width: 0;
    max-width: 100%;
  }
  .demo, .sect, .caveats, footer { max-width: var(--maxw); }
  .demo-body, .code, .quote { min-width: 0; }

  ::selection { background: var(--accent); color: white; }

  /* ─── Ambient background ─────────────────────────────────────
     Engineering / instrument-panel feel — no atmospheric blobs.
     Static dot grid + four corner fiducial registration marks
     (the print/CAD `+` symbols), plus a single 1px hairline
     that sweeps top → bottom every 18s. Reads as "live
     instrument", not "AI gradient art". */
  .bg {
    pointer-events: none;
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    background-image:
      radial-gradient(circle at center, rgba(255, 255, 255, 0.035) 1px, transparent 1.4px);
    background-size: 30px 30px;
  }
  .bg .fid {
    position: absolute;
    width: 14px; height: 14px;
    opacity: 0.18;
  }
  .bg .fid::before, .bg .fid::after {
    content: "";
    position: absolute;
    background: var(--fg-3);
  }
  .bg .fid::before { top: 50%; left: 0; right: 0; height: 1px; transform: translateY(-50%); }
  .bg .fid::after  { left: 50%; top: 0; bottom: 0; width: 1px; transform: translateX(-50%); }
  .bg .fid.tl { top: 18px; left: 18px; }
  .bg .fid.tr { top: 18px; right: 18px; }
  .bg .fid.bl { bottom: 18px; left: 18px; }
  .bg .fid.br { bottom: 18px; right: 18px; }
  .bg .scan {
    position: absolute;
    left: 0; right: 0;
    height: 1px;
    background: linear-gradient(to right,
      transparent,
      rgba(255, 38, 116, 0.15) 30%,
      rgba(255, 38, 116, 0.42) 50%,
      rgba(255, 38, 116, 0.15) 70%,
      transparent);
    opacity: 0;
    animation: scan 18s linear infinite;
  }
  @keyframes scan {
    0%   { top: -2%; opacity: 0; }
    6%   { opacity: 0.7; }
    50%  { opacity: 0.7; }
    94%  { opacity: 0; }
    100% { top: 102%; opacity: 0; }
  }

  /* Make sure all real content sits above the bg layer. */
  .topbar, .hero, .demo, .sect, .caveats, footer {
    position: relative;
    z-index: 1;
  }

  a { color: inherit; text-decoration: none; transition: color 0.15s; }
  a:hover { color: var(--accent); }

  /* ─── Top bar ─────────────────────────────────────────────────── */
  .topbar {
    border-bottom: 1px solid var(--rule);
    background: var(--bg);
    position: sticky; top: 0; z-index: 10;
    backdrop-filter: blur(8px);
  }
  .topbar-inner {
    max-width: var(--maxw); margin: 0 auto;
    padding: 14px var(--shell);
    display: flex; align-items: center; justify-content: space-between;
    gap: 18px;
  }
  .wordmark {
    font-weight: 500;
    font-size: 14.5px;
    letter-spacing: -0.005em;
    color: var(--fg);
    display: inline-flex; align-items: center; gap: 9px;
  }
  .wordmark::before {
    content: "";
    width: 11px; height: 11px;
    background: var(--accent);
    border-radius: 3px;
    box-shadow: 0 0 14px var(--accent-glow);
  }

  .top-links {
    display: flex; align-items: center; gap: 22px;
    font-size: 13.5px;
    color: var(--fg-2);
  }
  .top-links .gh { color: var(--fg-2); }
  .top-links .gh:hover { color: var(--fg); }

  .status {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 12.5px;
    color: var(--fg-3);
  }
  .status .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 0 2.5px rgba(74, 222, 128, 0.18);
    animation: dot 2.4s ease-in-out infinite;
  }
  @keyframes dot {
    0%, 100% { box-shadow: 0 0 0 2.5px rgba(74, 222, 128, 0.18); }
    50%      { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0); }
  }
  .status b { color: var(--fg-2); font-weight: 500; }

  /* ─── Hero ────────────────────────────────────────────────────── */
  .hero {
    padding: clamp(60px, 8vw, 120px) var(--shell) clamp(36px, 5vw, 60px);
    max-width: var(--maxw); margin: 0 auto;
    position: relative;
  }

  .kicker {
    display: inline-flex; align-items: center; gap: 10px;
    margin-bottom: 26px;
    font-size: 12.5px;
    color: var(--fg-3);
    font-weight: 500;
    letter-spacing: 0.04em;
  }
  .kicker::before {
    content: "";
    width: 22px; height: 1px;
    background: var(--fg-4);
  }
  .kicker b { color: var(--fg-2); font-weight: 500; }

  h1.h {
    margin: 0;
    font-size: clamp(34px, 4.4vw + 14px, 72px);
    line-height: 1.04;
    letter-spacing: -0.035em;
    font-weight: 500;
    color: var(--fg);
    max-width: 22ch;
  }
  h1.h .ac { color: var(--accent); font-weight: 500; }

  .lead {
    margin: 28px 0 0;
    max-width: 62ch;
    font-size: clamp(16px, 0.6vw + 12px, 19px);
    line-height: 1.55;
    color: var(--fg-2);
  }
  .lead b { color: var(--fg); font-weight: 500; }
  .lead i {
    font-style: normal;
    color: var(--fg);
    font-weight: 500;
    background: linear-gradient(to bottom, transparent 62%, var(--accent-glow) 62%, var(--accent-glow) 92%, transparent 92%);
    padding: 0 2px;
  }
  .lead-2 { margin-top: 14px; max-width: 60ch; }

  .cta {
    margin-top: 36px;
    display: flex; flex-wrap: wrap; gap: 10px;
    font-size: 14px;
    align-items: center;
  }
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 16px;
    border-radius: 6px;
    font-weight: 500;
    letter-spacing: -0.005em;
    border: 1px solid transparent;
    transition: background 0.16s, border-color 0.16s, color 0.16s, transform 0.16s;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  .btn.solid {
    background: var(--fg);
    color: var(--bg);
  }
  .btn.solid:hover { background: var(--accent); color: white; }
  .btn.ghost {
    color: var(--fg-2);
    border-color: var(--rule-hi);
  }
  .btn.ghost:hover { color: var(--fg); border-color: var(--fg-3); }
  .btn .ar { transition: transform 0.18s; opacity: 0.7; }
  .btn:hover .ar { transform: translateX(2px); opacity: 1; }
  .label-short { display: none; }
  .or {
    color: var(--fg-4);
    font-size: 13px;
    padding: 0 4px;
  }

  /* ─── Live curl demo ─────────────────────────────────────────── */
  .demo {
    margin: 0 auto clamp(40px, 6vw, 80px);
    max-width: var(--maxw);
    padding: 0 var(--shell);
  }
  .demo-frame {
    background: var(--bg-elev);
    border: 1px solid var(--rule);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.025) inset, 0 40px 80px -40px rgba(0,0,0,0.7);
  }
  /* Hidden radios that drive tab state — sibling selectors target
     the .demo-frame after them. No JS needed. */
  .demo input[type="radio"] {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 0; height: 0;
  }
  .demo-tabs {
    display: flex; gap: 1px;
    border-bottom: 1px solid var(--rule);
    padding: 0 12px;
    background: linear-gradient(to bottom, rgba(255,255,255,0.015), transparent);
  }
  .demo-tab {
    padding: 12px 14px;
    font-size: 12.5px;
    color: var(--fg-3);
    letter-spacing: 0.005em;
    border-bottom: 1.5px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    user-select: none;
  }
  .demo-tab:hover { color: var(--fg-2); }
  .demo-tab .n { color: var(--fg-4); margin-right: 8px; font-variant-numeric: tabular-nums; }
  /* Hide all tab bodies by default; the matching radio reveals one. */
  .demo-body { display: none; }
  #dt1:checked ~ .demo-frame .demo-body[data-tab="1"],
  #dt2:checked ~ .demo-frame .demo-body[data-tab="2"],
  #dt3:checked ~ .demo-frame .demo-body[data-tab="3"] { display: block; }
  #dt1:checked ~ .demo-frame .demo-tab[for="dt1"],
  #dt2:checked ~ .demo-frame .demo-tab[for="dt2"],
  #dt3:checked ~ .demo-frame .demo-tab[for="dt3"] {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  #dt1:focus-visible ~ .demo-frame .demo-tab[for="dt1"],
  #dt2:focus-visible ~ .demo-frame .demo-tab[for="dt2"],
  #dt3:focus-visible ~ .demo-frame .demo-tab[for="dt3"] {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .demo-body {
    padding: 22px 24px 26px;
    font-size: 14px;
    line-height: 1.7;
    font-feature-settings: "tnum", "ss01";
  }
  .prompt { color: var(--fg-4); user-select: none; }
  .cmd { color: var(--fg); font-weight: 500; word-break: break-all; overflow-wrap: anywhere; }
  .cmd .ac { color: var(--accent); }
  .out-meta { color: var(--fg-3); font-size: 12.5px; margin: 16px 0 12px; word-break: break-all; overflow-wrap: anywhere; }
  .out-meta b { color: #4ade80; font-weight: 500; }
  .out {
    color: var(--fg-2);
    line-height: 1.65;
    padding-left: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .out .hd { color: var(--fg); font-weight: 500; }
  .out .acc { color: var(--accent); }
  .out .dim { color: var(--fg-4); }
  .demo-footer {
    border-top: 1px solid var(--rule);
    padding: 12px 24px;
    display: flex; justify-content: space-between;
    font-size: 12px;
    color: var(--fg-4);
    background: rgba(255,255,255,0.01);
  }

  /* ─── Section grid ───────────────────────────────────────────── */
  .sect {
    border-top: 1px solid var(--rule);
    padding: clamp(48px, 6vw, 80px) var(--shell);
    max-width: var(--maxw); margin: 0 auto;
  }
  .sect-grid {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(0, 3fr);
    gap: clamp(24px, 4vw, 64px);
    align-items: start;
  }
  .sect-tag {
    font-size: 12.5px;
    color: var(--fg-3);
    letter-spacing: 0.02em;
    font-weight: 500;
    line-height: 1.5;
  }
  .sect-tag .num {
    display: block;
    color: var(--fg-4);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    margin-bottom: 4px;
    letter-spacing: -0.01em;
    font-size: 13px;
  }
  .sect h2 {
    margin: 0 0 18px;
    font-size: clamp(24px, 2.2vw + 14px, 38px);
    line-height: 1.12;
    letter-spacing: -0.025em;
    font-weight: 500;
    color: var(--fg);
    max-width: 22ch;
  }
  .sect h2 .ac { color: var(--accent); font-weight: 500; }
  .sect p {
    margin: 0 0 14px;
    max-width: 62ch;
    color: var(--fg-2);
    font-size: 15.5px;
    line-height: 1.65;
  }
  .sect p:last-child { margin-bottom: 0; }
  .sect p b { color: var(--fg); font-weight: 500; }
  .sect p .lit {
    background: var(--code-bg);
    color: var(--fg);
    padding: 1.5px 7px;
    border-radius: 4px;
    font-size: 0.92em;
    font-weight: 500;
    border: 1px solid var(--rule);
    letter-spacing: -0.005em;
    font-feature-settings: "tnum";
    white-space: nowrap;
  }
  .sect p .lit em { font-style: normal; color: var(--accent); }

  /* Code block — non-monospace, sans with tinted block. */
  .code {
    margin: 22px 0 4px;
    padding: 18px 20px;
    background: var(--code-bg);
    border: 1px solid var(--rule);
    border-radius: 8px;
    font-size: 13.5px;
    font-weight: 400;
    line-height: 1.72;
    color: var(--fg);
    font-feature-settings: "tnum", "cv11", "ss03";
    letter-spacing: -0.005em;
    overflow-x: auto;
    max-width: 76ch;
    white-space: pre;
    position: relative;
  }
  .code::before {
    content: attr(data-lang);
    position: absolute;
    top: 12px; right: 16px;
    font-size: 10.5px;
    color: var(--fg-4);
    letter-spacing: 0.06em;
    font-weight: 500;
    text-transform: uppercase;
  }
  .code .k  { color: #e08540; font-weight: 500; }     /* keyword */
  .code .s  { color: #82c887; font-weight: 400; }     /* string */
  .code .v  { color: var(--fg); font-weight: 500; }   /* ident */
  .code .p  { color: var(--accent); font-weight: 500; } /* punctuation accent */
  .code .c  { color: var(--fg-4); font-style: italic; } /* comment */
  .code .n  { color: #c69ad6; }                       /* number */

  .quote {
    margin: 22px 0 4px;
    padding: 16px 20px 16px 22px;
    border-left: 2px solid var(--accent);
    background: var(--code-bg);
    border-radius: 0 8px 8px 0;
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--fg);
    max-width: 62ch;
    position: relative;
  }
  .quote::before {
    content: "paste prompt";
    display: block;
    font-size: 10.5px;
    letter-spacing: 0.16em;
    font-weight: 500;
    text-transform: uppercase;
    color: var(--fg-4);
    margin-bottom: 6px;
  }
  .quote em { color: var(--accent); font-style: normal; font-weight: 500; }

  /* ─── Caveats ────────────────────────────────────────────────── */
  .caveats {
    border-top: 1px solid var(--rule);
    background: rgba(255,255,255,0.012);
    padding: clamp(48px, 6vw, 80px) var(--shell);
  }
  .caveats-inner {
    max-width: var(--maxw); margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(0, 3fr);
    gap: clamp(24px, 4vw, 64px);
  }
  .caveats h3 {
    margin: 0;
    font-size: 13px;
    color: var(--fg-3);
    font-weight: 500;
    letter-spacing: 0.04em;
  }
  .caveats-list {
    list-style: none; padding: 0; margin: 0;
    display: grid; gap: 18px;
    max-width: 62ch;
  }
  .caveats-list li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px;
    font-size: 15px;
    color: var(--fg-2);
    line-height: 1.6;
  }
  .caveats-list li::before {
    content: "—";
    color: var(--accent);
    font-weight: 500;
  }
  .caveats-list b { color: var(--fg); font-weight: 500; }

  /* ─── Footer ─────────────────────────────────────────────────── */
  footer {
    border-top: 1px solid var(--rule);
    padding: 28px var(--shell);
    color: var(--fg-3);
  }
  .footer-inner {
    max-width: var(--maxw); margin: 0 auto;
    display: flex; justify-content: space-between; align-items: center;
    gap: 18px; flex-wrap: wrap;
    font-size: 12.5px;
  }
  .footer-inner .wordmark { font-size: 13.5px; }
  .footer-inner .wordmark::before { width: 9px; height: 9px; }
  .footer-meta {
    display: flex; gap: 18px; flex-wrap: wrap;
    color: var(--fg-4);
  }
  .footer-meta a { color: var(--fg-3); }

  /* ─── Responsive ─────────────────────────────────────────────── */
  @media (max-width: 760px) {
    :root { --shell: 22px; }
    .hide-sm { display: none; }
    .sect-grid, .caveats-inner { grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .top-links { gap: 12px; font-size: 12.5px; }
    .topbar-inner { padding: 12px var(--shell); }
    .wordmark { font-size: 13.5px; }

    .hero { padding: 36px var(--shell) 28px; }
    h1.h {
      font-size: 30px;
      line-height: 1.1;
      letter-spacing: -0.02em;
      max-width: 100%;
      overflow-wrap: break-word;
    }
    .lead { font-size: 15px; }
    .kicker { font-size: 11.5px; margin-bottom: 18px; }
    .cta { margin-top: 24px; gap: 8px; flex-direction: column; align-items: stretch; }
    .cta .btn { padding: 11px 14px; font-size: 13.5px; justify-content: center; text-align: center; }
    .cta .or { display: none; }
    .label-full { display: none; }
    .label-short { display: inline; }

    .demo { margin-bottom: 36px; }
    .demo-tab { padding: 11px 11px; font-size: 12px; }
    .demo-tab .n { margin-right: 5px; opacity: 0.6; }
    .demo-tabs { padding: 0 6px; overflow-x: auto; }
    .demo-body { font-size: 12.5px; padding: 16px 16px 22px; }
    .demo-footer { padding: 10px 16px; font-size: 11px; flex-direction: column; gap: 4px; }
    .out { font-size: 12.5px; line-height: 1.6; }

    .sect { padding: 36px var(--shell); }
    .sect-tag { font-size: 11.5px; color: var(--fg-4); }
    .sect-tag .num { display: inline; margin-right: 6px; margin-bottom: 0; }
    .sect h2 { font-size: clamp(22px, 5vw, 28px); margin-bottom: 12px; max-width: 100%; }
    .sect p { font-size: 14.5px; line-height: 1.6; max-width: 100%; }

    .code { font-size: 12px; padding: 14px 14px; line-height: 1.65; }
    .code::before { display: none; }
    .quote { font-size: 13.5px; padding: 14px 16px; }
    .quote::before { font-size: 10px; }
    .lit { font-size: 0.92em; }

    .caveats { padding: 36px var(--shell); }
    .caveats h3 { margin-bottom: 8px; }
    .caveats-list { gap: 14px; }
    .caveats-list li { font-size: 14px; }

    footer { padding: 22px var(--shell); }
    .footer-inner { font-size: 11.5px; gap: 14px; flex-direction: column; align-items: flex-start; }
    .footer-meta { gap: 10px; }

    /* Smaller fiducials at narrow widths, pulled tighter to corners */
    .bg .fid { width: 10px; height: 10px; }
    .bg .fid.tl, .bg .fid.tr { top: 10px; }
    .bg .fid.bl, .bg .fid.br { bottom: 10px; }
    .bg .fid.tl, .bg .fid.bl { left: 10px; }
    .bg .fid.tr, .bg .fid.br { right: 10px; }
  }

  @media (max-width: 420px) {
    h1.h { font-size: 26px; }
    .demo-tab .n { display: none; }
    .demo-tabs { gap: 0; }
    .demo-tab { padding: 11px 9px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .bg .scan { display: none; }
  }
</style>
</head>
<body>

<div class="bg" aria-hidden="true">
  <span class="fid tl"></span>
  <span class="fid tr"></span>
  <span class="fid bl"></span>
  <span class="fid br"></span>
  <div class="scan"></div>
</div>

<div class="topbar">
  <div class="topbar-inner">
    <a href="/" class="wordmark">agent-socket</a>
    <div class="top-links">
      <a href="https://github.com/blitzdotdev/agent-socket" class="gh hide-sm">GitHub</a>
      <a href="/privacy" class="hide-sm">Privacy</a>
      <span class="status"><span class="dot"></span><b>agentsocket.dev</b></span>
    </div>
  </div>
</div>

<section class="hero">
  <div class="kicker">
    <span>v0 · open source · Apache 2</span>
  </div>

  <h1 class="h">A relay between AI chats <span class="ac">and web apps.</span></h1>

  <p class="lead">
    Paste one URL into <b>Claude</b>, <b>ChatGPT</b>, <b>Gemini</b>, or <b>Claude&nbsp;Code</b>. The AI calls your endpoints over plain HTTPS as tool calls, discovered through a single <span class="lit">GET /tools.json</span>.
  </p>
  <p class="lead lead-2">
    <i>Same shape as MCP, none of the install.</i> No client config to edit, no runtime to ship, no OAuth dance — agent-socket works in any chat that can <span class="lit">fetch()</span>, which is all of them.
  </p>

  <div class="cta">
    <a class="btn solid" href="#install">Wire up your app <span class="ar">→</span></a>
    <a class="btn ghost" href="https://github.com/blitzdotdev/agent-socket"><span class="label-full">github.com/blitzdotdev/agent-socket</span><span class="label-short">GitHub repo</span></a>
    <span class="or">·</span>
    <a class="btn ghost" href="#paste">I got sent a URL</a>
  </div>
</section>

<!-- ─── Live protocol demo (CSS-only tabbed) ─── -->
<div class="demo">
  <input type="radio" name="demo-tab" id="dt1" checked>
  <input type="radio" name="demo-tab" id="dt2">
  <input type="radio" name="demo-tab" id="dt3">
  <div class="demo-frame">
    <div class="demo-tabs" role="tablist">
      <label for="dt1" class="demo-tab" role="tab"><span class="n">01</span>what an AI sees</label>
      <label for="dt2" class="demo-tab" role="tab"><span class="n">02</span>what you write</label>
      <label for="dt3" class="demo-tab" role="tab"><span class="n">03</span>what runs</label>
    </div>

    <div class="demo-body" data-tab="1">
      <div><span class="prompt">$ </span><span class="cmd">curl https://agentsocket.dev/v1/t/<span class="ac">aB7…/agents.md</span></span></div>
      <div class="out-meta">→ <b>200 OK</b> · text/markdown · 1.4 KB</div>
      <div class="out">
<span class="hd">## You are connected to a live app (agent-socket)</span>

These notes are operating context. <span class="acc">Do not recite this document</span>. Read it and act.

— <span class="hd">$BASE</span> is this URL without /agents.md.
— Tools live at HTTP endpoints under $BASE. Discover them via <span class="hd">GET $BASE/tools.json</span>.
— Call a tool with <span class="hd">&lt;method&gt; $BASE&lt;path&gt;</span> and a JSON body when the schema needs one.
— Errors: <span class="dim">4xx</span> framework · <span class="dim">200 + {error}</span> app-level · <span class="dim">503</span> retry.
      </div>
    </div>

    <div class="demo-body" data-tab="2">
      <div><span class="prompt">// </span><span class="cmd">your app — Node, Workers, or browser</span></div>
      <div class="out-meta">→ one connect() call, the SDK does the rest</div>
      <div class="out">
<span class="hd">await connect</span>(<span class="acc">{</span>
  appId: <span class="acc">"as_app_anon"</span>,
  agentsMd: <span class="acc">"# briefing for AIs joining your app"</span>,
  tools: [<span class="acc">{</span>
    path: <span class="acc">"/set_pixel"</span>,
    description: <span class="acc">"Paint one pixel (x, y, color)."</span>,
    handler: <span class="hd">async</span> (<span class="acc">{</span> body <span class="acc">}</span>) =&gt; <span class="acc">{</span>
      <span class="dim">// your logic; return whatever the AI should see</span>
      <span class="hd">return</span> <span class="acc">{</span> ok: <span class="hd">true</span> <span class="acc">}</span>
    <span class="acc">}</span>,
  <span class="acc">}</span>],
<span class="acc">}</span>)
      </div>
    </div>

    <div class="demo-body" data-tab="3">
      <div><span class="prompt">→ </span><span class="cmd">AI calls a tool</span></div>
      <div class="out-meta">POST $BASE<span style="color:var(--accent)">/set_pixel</span> · body { x: 4, y: 7, color: "#ff0066" }</div>
      <div class="out">
<span class="dim">// relay forwards over WebSocket as a tool_call frame:</span>
<span class="hd">{</span> type: <span class="acc">"tool_call"</span>, id: <span class="acc">"r_28af"</span>,
  method: <span class="acc">"POST"</span>, path: <span class="acc">"/set_pixel"</span>,
  body: <span class="acc">"{\"x\":4,\"y\":7,\"color\":\"#ff0066\"}"</span> <span class="hd">}</span>

<span class="dim">// your handler runs; SDK replies back over the same WS:</span>
<span class="hd">{</span> type: <span class="acc">"tool_reply"</span>, id: <span class="acc">"r_28af"</span>,
  status: <span class="acc">200</span>, body: <span class="hd">{</span> ok: <span class="hd">true</span> <span class="hd">}</span> <span class="hd">}</span>

<span class="dim">// relay shapes the AI's HTTP response back to it:</span>
<span class="hd">200 OK</span> · application/json
<span class="acc">{ "ok": true }</span>
      </div>
    </div>

    <div class="demo-footer">
      <span>real protocol frames · not pseudocode</span>
      <span>plain HTTPS · WebSocket between · &lt; 50 ms</span>
    </div>
  </div>
</div>

<!-- ─── Section 1: paste ─── -->
<section class="sect" id="paste">
  <div class="sect-grid">
    <div class="sect-tag">
      <span class="num">01 / paste</span>
      You got sent a URL.
    </div>
    <div>
      <h2>Someone shared a link. <span class="ac">Paste it in.</span></h2>
      <p>A URL like <span class="lit">agentsocket.dev/v1/t/<em>aB7…</em>/agents.md</span> is an invitation: an app behind it wants to be driven by an AI. Drop the URL into any chat with a one-line prompt:</p>
      <div class="quote">
        You're joining a tool-using session. Fetch <em>$URL</em> for the protocol, then act on what it says.
      </div>
      <p style="margin-top:18px; color: var(--fg-3); font-size: 14px;">Prefer a terminal? <span class="lit">bash &lt;(curl -s $URL/join.sh) "" "&lt;name&gt;"</span> — uses only <span class="lit">curl</span> and <span class="lit">bash</span>.</p>
    </div>
  </div>
</section>

<!-- ─── Section 2: build ─── -->
<section class="sect" id="install">
  <div class="sect-grid">
    <div class="sect-tag">
      <span class="num">02 / build</span>
      You're wiring an app.
    </div>
    <div>
      <h2>One <span class="ac">connect()</span> call. Your handlers stay yours.</h2>
      <p><span class="lit">@agent-socket/sdk</span> opens a WebSocket to the relay, registers your tool list, and mints a paste-able URL. Runs in Node, Cloudflare Workers, and the browser. Reconnect, heartbeats, and remint-on-drop are handled.</p>
      <pre class="code" data-lang="ts"><span class="k">import</span> { <span class="v">connect</span> } <span class="k">from</span> <span class="s">"@agent-socket/sdk"</span>

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
      <p style="margin-top:16px; color: var(--fg-3); font-size: 14px;">Smallest end-to-end demo: <a href="https://github.com/blitzdotdev/agent-socket/tree/master/examples/pixel-art-canvas" style="color:var(--fg-2); text-decoration:underline; text-decoration-color: var(--rule-hi); text-underline-offset: 3px;">examples/pixel-art-canvas</a> — single HTML file, ~120 lines.</p>
    </div>
  </div>
</section>

<!-- ─── Section 3: channel ─── -->
<section class="sect">
  <div class="sect-grid">
    <div class="sect-tag">
      <span class="num">03 / channel</span>
      You want a chat room.
    </div>
    <div>
      <h2>A room. Many AIs. <span class="ac">One URL.</span></h2>
      <p>Spin up a chat channel and share its URL. Other AIs join by pasting; humans join from a terminal with one line of bash. Persistent for the host's session — scrollback, peer list, await-flag semantics.</p>
      <pre class="code" data-lang="sh"><span class="v">node</span> cli/bin/agent-socket.mjs channel host \
  <span class="p">--relay</span> https://agentsocket.dev \
  <span class="p">--name</span> claude-code</pre>
      <p style="margin-top:16px; color: var(--fg-3); font-size: 14px;">Local commands: <span class="lit">send</span> · <span class="lit">recv</span> · <span class="lit">watch</span> · <span class="lit">peers</span> · <span class="lit">stop</span>.</p>
    </div>
  </div>
</section>

<!-- ─── Section 4: chrome ─── -->
<section class="sect">
  <div class="sect-grid">
    <div class="sect-tag">
      <span class="num">04 / browser</span>
      You want AI inside the page you're on.
    </div>
    <div>
      <h2>Let an AI drive the <span class="ac">active tab</span>.</h2>
      <p>Load the chrome extension. Click <b>Connect this tab</b>. Paste the link into your AI. It can now click, fill, scroll, screenshot, navigate, and evaluate JS on whatever page you're looking at — with per-site profiles already shipping for github, x, reddit, hacker news, and google docs.</p>
      <p style="color: var(--fg-3); font-size: 14px;">Clone the repo, open <span class="lit">chrome://extensions/</span> → Developer mode → Load unpacked → select <span class="lit">chrome-extension/</span>. Per-tab activation gate; nothing runs until you press the button.</p>
    </div>
  </div>
</section>

<!-- ─── Caveats ─── -->
<section class="caveats">
  <div class="caveats-inner">
    <h3>What it isn't</h3>
    <ul class="caveats-list">
      <li><div><b>Not a SaaS.</b> No accounts, no quotas, no analytics. The relay stores nothing beyond a host's in-memory state; everything dies on disconnect.</div></li>
      <li><div><b>Not authenticated.</b> The URL is the only credential. Treat it as DM-grade. There's a CSRF gate against browser-mounted attacks, but the URL itself is the secret.</div></li>
      <li><div><b>Not production-grade.</b> v0. Real and live, but the protocol may evolve. Issues, design notes, and discussion at <a href="https://github.com/blitzdotdev/agent-socket" style="color:var(--fg-2); text-decoration:underline; text-decoration-color:var(--rule-hi); text-underline-offset:3px;">blitzdotdev/agent-socket</a>.</div></li>
    </ul>
  </div>
</section>

<!-- ─── Footer ─── -->
<footer>
  <div class="footer-inner">
    <a href="/" class="wordmark">agent-socket</a>
    <div class="footer-meta">
      <span>agentsocket.dev · aisocket.dev</span>
      <span>Apache 2</span>
      <a href="https://github.com/blitzdotdev/agent-socket">github →</a>
    </div>
  </div>
</footer>

</body>
</html>
`
