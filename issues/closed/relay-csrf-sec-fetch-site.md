# Relay: CSRF protection on the agent surface

## What goes wrong

Tool URLs (`/v1/t/<token>/*`) are paste-from-AI-chat secrets meant to be called by AI tool runtimes — Anthropic and OpenAI server-side fetchers, Claude.ai code-interpreter Python `requests`, Claude Code's Node `fetch`, curl, Gemini code-execution. All non-browser. None of these use cookies or any ambient credential — possession of the URL alone authorizes the call.

That means **the URL itself is the credential**. Pre-fix, any browser page that learned a token URL could drive the tool with a normal cross-origin POST:

```html
<!-- on evil.com -->
<form action="https://agentsocket.dev/v1/t/<token>/destructive_tool" method="POST"
      enctype="text/plain">
  <input name='{"x":"' value='1"}'>
</form>
<script>document.forms[0].submit()</script>
```

That's textbook CSRF. The user pastes the URL into an AI chat once; if it later leaks into browser history, a referrer, or a paste into evil.com itself, any subsequent visit to a hostile page can drive every tool that token exposes.

## Threat model recap

- v0 has no auth beyond URL secrecy (documented).
- The URL is supposed to be a DM-grade secret.
- We don't control where users paste URLs or how they're stored client-side.
- AI tool runtimes are all server-side HTTP clients. Browser-initiated POSTs to the tool surface are **never** legitimate.

## What to do

Reject any request to a **user-defined tool path** (`/v1/t/<token>/<tool-path>`) that carries a `Sec-Fetch-Site` header set to anything other than `none`. Skip the check for the three relay-rendered, read-only meta paths: `GET /agents.md`, `GET /tools.json`, `GET /_as_tasks/<id>`.

Why this works (server-side only, no client cooperation):

- Modern browsers attach `Sec-Fetch-Site` to **every** outbound fetch (Chrome 76+, Firefox 90+, Safari 16+).
- `Sec-Fetch-Site` is a **Forbidden Header**: page JavaScript cannot set, override, or strip it. The browser itself stamps the value.
- Non-browser HTTP clients (curl, Node `fetch`, Python `requests`, all AI server-side fetchers) **don't** send it.
- `Sec-Fetch-Site: none` is the value sent for user-initiated top-level navigation — address-bar paste, bookmark click, opening a link from a non-web context. We allow that so devs can still paste a URL into a tab to preview `/agents.md` or `/tools.json`.
- All other values (`cross-site`, `same-site`, `same-origin`) signal "initiated by a page" — which means a browser doing a CSRF call.

No `Content-Type` rule, no agent-side change, no SDK update, no extension impact (chrome extension talks WS to `/v1/_ws`, not tool URLs).

## Endpoint mapping (decided per-endpoint)

| Path | Source | Check applied |
|---|---|---|
| `GET /` (landing) | humans, bots, link previews | No — public marketing page |
| `/_debug/*` (DEBUG=1) | harness/curl | No — never enabled in prod |
| `WSS /v1/_ws` | apps (incl. browser apps via SDK / chrome ext) | No — Origin allowlist via `apps.json` handles app trust |
| `GET /v1/t/<token>/agents.md` | agent reads + humans previewing | **No (carve-out)** — read-only, relay-rendered, no side effects |
| `GET /v1/t/<token>/tools.json` | agent reads + humans previewing | **No (carve-out)** — same reason |
| `GET /v1/t/<token>/_as_tasks/<id>` | agent polls task status | **No (carve-out)** — same reason |
| `* /v1/t/<token>/<tool-path>` | AI tool runtimes only | **Yes** — this is the CSRF target |

The carve-out matters for UX: users who get a token URL via email or a web chat will often click it to "see what this URL is" before pasting into an AI. That click sends `Sec-Fetch-Site: cross-site` (it's a web-initiated navigation from Gmail, Discord web, HN, etc.). Without the carve-out they'd get a 403 instead of the agents.md preview. With it, the preview works while CSRF on side-effecting tool paths is still blocked.

## Implementation

`relay/src/errors.ts`: add `csrf_denied` to the `ErrorCode` union.

`relay/src/relay-do.ts`: after the `userPath` is computed and after the three meta paths (`/agents.md`, `/tools.json`, `/_as_tasks/...`) are matched, before tool dispatch:

```ts
const sfs = req.headers.get("sec-fetch-site")
if (sfs && sfs !== "none") {
  return errorResponse("csrf_denied", "tool calls not allowed from browser context", 403)
}
```

The check lives in the DO (not the Worker entry) so it can branch on `userPath` and skip the carve-out paths.

## Acceptance

- POST `/v1/t/<token>/echo` with no `Sec-Fetch-Site` → 200 (the curl / SDK / AI runtime case).
- Same POST with `Sec-Fetch-Site: none` → 200 (address-bar paste preserved).
- Same POST with `Sec-Fetch-Site: cross-site` → 403 `csrf_denied`.
- `same-site` and `same-origin` also → 403.
- GET `/v1/t/<token>/agents.md` with `cross-site` → 403; with `none` → 200.
- GET `/v1/_ws` with `cross-site` → 400 `protocol_error` (the existing "no upgrade header" path), **not** 403 — the WS surface is intentionally exempt because legitimate browser apps connect here.
- GET `/` with `cross-site` → 200 landing page (humans visit from search results, link previews, etc.).

## Caveats / known gaps

Validated against the spec ([webappsec-fetch-metadata](https://w3c.github.io/webappsec-fetch-metadata/)), MDN, and an empirical Chromium test:

- **Safari < 16.4** (March 2023) omits `Sec-Fetch-Site` entirely → would slip through. Mostly aged out by 2026.
- **Chrome MV3 extension service-worker fetches** send `Sec-Fetch-Site: none` per [w3c issue #47](https://github.com/w3c/webappsec-fetch-metadata/issues/47) — a malicious extension can hit tool endpoints. Out of scope: a malicious extension can already exfil cookies, read every page, etc.
- **On-path network attacker** can strip the header before it reaches the relay, but that requires MITM which means TLS is already compromised — bigger problems.
- **`Sec-Fetch-Site` is only sent on HTTPS / localhost** per spec. Fine for production (`agentsocket.dev` is HTTPS) and local dev (`localhost` qualifies).
- **`Same-site` vs `same-origin` nuance**: `localhost:A` vs `localhost:B` is `same-site` (same registrable host, different port). Two local CLI tools could in principle drive each other under `same-site`, but our gate rejects `same-site` too, so this is closed.
- **Cross-site redirect stickiness**: per spec, `Sec-Fetch-Site` ratchets toward `cross-site` and never recovers, so an attacker can't bounce through a same-origin redirect to launder the value.
- **CORS preflight `OPTIONS` carries the same `Sec-Fetch-Site` value as the real request would**, so the defense fires on preflight too — the actual POST never goes out.
- **Click from webmail / web chat** (Gmail tab, Discord web, HN link) sends `cross-site`. With the meta-path carve-out, clicking the URL still serves `/agents.md` for preview; only side-effecting tool calls are blocked.
- **Click from a desktop app** (Slack desktop, Mail.app, terminal link) sends `Sec-Fetch-Site: none` in modern browsers (Chrome and Firefox ≥ 92), so those clicks work everywhere.

## Provenance

2026-06-04 — surfaced during the 10-agent pre-launch audit as a critical-tier item. Original suggestion was to require `Content-Type: application/json` on tool POSTs (forces a CORS preflight that evil.com can't satisfy). Rejected because it requires AI agents to remember to set the header on every call, and they have a tendency to drop it — legitimate calls would 400. The `Sec-Fetch-Site` approach achieves the same defense entirely server-side with no client-side burden.

---

**CLOSED 2026-06-04** — implemented in `relay/src/relay-do.ts` (`onRequest`, after meta-path matching) with `csrf_denied` error code in `relay/src/errors.ts`. After two-agent research (MDN + spec deep-dive + empirical Chromium test) revealed that user clicks from webmail / web-chat would send `Sec-Fetch-Site: cross-site` and produce a false-positive 403 on `agents.md` preview, the check was scoped to side-effecting tool paths only and the three read-only meta paths (`agents.md`, `tools.json`, `_as_tasks/<id>`) bypass the gate. Harness scenario `37-csrf-sec-fetch-site` covers all four `Sec-Fetch-Site` values + absent + the three meta-path carve-outs + `/v1/_ws` not affected + landing page not affected. SECURITY.md updated with the "Mitigations in place" section and known false-negative classes. All 42 harness scenarios green.
