# @agent-socket/sdk

Client for [Agent Socket](https://github.com/blitzdotdev/agent-socket). Your app registers tools and gets a link; an AI chat that has the link calls the tools over HTTPS, and the SDK runs your handlers.

Runs in browsers, Cloudflare Workers and Node 22+ on the built-in `WebSocket`. No dependencies.

```bash
npm i @agent-socket/sdk
```

In a page without a bundler: `import { connect } from "https://esm.sh/@agent-socket/sdk@0.1"`.

## Example

```js
import { connect } from "@agent-socket/sdk"

let count = 0
const session = await connect({
  appId: "minimal-example",
  agentsMd: "# Counter\nA process with one counter. Call /increment to add to it.",
  tools: [{
    path: "/increment",
    description: "Add `by` (default 1) to the counter. Returns the new count.",
    input_schema: { type: "object", properties: { by: { type: "integer" } } },
    handler: ({ body }) => ({ count: (count += JSON.parse(body || "{}").by ?? 1) }),
  }],
})
const link = await session.mintAgentToken({ label: "user-42" })
console.log(link.url)  // https://agentsocket.dev/v1/t/as_.../agents.md
```

The AI fetches `agents.md` and `tools.json` from the link, then calls `POST <link without /agents.md>/increment`. Each call reaches your handler over the WebSocket, and the return value goes back as the HTTP response. More examples: [examples/](https://github.com/blitzdotdev/agent-socket/tree/master/examples).

## `connect(options): Promise<Session>`

Opens the WebSocket, registers, and resolves once the relay accepts. If this first attempt fails, the promise rejects and nothing retries.

| Option | |
|---|---|
| `appId` | Label shown in `tools.json`, `[A-Za-z0-9_.-]{1,64}`. Not a credential and not checked. |
| `agentsMd` | Markdown briefing served at `<link>/agents.md`, up to 65,536 characters. Describe your app; the relay adds the calling instructions unless the text mentions `tools.json`. |
| `appDescription` | Optional short description, shown in `tools.json`. |
| `tools` | `{ method?, path, description, input_schema?, handler }[]`. `method` defaults to `POST`. `path` is static, e.g. `/set_pixel`; `/agents.md`, `/tools.json` and `/_as_*` are reserved. |
| `baseUrl` | Relay URL. Default `https://agentsocket.dev`. |
| `autoReconnect` | Default `true`. See [Reconnects](#reconnects). |
| `onDisconnect` | `({ reason, code?, attempt, reconnect, giveUp }) => void`. Called on a drop and after each failed attempt. `code` is the WebSocket close code when a socket closed. Default: `exponentialBackoff()`, or `giveUp()` when `autoReconnect` is false. |
| `onReconnect` | `({ sessionId, resumed }) => void`. Called after every successful reconnect. |
| `onSessionChanged` | `({ priorSessionId, sessionId, tokensRemapped, reason, closeCode?, offlineMs }) => void`. Called after a reconnect when links changed. `tokensRemapped` maps old URL to new URL; `reason` says why (see [Reconnects](#reconnects)). |
| `resume` | `{ sessionId, secret }` of an earlier session, to keep its links after a restart. See [Surviving a restart](#surviving-a-restart). |
| `heartbeatIntervalMs` | Ping after this long without traffic. Default 25000. |
| `heartbeatTimeoutMs` | Close and reconnect if no pong arrives within this. Default 50000. |

### Handlers

A handler gets `{ method, path, body, headers }`. `body` is the raw request body as a string (usually JSON). `headers` has the `content-type` and the agent's `x-*` headers.

Return either:

- any value: sent as JSON with status 200, or
- `{ status, body?, headers?, taskId? }`: any object with a numeric `status` is read this way. If `headers` sets `content-type` and `body` is a string, the body is sent as-is with that type (HTML and XML types are served as `text/plain`). Other headers are ignored.

A handler that throws produces `500 {"error": {"code": "handler_error", "message": ...}}`.

## Session

| Member | |
|---|---|
| `sessionId` | Current session id. Changes only when a reconnect can't resume. |
| `connected` | `true` while the socket is open and registered. |
| `resumeSecret` | Secret for resuming this session. Treat it like the links. |
| `mintAgentToken({ label })` | New link: `{ token, url, label, expiresAt: null }`. Up to 50 per session (rejects with `mint failed: too_many_tokens`). |
| `listAgentTokens()` | Active links, with `mintedAt`. Needs a live connection. |
| `revokeAgentToken(token)` | Kills a link. While disconnected, the revoke is sent with the next resume. |
| `updateTools(tools, agentsMd?)` | Replaces the tool list (and `agentsMd` if given) on the live session; every link keeps working. Rejects if the relay refuses the list, and then nothing changes. Calls run in order; while disconnected it waits for the reconnect. |
| `completeTask(taskId, { status?, body?, headers? })` | Finishes an async call. Throws if not connected. |
| `ping()` | Sends a heartbeat now, e.g. from a `chrome.alarms` handler in an MV3 service worker. |
| `close()` | Closes with code 1000. The relay ends the session at once and every link stops working. |

## Async tools

The relay waits up to 30 s for a reply. For longer work, return `202` with a task id and finish later:

```js
{
  path: "/render_report",
  description: "Start a report. Poll the returned task.",
  handler: ({ body }) => {
    const taskId = crypto.randomUUID()
    renderReport(body).then((result) => session.completeTask(taskId, { body: result }))
    return { status: 202, taskId }
  },
}
```

The agent gets `202 {"taskId": "..."}` and polls `<link base>/_as_tasks/<taskId>` until it gets the result. Task ids must match `[A-Za-z0-9_-]{1,64}`. Tasks survive a resumed reconnect but not a new session.

## Reconnects

When the socket drops, the relay keeps the session for 60 s. With `autoReconnect` on (the default), the SDK backs off via `onDisconnect`, reconnects and resumes the same session with its secret. On success every link keeps working, `onReconnect` gets `resumed: true`, and `onSessionChanged` is not called. While the app is away, agents still get `agents.md` and `tools.json`, and tool calls get `503 app_offline` with `Retry-After: 2`.

If the relay refuses the resume (the 60 s passed, or the relay restarted), the SDK opens a new session in the same attempt and re-mints each link it still holds with the same label. The old URLs stop working; `onSessionChanged` reports the new ones so you can show them to the user. Tell the user plainly that the link changed: an AI still holding the old one only gets `503 app_offline`. Links revoked while offline are not re-minted.

`onSessionChanged`'s `reason` is one of:

| `reason` | `closeCode` | Meaning |
|---|---|---|
| `resume_refused` | 4401 | The relay no longer had the session: the app was away longer than the grace window, or the relay restarted. (A wrong secret gets the same answer.) |
| `replaced` | 4410 | Another connection resumed the session with its secret, so the SDK started a fresh one instead of taking it back. |
| `no_resume_secret` | | The relay never issued a resume secret, so there was nothing to resume. |
| `remint` | | Same session; links an earlier, interrupted re-mint missed were minted now. |

`offlineMs` is the time from the last frame the relay sent on the old connection to the new registration, roughly how long the app was unreachable (it can overstate a quiet connection by up to one heartbeat interval). Over 60 s means the outage outlasted the grace window; much less points at a relay restart.

With `autoReconnect: false` the SDK neither reconnects nor re-mints. Your `onDisconnect` can still call `reconnect()`, which resumes when possible; if it lands in a new session, the old links are gone and `tokensRemapped` is empty.

Backoff helpers for `onDisconnect`: `exponentialBackoff({ baseMs = 1000, maxMs = 30000, jitter = 0.25 })`, `linearBackoff({ delayMs = 5000 })`, `noBackoff()`.

### Surviving a restart

To keep links across a page reload or a service-worker restart, save `{ sessionId: session.sessionId, secret: session.resumeSecret }` and pass it as `resume` to the next `connect()`. If the session is still held, you get the same `sessionId` and its links keep working. If not, `connect()` opens a new session; compare `sessionId` to tell, and mint new links. Store the secret no more widely than the links themselves (`sessionStorage` or `chrome.storage.session`, not `localStorage`).

## `defaultAgentsMd(options)`

Builds a briefing with the calling instructions, a "save this URL" line and sections for what the AI can and cannot do: `{ appName, appDescription, agentsMdUrl, capabilities?, limitations?, conventions? }`. `agentsMdUrl` is shown to the AI as the URL to re-fetch; `"$BASE/agents.md"` works.

## Security

Anyone with a link can call your tools until you revoke it or the session ends. Only register tools you are willing to give to whoever ends up with the link. See [SECURITY.md](https://github.com/blitzdotdev/agent-socket/blob/master/SECURITY.md) and the [protocol](https://github.com/blitzdotdev/agent-socket/blob/master/docs/protocol.md).

## License

[Apache 2.0](https://github.com/blitzdotdev/agent-socket/blob/master/LICENSE)
