# `@agent-socket/relay`

The Cloudflare Worker + Durable Object that routes agent-socket traffic between app-side WebSockets and agent-side HTTP calls.

This package is **not on npm** — it's deployed as a Worker, not consumed as a library. See `wrangler.jsonc` for the canonical config.

## Architecture

One Durable Object per active session (one app connected via WS). The DO owns:

- The single WS to the registered app.
- The map of agent-tokens minted in this session.
- A pending-request map: each agent's HTTPS call gets a generated request id, forwarded over the WS as a `tool_call` frame; the app's `tool_reply` (matched by id) resolves the original HTTPS response.

When the WS drops the DO eventually dies. v0 has zero `ctx.storage` usage — channels reset to a fresh state on each connect.

## Tokens

Format: `<TOKEN_PREFIX>_<sessionId>_<verifier>` — by default `as_<8>_<22>`. The 8-char Crockford-base32 session-id is what `idFromName()` routes by; the 22-char base64url verifier is checked against the DO's in-memory set on every agent request.

`TOKEN_PREFIX` is configurable in `vars` (must match `^[a-z0-9]{2,8}$`).

## URL surface

| Path | What |
|---|---|
| `GET /` | Inline-HTML landing page |
| `GET /v1/_ws` | WS upgrade; mints a fresh session-id at the edge and routes to a brand-new DO |
| `POST /v1/t/<token>/<path>` | Forward to that token's DO, which invokes the registered tool handler over WS |
| `GET /v1/t/<token>/agents.md` | The app's briefing document for AIs |
| `GET /v1/t/<token>/tools.json` | The registered tool list (machine-readable) |
| `POST /v1/t/<token>/_as_tasks/<task-id>` | Async-task lookup (for tools that exceed sync timeout) |
| `GET /_debug/*` | Only when `DEBUG=1` in vars — health, kill-ws, etc. Production must NOT set DEBUG. |

## Config

See `wrangler.jsonc`. Production env vars:

| Var | Purpose |
|---|---|
| `TOKEN_PREFIX` | Token format prefix; `"as"` for the canonical deployment |
| `MAX_SYNC_TOOL_MS` | How long the relay holds an HTTP request waiting for the app's WS reply before returning 504 `tool_timeout` |
| `HEARTBEAT_INTERVAL_MS` | Ping cadence to the app's WS |
| `HEARTBEAT_TIMEOUT_MS` | Pong-wait before tearing down a stale WS |

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

All wrangler operations go through `scripts/deploy.sh`. **Do not run `npx wrangler ...` directly.** See `scripts/deploy.sh --help` for subcommands.

## Apps registry

`apps.json` lists the registered app-ids. v0 has three: `as_app_anon` (anonymous, wide-open), `as_app_pixel_art` (the demo), `as_app_test_strict` (harness fixture). Add new apps by editing this file and redeploying. A signup flow is a v1 item.
