# agent-socket protocol (v1)

Three parties:

- The **app** holds a WebSocket to the relay and runs the tool handlers.
- The **agent** (an AI chat, or anything that speaks HTTP) calls tools over HTTPS.
- The **relay** pairs them. It runs one Durable Object per session and keeps the session in that object's storage (see [Storage](#storage)).

```
app ──WebSocket /v1/_ws──▶ relay ◀──HTTPS /v1/t/<token>/…── agent
```

The examples use `https://agentsocket.dev`. A self-hosted relay serves the same paths.

## Identifiers

| Name | Format | Secret? |
|---|---|---|
| session id | 8 chars Crockford base32 (`0-9A-Z` without `I L O U`), 40 bits. Assigned by the relay. | No. It is part of every agent URL and routes requests to the session's Durable Object. |
| agent token | `as_<sessionId>_<verifier>`, 35 chars. The verifier is 16 random bytes as 22 chars base64url. | Yes. It is the only credential an agent needs. |
| resume secret | 32 random bytes as 43 chars base64url. Sent to the app in `register_reply`. | Yes. Only the app should hold it. The relay stores only a value derived from it. |
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

A session holds at most 100 pending tasks (`503 too_many_tasks` beyond that). A `task_complete` with an unknown `taskId`, a status outside 200-599, a body over 64 KiB as UTF-8 JSON, or a `content-type` over 256 characters is dropped. Tasks are stored with the session: they survive a resume and a relay restart, and are lost when the session ends.

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
| 503 | `app_offline` | No live session, or the app's socket dropped during the call. While the session is held for the app to reconnect, tool calls also get `Retry-After: 2`. |
| 503 | `too_many_tasks` | 100 pending async tasks. |
| 504 | `tool_timeout` | No reply within the sync timeout. |

When a session does not exist, every request with a well-formed token gets `503 app_offline`, so the relay does not reveal which tokens once existed. The message tells the agent what to do: "The app is not connected to this link. If this keeps happening, the link is probably stale: ask the user to reconnect the app (in the Agent Socket extension: open it and copy the current link) and share the new link." While the session is held for the app, the message is "The app is reconnecting (offline for 3 min). Retry in a few seconds. If it stays offline, ask the user to check that the app is open and online; this link keeps working once it reconnects."

Errors the app returns are passed through as the app wrote them. The SDK replies `500 {"error": {"code": "handler_error"}}` when a handler throws, and `404 not_found` when no handler matches.

## App surface (WebSocket)

Connect to `wss://agentsocket.dev/v1/_ws`. Every frame is a JSON text message with a `type`. Request frames carry an `id` (any string), and the reply carries the same `id`. Non-JSON frames and unknown types are ignored.

### register

The first frame on a new socket. It must arrive within 10 s (otherwise close `4408`; see [Limits](#limits) for when a client sees that close).

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
{"type":"ping","id":"as_hb"}
{"type":"pong","id":"as_hb"}
```

The relay answers `ping` with a `pong` carrying the same `id`, and never sends its own pings. The exact frame `{"type":"ping","id":"as_hb"}` (byte for byte, no spaces) is answered by the Cloudflare runtime itself without waking the session's Durable Object, so a hibernated session costs nothing while the app only pings; the SDK always sends that frame, every 25 s. A ping with any other id or spacing still works and gets the same reply from the relay, but wakes the object.

Any frame from the app, and any auto-answered heartbeat, counts as a sign of life. If the app is silent for 50 s (`HEARTBEAT_TIMEOUT_MS`), the relay closes the socket with `4408` and holds the session for resume. The check runs from a Durable Object alarm, so a dead socket is noticed within a few seconds of the deadline.

## Session lifecycle and resume

A session starts with `register` and ends when:

- the app closes with code `1000`,
- the app breaks the protocol (bad register, frame over the cap),
- the app sends `end` with the resume secret (below), or
- the app's socket is gone for longer than the hold (`RESUME_GRACE_MS`, 24 hours on agentsocket.dev).

Ending a session deletes its registration, tokens and tasks from memory and storage at once. Any other drop (network loss, laptop sleep, close codes other than 1000, liveness timeout, the relay restarting) keeps the session for the hold. During the hold `agents.md` and `tools.json` still work, tool calls get `503 app_offline` with `Retry-After: 2`, and calls that were in flight at the drop fail with `503`. The hold is a Durable Object alarm and the session is in storage, so it survives hibernation, eviction and relay restarts and deploys.

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
- A socket on `?session=` can do nothing else before it resumes (or ends the session). At most 4 such sockets can wait per session (`4409` beyond that).

When the resume is refused because the session ended (the hold ran out, or it was ended), the client registers a new session and mints new links. The old links answer `503 app_offline` from then on, so the app should show the user the new link and say the old one stopped working (the SDK's `onSessionChanged` reports the new URLs and a `reason`). A client should keep retrying the resume, with a capped backoff, for as long as the hold lasts: the SDK's default backoff never gives up and waits at most 30 s between attempts.

### end

An app that can't reconnect but wants its links dead now (the user pressed Stop while offline) opens `wss://agentsocket.dev/v1/_ws?session=<sessionId>` and sends, as the first frame:

```json
{ "type": "end", "sessionId": "Q7R5X2KM", "secret": "<resumeSecret>" }
{ "type": "end_reply", "ok": true }
```

The relay ends the session (closing a still-attached app socket with `1000`) and closes this socket with `1000`. A wrong secret or an unknown session gets `{"type": "end_reply", "ok": false, "error": {"code": "resume_failed"}}` and close `4401`. The SDK sends `end` when `session.close()` is called while disconnected, and exports `endSession()` for a saved id and secret.

## Storage

A session lives in its Durable Object's storage, through the key-value storage API, so both storage backends work:

| What | Stored as |
|---|---|
| Registration (`appId`, `appDescription`, `agentsMd`, tools) | JSON, split into chunks of 32,768 characters (a key-value-backed object caps a value at 128 KiB). Rewritten only when it changes. |
| Resume secret | Not stored. An HKDF-SHA-256 check value derived from it, compared in constant time on `resume` and `end`. |
| Tokens | The SHA-256 of each verifier (a request is checked by hashing its verifier), the label, the mint time, and the full token sealed with AES-256-GCM under a key derived from the resume secret. That key is held only while the app's socket is open (with the socket, not in storage), so `list_agent_tokens` works for a connected app and a copy of the storage alone yields no usable link. |
| Async tasks | Status, content type and the result body (UTF-8 JSON). |
| Hold | The deadline (`heldUntil`) and when the app went away, plus the alarm. |

In-flight tool calls are never stored: they fail when the app's socket drops. When a session ends, the relay deletes all of its storage and its alarm; an object without a session keeps nothing.

## Close codes

| Code | Sent by | Meaning |
|---|---|---|
| 1000 | app | Done. Ends the session at once. |
| 1000 | relay | The session was ended with `end`. |
| 1009 | relay | Frame over 4 MiB. Ends the session. |
| 4001 | relay | Invalid app id. |
| 4400 | relay | Invalid tools, reserved path, WebSocket on the wrong path, or `resume` without `?session=`. |
| 4401 | relay | Resume refused. |
| 4408 | relay | No `register`/`resume`/`end` within 10 s, or liveness timeout. |
| 4409 | relay | Session already has an app, or too many pending resume sockets. |
| 4410 | relay | Replaced by a resume using this session's secret. |
| 4413 | relay | `agentsMd` too large. |

## Limits

Every limit below is read from the relay code (`relay/src/relay-do.ts`, `relay/src/worker.ts`, `relay/wrangler.jsonc`) and checked by the integration harness (`harness/scenarios/<n>`) or, for Cloudflare's own limits, against the [Workers](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/) limits pages.

| Limit | Value | At the limit | Checked by |
|---|---|---|---|
| Agent request body | 1 MiB | `413 body_too_large`; nothing reaches the app | 45 |
| Frame from the app | 4,194,304 characters (bytes for a binary frame) | Close `1009` and **the session ends**: every link dies, not just the one call. Cloudflare's own cap on a received WebSocket message is 32 MiB. | 49 |
| `agentsMd` | 65,536 characters | `register`/`resume`: `agents_md_too_large`, close `4413`. `update_tools`: error reply, nothing changes. | 56, 62 |
| Tools | No count limit; the whole `register`/`resume` frame must fit the frame cap. Paths `^/[a-zA-Z0-9_\-/.]+$`, reserved paths refused, one tool per method and path. | `register`/`resume`: `reserved_path` or `protocol_error`, close `4400`. `update_tools`: error reply. | 16, 17, 56, 62 |
| `appDescription` / token label | 1,024 / 256 characters | Truncated | 62 |
| Tokens per session | 50 live tokens | Mint reply `ok: false`, `too_many_tokens` | 24 |
| Calls in flight per session | 100 | `429 too_many_inflight` | 23 |
| Sync tool timeout | 30 s (`MAX_SYNC_TOOL_MS`) | `504 tool_timeout`; a later reply is dropped | 28 |
| Pending async tasks per session | 100 | `503 too_many_tasks` | 39 |
| Async result | 64 KiB of UTF-8 JSON, `content-type` up to 256 characters, status 200-599 | `task_complete` dropped silently; the task stays pending | 39 |
| Register / resume / end deadline | 10 s | Close `4408`. A socket that never sent a frame sees the close complete up to ~10 s later: the Workers runtime finishes closing an unused hibernatable socket only when the object next goes idle. | 48 |
| Waiting resume sockets | 4 per session | Close `4409` | 62 |
| App liveness | 50 s without a frame or heartbeat (`HEARTBEAT_TIMEOUT_MS`) | Close `4408`; the session is held | 51, 61 |
| Resume hold | 24 hours (`RESUME_GRACE_MS`; `0` turns resume off) | The session ends: storage and alarm deleted, links get `503 app_offline`, a resume gets `4401` | 54, 58, 60 |
| Storage per session | Usually a few KiB. Worst case about 15 MiB: a registration at the frame cap (stored as UTF-16, up to 8 MiB), 50 tokens of under 0.5 KiB, 100 task results of 64 KiB. | Within Cloudflare's limits: values are kept under the 128 KiB cap of a key-value-backed object (2 MB for SQLite-backed); 10 GB per SQLite-backed object; 50 GB per account for key-value-backed objects | 62; Durable Objects limits |
| `/v1/_ws` upgrades | 100 per 10 s per IP | `429 rate_limited`. Best effort: counted separately in each Cloudflare location and eventually consistent ([rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), so a client spread over locations, or a fast burst, can get more through. | 90 |

**Tool replies.** A reply travels as one `tool_reply` frame, so its JSON (status, headers and body) has to fit in the 4,194,304-character frame cap, and going over ends the whole session (close `1009`) rather than failing one call. Binary data must be text: a screenshot returned as a base64 data URL inside the JSON grows by a third, so keep the image itself under about 3 MiB (use JPEG or a smaller viewport for big pages). Anything larger should be split across calls or served from elsewhere. Async results are stored and capped at 64 KiB. In the other direction, an agent's request body is capped at 1 MiB.

## Threat model

- **The link is the key.** Anyone who has an agent URL can call every tool in the session until the token is revoked or the session ends. Links pasted into a chat stay in its history. Only expose tools you are willing to give to whoever ends up with the link.
- **The session id is public.** Holding it gives no access. Agent calls need the token's verifier; taking over the app side needs the resume secret.
- **App ids are labels.** The relay does not check `Origin` or app identity, because non-browser apps can send any value.
- **The relay sees traffic.** Tool calls and replies pass through the relay in plaintext after TLS. Sync calls and replies are held in memory only until they are delivered. Async results are stored until polled or the session ends.
- **Sessions persist for up to 24 hours.** A dropped app's session (registration with `agents.md` and tool descriptions, token hashes and sealed tokens, async results) stays in Durable Object storage until the app resumes, ends it, or the hold runs out, and its `agents.md` and `tools.json` keep answering anyone with a link for that long. An app that is done should close with `1000` (or send `end`) so its links die at once. Storage holds no resume secret and no usable token: a copy of it can't resume the session or call tools, and revoked tokens are deleted, so they stay revoked through resumes, restarts and evictions.
- **Content is untrusted in both directions.** The app receives whatever the agent sends, and the AI reads whatever the app returns. App output can contain prompt injection; agent input can be anything.
- **Not covered:** a malicious app (it controls its own tools and briefing), a compromised relay operator, and DoS beyond the per-IP and per-session caps above.
