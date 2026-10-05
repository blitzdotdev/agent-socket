# Relay

The Cloudflare Worker and Durable Object behind agentsocket.dev. Apps hold a WebSocket to it; agents call tools over HTTPS; the relay forwards each call to the app and returns the reply. The wire format is in [docs/protocol.md](../docs/protocol.md).

## How it is built

- `src/worker.ts` routes requests. A new `/v1/_ws` connection gets a fresh 8-character session id, and every request for that session goes to the Durable Object named by it (`idFromName`).
- `src/relay-do.ts` is the Durable Object, built on [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver), one per session. It holds the app's socket and in-flight calls in memory, and the registration (tools, `agents.md`), the session's tokens, async tasks and the hold deadline in its storage through the key-value API, reloaded in `onStart`, so a session survives hibernation, eviction and restarts. One alarm drives the hold's expiry and the liveness check. It hibernates (`hibernate: true`): the runtime answers the SDK's heartbeat frame itself (`setWebSocketAutoResponse`), so an idle session costs no duration. The storage layout is in the file's header and in [docs/protocol.md](../docs/protocol.md#storage).
- `src/tokens.ts` generates and parses session ids, tokens and resume secrets, and derives what is stored in their place: verifier hashes, sealed tokens, the resume check value.
- `public/` holds the landing and privacy pages, served as static assets before the Worker runs. `public/privacy.html` is generated from `PRIVACY.md` by `npm run privacy:html` at the repo root.

## Routes

| Route | |
|---|---|
| `GET /`, `GET /privacy` | Static pages from `public/`. |
| `GET /download` | 302 to the latest GitHub release's `agent-socket-extension.zip`. |
| `GET /v1/_ws` (WebSocket) | New app session. Rate-limited per IP. |
| `GET /v1/_ws?session=<id>` (WebSocket) | Resume that session; the first frame must carry the resume secret. |
| `GET /v1/t/<token>/agents.md` | The app's briefing. |
| `GET /v1/t/<token>/tools.json` | The app's tools. |
| `<METHOD> /v1/t/<token>/<path>` | Call a tool. Body up to 1 MiB. |
| `GET /v1/t/<token>/_as_tasks/<id>` | Poll an async call. |
| `GET /_debug/health`, `POST /_debug/kill-ws/<id>[?end=1\|?hold=<ms>]`, `GET /_debug/state/<id>`, `POST /_debug/evict/<id>` | Only with `DEBUG=1`. |

## Configuration

`vars` in `wrangler.jsonc`:

| Var | Default | |
|---|---|---|
| `MAX_SYNC_TOOL_MS` | 30000 | How long a tool call waits for the app's reply before `504 tool_timeout`. |
| `HEARTBEAT_TIMEOUT_MS` | 50000 | How long the app's socket may stay silent before the relay drops it and holds the session for resume. The SDK pings every 25 s. |
| `RESUME_GRACE_MS` | 86400000 | How long a dropped app's session is held for resume (24 h), in Durable Object storage. `0` turns resume off. |
| `DEBUG` | unset | `1` enables `/_debug/*`, `?force_session=` on `/v1/_ws` and extra logging. Local only: set it in `.dev.vars`, never in `wrangler.jsonc`. |

Bindings: `RELAY` (the Durable Object) and `WS_RATE_LIMIT` (100 `/v1/_ws` upgrades per 10 s per IP, per Cloudflare location). Fixed limits in the code: 50 tokens, 100 in-flight calls and 100 pending async tasks per session, 4 MiB WebSocket frames, 65,536-character `agents.md`, 10 s to register or resume. The full list, with what happens at each, is in [docs/protocol.md](../docs/protocol.md#limits).

Either Durable Object storage backend works: the hosted relay's class is key-value backed (created before SQLite-backed classes existed), the top-level config creates a SQLite-backed one, and the relay uses only the key-value storage API and alarms, which both support. `HARNESS_ENV=production npm run harness` runs the integration harness against the key-value-backed config locally.

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

## Local development

From the repo root:

```bash
npm install
cp relay/.dev.vars.example relay/.dev.vars   # optional: DEBUG=1, 3 s tool timeout
npm run dev                                  # wrangler dev on http://localhost:8787
```

The integration harness (`npm run harness`) starts its own relay with short timeouts. To run it against a relay you started with `DEBUG=1` in `.dev.vars`: `npm run build -w sdk`, then `RELAY_URL=http://localhost:8787 node harness/run.mjs all`.

## Deploy

The top level of `wrangler.jsonc` deploys to your workers.dev subdomain with `npx wrangler deploy --env=""`. See [docs/self-hosting.md](../docs/self-hosting.md) for custom domains.

The `production` environment is the hosted relay at agentsocket.dev (and its alias aisocket.dev). Maintainers deploy it with `bash scripts/deploy.sh deploy`, which reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from `.env` (see `.env.example`), runs `wrangler deploy --env production` and smoke-tests the live URLs.
