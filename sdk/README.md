# `@agent-socket/sdk`

JS/TS client for [agent-socket](https://github.com/blitzdotdev/agent-socket) — connect any web app to AI chats via paste-able URLs.

Works in Node 22+, Cloudflare Workers, and the browser (uses the native `WebSocket`; no dependencies). No MCP, no OAuth, no server-side AI integration — the AI calls plain HTTP endpoints you define.

## Install

```bash
npm install @agent-socket/sdk
```

## Quick start

```ts
import { connect } from "@agent-socket/sdk"

const session = await connect({
  appId: "as_app_anon",  // anonymous mode; no registration required
  appDescription: "32x32 pixel canvas the AI can paint.",
  agentsMd: "# briefing for AIs that join this app",
  tools: [
    {
      path: "/set_pixel",
      description: "Paint one pixel (x, y, color).",
      handler: async ({ body }) => {
        const { x, y, color } = JSON.parse(body)
        // ... your logic ...
        return { ok: true }
      },
    },
  ],
})

// Mint an agent-token URL to paste into an AI chat:
const link = await session.mintAgentToken({ label: "user-42" })
console.log("Paste this:", link.url)
```

When the user pastes that URL into Claude/ChatGPT/Gemini/etc, the AI:

1. Fetches `<URL>/agents.md` (your briefing) to learn the app.
2. Fetches `<URL>/tools.json` for the machine-readable schema.
3. POSTs to `<URL>/set_pixel` etc. as tool calls.

Each call is forwarded over the WebSocket to your `handler`, the result is returned over HTTPS to the AI.

## API surface

### `connect(opts: ConnectOptions): Promise<Session>`

Opens a WebSocket to the relay, registers your app + tools, returns a `Session`.

Key `opts`:

- **`appId`** — public, hardcoded in client code. Same role as a Google OAuth client ID or Supabase anon key. `as_app_anon` is the anonymous demo app; for production register your own.
- **`agentsMd`** — markdown briefing served at `<URL>/agents.md`. Use `defaultAgentsMd({...})` for a template, or write your own.
- **`appDescription`** — 1-3 sentence summary surfaced in `tools.json`.
- **`tools[]`** — `{ method?, path, description, input_schema?, handler }`. Handler receives `{ method, path, body, headers }`, returns `{ status?, body?, headers? }` (or just a value — defaults to status 200, JSON body). If `headers["content-type"]` is set AND `body` is a string, the relay serves it verbatim with that content-type — useful for HTML/text/CSV/shell-script tools. Non-string bodies always JSON-encode in v0.
- **`baseUrl`** — defaults to `https://agentsocket.dev`. Override for self-hosted relays or local dev.
- **`autoReconnect`** — defaults to `true`. The SDK handles WS drops with exponential backoff and resumes the same session, so every agent URL keeps working. Only if the session is gone does it open a new one and re-mint the previously-issued tokens, reporting the remap via `onSessionChanged`. With `false` the SDK neither reconnects nor re-mints. See [Reconnect, resume and re-mint](#reconnect-resume-and-re-mint).
- **`onReconnect`** — called after every successful reconnect with `{ sessionId, resumed }`.
- **`resume`** — `{ sessionId, secret }` of a session this app opened earlier, to reattach after a page or worker restart. See below.

### `session.mintAgentToken({ label }): Promise<AgentToken>`

Generates a fresh paste-able URL for one agent. Returns `{ token, url, label }`. The URL is what you copy into a "Connect with AI" button.

### `session.listAgentTokens()` / `session.revokeAgentToken(token)`

Standard CRUD for the session's tokens.

### `session.completeTask(taskId, { status?, body? })`

Completes an async task previously started by a handler that returned `{ status: 202, taskId }`. Fire-and-forget — no reply. Throws if the WS is closed or `taskId` is empty. `status` defaults to 200.

Async tasks live in the relay's Durable Object memory. They survive a resumed reconnect, so a handler can still complete a task after a blip. They do **not** survive a new session: after `onSessionChanged` fires, taskIds from the prior session are dead — the agent's poll on the old paste-URL will already be returning errors.

### `session.close()`

Tear down the WS. Stops accepting tool calls.

## Async tools (long-running work)

If a tool exceeds the relay's `MAX_SYNC_TOOL_MS` (default 30 s), report it as async:

```ts
tools: [
  {
    path: "/render_report",
    description: "Kick off a long-running report.",
    handler: async ({ body }) => {
      const taskId = crypto.randomUUID()
      // start the work without awaiting it
      queueMicrotask(async () => {
        const result = await doExpensiveWork(body)
        session.completeTask(taskId, { status: 200, body: result })
      })
      return { status: 202, taskId }
    },
  },
]
```

The agent gets `202 { taskId }` immediately, then polls `<URL>/_as_tasks/<taskId>` until it returns 200 with the body.

## Reconnect, resume and re-mint

`register_reply` gives the SDK a resume secret (`session.resumeSecret`). When the WS drops, the relay holds the session (tools, tokens, async tasks) for a grace window (60 s on `agentsocket.dev`). On reconnect the SDK opens `/v1/_ws?session=<id>` and sends the secret in its first frame, with the current tools and `agentsMd`, which replace the old ones. If the relay accepts, nothing changes for agents: **the same URLs keep working**, `onSessionChanged` doesn't fire, and `onReconnect` reports `{ resumed: true }`.

While the app is away, agents still get `agents.md` and `tools.json`; tool calls get `503 app_offline` with `Retry-After: 2`. A call in flight when the socket dropped fails with `503`.

If the relay refuses the resume (close `4401`: the grace window ran out, the relay restarted, or the secret is wrong), the SDK opens a fresh session in the same attempt and re-mints every token still in use under the new session-id, keeping the labels. Old URLs become dead; the new ones are reported via `onSessionChanged({ priorSessionId, sessionId, tokensRemapped })`. If another connection resumes the session with this app's secret, the relay closes this socket with `4410`, and this SDK starts a fresh session instead of taking it back.

`session.close()` closes with code 1000, which ends the session on the relay immediately — no grace window.

If the initial `connect()` fails it rejects and nothing retries. After a drop, `onDisconnect` fires once per attempt (`attempt` 1, 2, …) until a reconnect succeeds; every attempt tries the resume first. Tokens survive failed attempts. A token revoked while disconnected is revoked on the relay as part of the resume (and isn't re-minted if the session is new).

Override `onDisconnect` to control timing, or set `autoReconnect: false` for full manual control (the SDK doesn't reconnect; your `onDisconnect`, if any, may still call `reconnect()`, which resumes when it can and doesn't re-mint when it can't).

### Surviving a restart

To keep URLs alive across a page reload or a Chrome MV3 service-worker restart, save `{ sessionId: session.sessionId, secret: session.resumeSecret }` and pass it back as `connect({ ..., resume })`. If the session is still held, `connect()` resolves with the same `sessionId` and adopts its live tokens; otherwise it opens a fresh session (compare `sessionId` to tell, then mint new URLs). The secret plus the session-id lets anyone take over the session, so store it no more widely than the agent URLs themselves — e.g. `sessionStorage` or `chrome.storage.session`, not `localStorage`.

## Threat model

agent-socket v0 has **no authentication beyond URL secrecy**. Anyone with an agent-token URL can call your tool handlers. Treat URLs as DM-grade secrets. Don't expose write-heavy tools without thinking about who you're handing the URL to.

The SDK doesn't add auth — that's a v1 concern at the relay layer.

See the main [`README.md`](https://github.com/blitzdotdev/agent-socket#readme) and [`SECURITY.md`](https://github.com/blitzdotdev/agent-socket/blob/master/SECURITY.md) for the full picture.

## Examples

- [`examples/pixel-art-canvas/`](https://github.com/blitzdotdev/agent-socket/tree/master/examples/pixel-art-canvas) — vanilla JS pixel-painting demo. Single HTML file, no build, ~120 lines of JS.
- [`chrome-extension/`](https://github.com/blitzdotdev/agent-socket/tree/master/chrome-extension) — the chrome extension is itself an SDK consumer; the compiled SDK is vendored at `chrome-extension/lib/sdk/` (see `chrome-extension/scripts/vendor-sdk.sh`) so the extension can load-unpacked with no build step.

## Browser usage

The SDK works in browsers without polyfills.

```js
// In a <script type="module"> or via your bundler:
import { connect } from "@agent-socket/sdk"
// ... same API ...
```

## License

[Apache 2.0](LICENSE).
