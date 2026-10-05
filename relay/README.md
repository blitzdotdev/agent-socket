# `@agent-socket/relay`

The Cloudflare Worker + Durable Object that routes agent-socket traffic between app-side WebSockets and agent-side HTTP calls.

This package is **not on npm** — it's deployed as a Worker, not consumed as a library. See `wrangler.jsonc` for the canonical config.

## Architecture

One Durable Object per active session (one app connected via WS). The DO owns:

- The single WS to the registered app.
- The map of agent-tokens minted in this session.
- A pending-request map: each agent's HTTPS call gets a generated request id, forwarded over the WS as a `tool_call` frame; the app's `tool_reply` (matched by id) resolves the original HTTPS response.

`register_reply` gives the app a resume secret. When the WS drops (anything but a clean 1000 close) the DO holds the registration, tokens and async tasks for `RESUME_GRACE_MS`; the app reattaches on `/v1/_ws?session=<id>` with a `resume` frame carrying the secret, and every agent URL keeps working. In that window agents still get `agents.md` / `tools.json`, tool calls get `503 app_offline` + `Retry-After: 2`. A clean close, a protocol violation or the window running out wipes the session. Close codes: `4401` resume refused (bad secret or session gone), `4409` session already attached, `4410` replaced by a resume with the secret. v0 has zero `ctx.storage` usage, so if Cloudflare evicts the DO the resume is refused and the SDK starts a fresh session.

## Changing tools mid-session

A second `register` is refused, but a registered app can replace its tool list with an `update_tools` frame; every agent URL stays the same:

```jsonc
// app → relay
{ "type": "update_tools", "id": "u1", "tools": [{ "method": "POST", "path": "/b", "description": "…", "input_schema": {} }], "agentsMd": "# optional" }
// relay → app
{ "type": "update_tools_reply", "id": "u1", "ok": true }
{ "type": "update_tools_reply", "id": "u1", "ok": false, "error": { "code": "reserved_path", "message": "path is reserved: /agents.md" } }
```

`tools` and `agentsMd` are validated exactly like `register`'s (path syntax, reserved `/agents.md` / `/tools.json` / `/_as_*` paths, duplicate `METHOD path`, 64 KB agents.md); error codes are the same (`reserved_path`, `protocol_error`, `agents_md_too_large`). On success the whole list is replaced (tools not in it stop being routed: `404`) and `agentsMd` too when the frame has it (omit it to keep the current one). On error nothing changes and, unlike a bad `register`, the session stays up. Calls already forwarded to the app aren't affected. Before `register` the frame gets `protocol_error` "register first". A later `resume` carries a full registration and replaces the tools again, so the app must resume with its current set (the SDK does: `session.updateTools(tools, agentsMd?)`).

## Tokens

Format: `as_<sessionId>_<verifier>` (`as_<8>_<22>`). The 8-char Crockford-base32 session-id is what `idFromName()` routes by; the 22-char base64url verifier is checked against the DO's in-memory set on every agent request.

## URL surface

| Path | What |
|---|---|
| `GET /` | Inline-HTML landing page |
| `GET /privacy` | Inline-HTML privacy policy (linked from Chrome Web Store submission) |
| `GET /v1/_ws` | WS upgrade; mints a fresh session-id at the edge and routes to a brand-new DO |
| `GET /v1/_ws?session=<id>` | WS upgrade to resume that session; the first frame must be `resume` with the secret |
| `POST /v1/t/<token>/<path>` | Forward to that token's DO, which invokes the registered tool handler over WS. CSRF-gated via `Sec-Fetch-Site` (see SECURITY.md). |
| `GET /v1/t/<token>/agents.md` | The app's briefing document for AIs (CSRF gate exempt) |
| `GET /v1/t/<token>/tools.json` | The registered tool list (machine-readable, CSRF gate exempt) |
| `GET /v1/t/<token>/_as_tasks/<task-id>` | Async-task status poll for tools that exceed `MAX_SYNC_TOOL_MS` (CSRF gate exempt) |
| `GET /_debug/*` | Only when `DEBUG=1` in vars — health, kill-ws, etc. Production must NOT set DEBUG. |

## Config

See `wrangler.jsonc`. Production env vars:

| Var | Purpose |
|---|---|
| `MAX_SYNC_TOOL_MS` | How long the relay holds an HTTP request waiting for the app's WS reply before returning 504 `tool_timeout` |
| `HEARTBEAT_TIMEOUT_MS` | How long the app's WS may stay silent before the relay closes it as dead (the SDK pings every 25 s) |
| `RESUME_GRACE_MS` | How long a dropped app's session is held for resume (default 60000; 0 disables resume) |

`DEBUG` is intentionally absent in production. Set it in `.dev.vars` (gitignored) only.

## Local development

```bash
# From the repo root:
bash scripts/deploy.sh dev          # wrangler dev on :8787

# Harness will auto-start its own wrangler dev when running scenarios:
node harness/run.mjs all
```

## Deploy

```bash
# Copy .env.example to .env, fill in CLOUDFLARE_API_TOKEN
bash scripts/deploy.sh deploy
```

`scripts/deploy.sh` loads `CLOUDFLARE_API_TOKEN` from `.env`, runs `wrangler deploy`, then smoke-tests both production domains.

## App-ids

`appId` in the register frame is a free-form label (`[A-Za-z0-9_.-]{1,64}`, e.g. `as_app_anon`), echoed in `tools.json`. It isn't a credential and there's no registry: Origin can't be trusted outside browsers, so the relay doesn't check it.
