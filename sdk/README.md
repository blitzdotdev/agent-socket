# `@agent-socket/sdk`

JS/TS client for [agent-socket](https://github.com/teenybase/agentsocket) — connect any web app to AI chats via paste-able URLs.

Works in Node, Cloudflare Workers, and the browser. No MCP, no OAuth, no server-side AI integration — the AI calls plain HTTP endpoints you define.

## Install

```bash
npm install @agent-socket/sdk
```

> v0 — not yet published. For now, vendor from the [repo](https://github.com/teenybase/agentsocket) or use a workspace dep.

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
- **`tools[]`** — `{ method?, path, description, input_schema?, handler }`. Handler receives `{ method, path, body, headers }`, returns `{ status?, body? }` or just a value (defaults to status 200).
- **`baseUrl`** — defaults to `https://agentsocket.dev`. Override for self-hosted relays or local dev.
- **`autoReconnect`** — defaults to `true`. The SDK handles WS drops with exponential backoff and re-mints any previously-issued tokens under the new session-id, reporting the remap via `onSessionChanged`.

### `session.mintAgentToken({ label }): Promise<AgentToken>`

Generates a fresh paste-able URL for one agent. Returns `{ token, url, label }`. The URL is what you copy into a "Connect with AI" button.

### `session.listAgentTokens()` / `session.revokeAgentToken(token)`

Standard CRUD for the session's tokens.

### `session.close()`

Tear down the WS. Stops accepting tool calls.

## Async tools (long-running work)

If a tool exceeds the relay's `MAX_SYNC_TOOL_MS` (default 30 s), it can be reported as async: return `{ status: 202, taskId: "<your-id>" }` from the handler, then later call `session.completeTask(taskId, { status: 200, body: { ... } })`. The agent polls `<URL>/_as_tasks/<taskId>` to retrieve the result.

## Reconnect + remint semantics

By default, if the WS drops, the SDK reconnects with exponential backoff and re-mints all previously-issued agent-tokens under the new session-id (keeping the same labels). Old URLs become dead; the new URLs are reported via `onSessionChanged({ priorSessionId, sessionId, tokensRemapped })`.

Override `onDisconnect` to control timing, or set `autoReconnect: false` for full manual control.

## Threat model

agent-socket v0 has **no authentication beyond URL secrecy**. Anyone with an agent-token URL can call your tool handlers. Treat URLs as DM-grade secrets. Don't expose write-heavy tools without thinking about who you're handing the URL to.

The SDK doesn't add auth — that's a v1 concern at the relay layer.

See the parent [`README.md`](../README.md) and [`SECURITY.md`](../SECURITY.md) for the full picture.

## Examples

- [`examples/pixel-art-canvas/`](../examples/pixel-art-canvas/) — vanilla JS pixel-painting demo. Single HTML file, no build, ~120 lines of JS.
- [`chrome-extension/`](../chrome-extension/) — the chrome extension is itself an SDK consumer (technically uses a slim re-implementation `lib/as-client.js`, but speaks the same protocol).

## Browser usage

The SDK works in browsers without polyfills. WebSocket is native; the `ws` peer-dep is only loaded in Node environments where the global doesn't exist.

```js
// In a <script type="module"> or via your bundler:
import { connect } from "@agent-socket/sdk"
// ... same API ...
```

## License

[Apache 2.0](../LICENSE).
