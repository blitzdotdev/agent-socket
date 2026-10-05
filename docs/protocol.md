# agent-socket protocol (v1)

Three parties:

- The **app** holds a WebSocket to the relay and runs the tool handlers.
- The **agent** (an AI chat, or anything that speaks HTTP) calls tools over HTTPS.
- The **relay** pairs them. It runs one Durable Object per session and keeps all state in memory.

```
app ──WebSocket /v1/_ws──▶ relay ◀──HTTPS /v1/t/<token>/…── agent
```

The examples use `https://agentsocket.dev`. A self-hosted relay serves the same paths.

## Identifiers

| Name | Format | Secret? |
|---|---|---|
| session id | 8 chars Crockford base32 (`0-9A-Z` without `I L O U`), 40 bits. Assigned by the relay. | No. It is part of every agent URL and routes requests to the session's Durable Object. |
| agent token | `as_<sessionId>_<verifier>`, 35 chars. The verifier is 16 random bytes as 22 chars base64url. | Yes. It is the only credential an agent needs. |
| resume secret | 32 random bytes as 43 chars base64url. Sent to the app in `register_reply`. | Yes. Only the app should hold it. |
| app id | Free-form label, `[A-Za-z0-9_.-]{1,64}`. Shown in `tools.json`. | No, and not checked. Any app can use any app id. |

A token is valid while its session lives and it has not been revoked. Tokens have no other expiry (`expiresAt` is always `null`).

## Agent surface (HTTPS)

All paths are under `https://agentsocket.dev/v1/t/<token>`, called `$BASE` below. A minted link is `$BASE/agents.md`.

| Request | Response |
|---|---|
| `GET $BASE/agents.md` | The app's briefing, `text/markdown`. |
| `GET $BASE/tools.json` | The tool list (shape below). |
| `<METHOD> $BASE<path>` | Calls the tool registered for that method and path. |
| `GET $BASE/_as_tasks/<taskId>` | Status of an async tool call. |

If the app's `agentsMd` contains neither the marker `<!-- as:contract-v1 -->` nor the string `tools.json`, the relay prepends a short section telling the agent what `$BASE` is, to read `tools.json`, how to call a tool, and what the error codes mean. `defaultAgentsMd()` in the SDK includes that section already.

`tools.json`:

```json
{
  "version": "1.0",
  "app": { "id": "minimal-example", "name": "minimal-example", "description": "" },
  "tools": [
    { "method": "POST", "path": "/increment", "description": "Add `by` to the counter.",
      "input_schema": { "type": "object", "properties": { "by": { "type": "integer" } } } }
  ]
}
```

`app.name` is the app id. `app.description` is the register frame's `appDescription`. `input_schema` is a JSON Schema for the request body and is passed through unchecked.

### Tool calls

The relay forwards the method, the path after `$BASE`, the raw body as a string, the `content-type` header and the agent's `x-*` headers (except `x-real-ip` and `x-forwarded-*`). The agent's IP address is not forwarded.

The app's reply becomes the HTTP response:

- `status` must be 200-599, otherwise the agent gets `502 protocol_error`.
- If `headers` has a `content-type` and `body` is a string, the body is sent as-is with that content type. `text/html`, `application/xhtml+xml`, `image/svg+xml`, `application/xml`, `text/xml` and any `*+xml` type are downgraded to `text/plain`. Other headers are ignored.
- Otherwise `body` is JSON-encoded with `application/json` (an absent body gives an empty response).
- Every tool and task response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`. App output is served from the relay's origin and must never run as script there.

### Async calls

A handler that needs longer than the sync timeout (30 s) replies `status: 202` with a `taskId` (`[A-Za-z0-9_-]{1,64}`). The agent gets `202 {"taskId": "..."}` and polls `GET $BASE/_as_tasks/<taskId>`:

- `202 {"taskId": "...", "completed": false}` while running.
- The final status and body once the app sends `task_complete`. This answer is returned once; the task is then deleted and further polls get `404`.

A session holds at most 100 pending tasks (`503 too_many_tasks` beyond that). A `task_complete` with an unknown `taskId`, a status outside 200-599, or a body over 64 KiB as JSON is dropped. Tasks survive a resume and are lost when the session ends.

### CSRF

Tool calls run app code with side effects, so the relay refuses tool calls that come from a web page: any request whose `Sec-Fetch-Site` header is present and not `none` gets `403 csrf_denied`. Browsers always send this header and page scripts cannot change it. curl, server-side fetchers and AI tool runtimes don't send it, and a link opened from the address bar, a bookmark or another app sends `none`. `agents.md`, `tools.json` and `_as_tasks/<id>` are read-only and exempt, so a link preview still works.

Not covered: Safari before 16.4 omits the header, and requests made by a browser extension's service worker send `none`.

### Errors

Relay errors have the body `{"error": {"code": "...", "message": "..."}}`.

| Status | Code | When |
|---|---|---|
| 400 | `protocol_error` | `/v1/_ws` without a WebSocket upgrade, a bad `?session=` value, or a WebSocket upgrade on an agent URL. |
| 401 | `token_invalid` | Token unknown, revoked, or for another session. |
| 403 | `csrf_denied` | See CSRF. |
| 404 | `not_found` | Malformed token, no tool for that method and path, unknown task, unknown `/_as_*` path, or unknown route. |
| 413 | `body_too_large` | Request body over 1 MiB. |
| 429 | `too_many_inflight` | 100 calls already in flight on this session. |
| 429 | `rate_limited` | Too many `/v1/_ws` upgrades from one IP. |
| 502 | `protocol_error` | The app replied with an invalid status, task id or response. |
| 503 | `app_offline` | No live session, or the app's socket dropped during the call. While the app is reconnecting, tool calls also get `Retry-After: 2`. |
| 503 | `too_many_tasks` | 100 pending async tasks. |
| 504 | `tool_timeout` | No reply within the sync timeout. |

When a session does not exist, every request with a well-formed token gets `503 app_offline`, so the relay does not reveal which tokens once existed. The message tells the agent what to do: "The app is not connected to this link. If this keeps happening, the link is probably stale: ask the user to reconnect the app (in the Agent Socket extension: open it and copy the current link) and share the new link." While the app is reconnecting within the grace window, the message is "The app is reconnecting. Retry in a few seconds."

Errors the app returns are passed through as the app wrote them. The SDK replies `500 {"error": {"code": "handler_error"}}` when a handler throws, and `404 not_found` when no handler matches.

## App surface (WebSocket)

Connect to `wss://agentsocket.dev/v1/_ws`. Every frame is a JSON text message with a `type`. Request frames carry an `id` (any string), and the reply carries the same `id`. Non-JSON frames and unknown types are ignored.

### register

The first frame on a new socket. It must arrive within 10 s (otherwise close `4408`).

```json
{ "type": "register", "appId": "minimal-example", "agentsMd": "# Counter\n...",
  "appDescription": "optional, cut to 1024 chars",
  "tools": [ { "method": "POST", "path": "/increment", "description": "...", "input_schema": {} } ] }
```

- `agentsMd` is at most 65,536 characters.
- `method` defaults to `POST` and is upper-cased. `path` must match `^/[a-zA-Z0-9_\-/.]+$`. Paths are static; there are no path parameters.
- Reserved paths: `/agents.md`, `/tools.json` and anything under them (case-insensitive), and anything starting with `/_as_`.
- The same method and path twice is an error.

Success:

```json
{ "type": "register_reply", "ok": true, "sessionId": "Q7R5X2KM", "resumeSecret": "<43 chars>" }
```

Failure is `{"type": "register_reply", "ok": false, "error": {"code", "message"}}` followed by a close:

| Code | Close |
|---|---|
| `invalid_app_id` | 4001 |
| `agents_md_too_large` | 4413 |
| `reserved_path`, `protocol_error` (bad tools) | 4400 |

A second `register` on a registered socket gets `ok: false, protocol_error` and changes nothing. Before `register` succeeds, only `ping` and `pong` are accepted; mint, revoke and list get `ok: false, protocol_error`.

### Tokens

```json
{ "type": "mint_agent_token", "id": "1", "label": "user-42" }
{ "type": "mint_agent_token_reply", "id": "1", "ok": true, "token": "as_Q7R5X2KM_...",
  "url": "__BASE__/v1/t/as_Q7R5X2KM_.../agents.md", "label": "user-42", "expiresAt": null }
```

The relay does not know its public hostname, so `url` starts with the literal `__BASE__`. The client replaces it with the base URL it connected to. Labels are cut to 256 chars. A session holds at most 50 tokens; beyond that the reply is `ok: false, error: {code: "too_many_tokens"}`.

```json
{ "type": "revoke_agent_token", "id": "2", "token": "as_Q7R5X2KM_..." }
{ "type": "revoke_agent_token_reply", "id": "2", "ok": true }

{ "type": "list_agent_tokens", "id": "3" }
{ "type": "list_agent_tokens_reply", "id": "3", "tokens": [ { "token", "url", "label", "mintedAt" } ] }
```

`revoke` replies `ok: false` if the token was not active.

### Tool calls

```json
{ "type": "tool_call", "id": "<uuid>", "method": "POST", "path": "/increment",
  "body": "{\"by\":2}", "headers": { "content-type": "application/json" } }
{ "type": "tool_reply", "id": "<uuid>", "status": 200, "body": { "count": 2 } }
```

Optional `tool_reply` fields: `headers` (only `content-type` is used) and `taskId` (with `status: 202`, see Async calls). The async result:

```json
{ "type": "task_complete", "taskId": "t1", "status": 200, "body": { "done": true } }
```

`task_complete` has no reply.

### update_tools

A registered app can replace its tools without changing any link:

```json
{ "type": "update_tools", "id": "u1", "tools": [ { "method": "POST", "path": "/b", "description": "…" } ], "agentsMd": "# optional" }
{ "type": "update_tools_reply", "id": "u1", "ok": true }
```

The list is validated like `register`'s and replaces the old one; `agentsMd` is replaced only when present. On error (`reserved_path`, `protocol_error`, `agents_md_too_large`) nothing changes and the socket stays open. A later `resume` carries the full registration again, so resume with the current tools.

### Liveness

```json
{ "type": "ping", "id": "p1" }
{ "type": "pong", "id": "p1" }
```

The relay answers `ping` with `pong` and never sends its own pings. Any frame from the app counts as a sign of life. If the app is silent for 50 s (`HEARTBEAT_TIMEOUT_MS`), the relay closes the socket with `4408` and holds the session for resume. The SDK pings every 25 s.

## Session lifecycle and resume

A session starts with `register` and ends when:

- the app closes with code `1000`,
- the app breaks the protocol (bad register, frame over 4 MiB), or
- the app's socket is gone for longer than the grace window (`RESUME_GRACE_MS`, 60 s).

Ending a session drops its registration, tokens and tasks. Any other drop (network loss, close codes other than 1000, liveness timeout) keeps the session for the grace window. During that window `agents.md` and `tools.json` still work, tool calls get `503 app_offline` with `Retry-After: 2`, and calls that were in flight at the drop fail with `503`.

To resume, open `wss://agentsocket.dev/v1/_ws?session=<sessionId>` and send `resume` as the first frame within 10 s. The secret goes in the frame, not the URL, so it stays out of logs.

```json
{ "type": "resume", "sessionId": "Q7R5X2KM", "secret": "<resumeSecret>",
  "appId": "...", "agentsMd": "...", "appDescription": "...", "tools": [ ... ],
  "revokeTokens": [ "as_Q7R5X2KM_..." ] }
```

- The registration fields are validated like `register` and replace the old registration. Tokens and tasks carry over.
- `revokeTokens` (optional, up to 50) are revoked before the app goes live, for tokens revoked while offline.
- Success: `{"type": "register_reply", "ok": true, "sessionId", "resumeSecret", "resumed": true}`. The secret stays the same. Every agent URL keeps working.
- If a socket is still attached to the session, it is closed with `4410` and its in-flight calls fail.
- A wrong secret, an ended session and an unknown session all get `ok: false, error: {code: "resume_failed"}` and close `4401`. The secret is compared in constant time.
- A socket on `?session=` can do nothing else before it resumes. At most 4 such sockets can wait per session (`4409` beyond that).

State lives only in memory. If Cloudflare evicts or restarts the Durable Object, the session is gone and resume gets `4401`. The client then registers a new session and mints new links. The old links answer `503 app_offline` from then on, so the app should show the user the new link and say the old one stopped working (the SDK's `onSessionChanged` reports the new URLs and a `reason`).

## Close codes

| Code | Sent by | Meaning |
|---|---|---|
| 1000 | app | Done. Ends the session at once. |
| 1009 | relay | Frame over 4 MiB. Ends the session. |
| 4001 | relay | Invalid app id. |
| 4400 | relay | Invalid tools, reserved path, WebSocket on the wrong path, or `resume` without `?session=`. |
| 4401 | relay | Resume refused. |
| 4408 | relay | No `register`/`resume` within 10 s, or liveness timeout. |
| 4409 | relay | Session already has an app, or too many pending resume sockets. |
| 4410 | relay | Replaced by a resume using this session's secret. |
| 4413 | relay | `agentsMd` too large. |

## Limits

| Limit | Value |
|---|---|
| Agent request body | 1 MiB |
| WebSocket frame from the app | 4 MiB |
| `agentsMd` | 65,536 characters |
| `appDescription` / token label | 1024 / 256 chars (truncated) |
| Tokens per session | 50 |
| Calls in flight per session | 100 |
| Pending async tasks per session | 100; result body 64 KiB |
| Sync tool timeout | 30 s (`MAX_SYNC_TOOL_MS`) |
| Register / resume deadline | 10 s |
| App liveness timeout | 50 s (`HEARTBEAT_TIMEOUT_MS`) |
| Resume grace window | 60 s (`RESUME_GRACE_MS`) |
| `/v1/_ws` upgrades | 100 per 10 s per IP, counted per Cloudflare location |

## Threat model

- **The link is the key.** Anyone who has an agent URL can call every tool in the session until the token is revoked or the session ends. Links pasted into a chat stay in its history. Only expose tools you are willing to give to whoever ends up with the link.
- **The session id is public.** Holding it gives no access. Agent calls need the token's verifier; taking over the app side needs the resume secret.
- **App ids are labels.** The relay does not check `Origin` or app identity, because non-browser apps can send any value.
- **The relay sees traffic.** Tool calls and replies pass through the relay in plaintext after TLS. It holds them in memory only until they are delivered (async results until polled) and writes nothing to storage.
- **Content is untrusted in both directions.** The app receives whatever the agent sends, and the AI reads whatever the app returns. App output can contain prompt injection; agent input can be anything.
- **Not covered:** a malicious app (it controls its own tools and briefing), a compromised relay operator, and DoS beyond the per-IP and per-session caps above.
