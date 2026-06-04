# agent-socket

A relay that lets any web app expose itself to AI chats via a paste-able URL.

```
[your app] ──WS──▶ [agent-socket relay] ◀──HTTPS── [AI chat (Claude / ChatGPT / Gemini)]
```

The agent-side surface is plain HTTPS that any chat can hit via curl-like tool use. **No MCP support required from the chat.** Your end-users click "Connect with AI", paste one URL into their AI chat, and the AI can drive your app via tool calls.

## Status

v0 — actively in development. 42 end-to-end scenarios passing across relay + SDK + chrome-extension demo + multi-AI channel. Protocol + SDK + reference demo + CLI chat-channel functional. Not production-ready (no auth on the relay; rate limits per-session only; no signup flow yet).

**Deployed at https://agentsocket.dev** (canonical) and https://aisocket.dev (alias) — both routes hit the same Worker.

**Deploys go through one script.** All wrangler operations (deploy, tail, rollback, status, dev) route through `scripts/deploy.sh`. Do not run `wrangler` ad-hoc — the script loads CF credentials from `.env` at the repo root (copy `.env.example` to `.env` and fill in `CLOUDFLARE_API_TOKEN`) so deployment is non-interactive and reproducible. The `account_id` is read from `relay/wrangler.jsonc` as the single source of truth.

## Quick start

```bash
npm install
npm run dev          # wrangler dev on http://localhost:8787

# In another terminal:
cd examples/pixel-art-canvas
python3 -m http.server 5173
# open http://localhost:5173/ in a browser
```

Click "Connect with AI", copy the URL, paste into Claude / ChatGPT / Gemini, ask it to paint something. The AI will call `/set_pixel` repeatedly and you'll watch the image appear.

## Build your own integration

```ts
import { connect, defaultAgentsMd } from "@agent-socket/sdk"

const session = await connect({
  appId: "as_app_anon",       // anon mode; no signup required
  appDescription: "What your app does in one sentence.",
  agentsMd: defaultAgentsMd({  // or write your own markdown
    appName: "My App",
    appDescription: "...",
    agentsMdUrl: "...",
  }),
  tools: [
    {
      path: "/do_thing",
      description: "Does the thing.",
      input_schema: { /* JSON Schema */ },
      handler: async ({ body }) => {
        const args = JSON.parse(body)
        // ...do the thing
        return { ok: true, result: "..." }
      },
    },
  ],
  baseUrl: "http://localhost:8787",  // your relay
})

// Mint a token to share with an end-user
const link = await session.mintAgentToken({ label: "user-42" })
console.log("Paste in your AI chat:", link.url)
```

## Layout

```
agent-socket/
├── relay/                # Cloudflare Worker + Durable Object via PartyServer
│   ├── src/              # worker.ts, relay-do.ts, tokens.ts, apps.ts, errors.ts, privacy.ts, types.ts
│   ├── apps.json         # registered app-ids + allowed origins
│   └── wrangler.jsonc    # CF config; default vars (no DEBUG)
├── sdk/                  # @agent-socket/sdk — JS/TS client (Node + browser)
│   └── src/              # index.ts, session.ts, transport.ts, backoff.ts, agents-md.ts
├── cli/                  # @agent-socket/cli — node CLI; ships `agent-socket channel`
│   ├── bin/              # agent-socket entry; dispatches to subcommands
│   ├── src/              # channel-host, channel-send/recv/watch/peers/stop, log-store, agents-md
│   └── README.md         # CLI usage (focus: channel — multi-participant chat)
├── chrome-extension/     # MV3 extension exposing the active tab as agent-socket tools
│   ├── background.js     # service worker; vendored SDK in lib/sdk/
│   ├── tools-lib/        # per-site tool profiles (github, x.com, reddit, docs.google, …)
│   └── scripts/          # vendor-sdk.sh — pulls sdk/dist/*.js into lib/sdk/
├── agent-bridge/         # per-user Node service exposing a local AI harness as agent-socket tools
├── examples/
│   └── pixel-art-canvas/ # vanilla JS demo, single HTML file
├── harness/              # runtime end-to-end test scenarios (Node)
│   ├── run.mjs           # entry: node harness/run.mjs <id|range|all>
│   └── scenarios/        # 01-70, all passing
├── issues/               # design + bug tracking; open/ vs closed/
├── docs/                 # (TBD: protocol.md, self-hosting.md)
├── PRIVACY.md            # privacy policy linked from the relay's /privacy page
├── SECURITY.md           # disclosure policy + known v0 trust-model limits
├── CONTRIBUTING.md       # how to file issues / open PRs
├── CHANGELOG.md          # Unreleased / Added / Fixed / Changed
└── LICENSE               # Apache 2.0
```

## Channel mode (CLI)

For multi-AI chat — two AIs (or an AI + a human + another AI, etc.) talking via a single paste-URL — see `cli/README.md`. Quick taste:

```bash
node cli/bin/agent-socket.mjs channel host --name claude-code
# → prints a URL. Paste it into any AI chat that can make HTTP POSTs
#   (Claude.ai with code-interpreter, ChatGPT, Claude Code, etc.).
node cli/bin/agent-socket.mjs channel watch       # tail the convo
node cli/bin/agent-socket.mjs channel send "hi"   # post as the host's user
```

See [`cli/README.md`](cli/README.md) for full channel-mode docs.

## Architecture in one paragraph

Each WebSocket session lives in its own Durable Object (built on PartyServer's `Server` class). The DO holds the WS, validates registered tool definitions, and maintains a request-correlation map: agent HTTPS request → generate request id → forward `tool_call` frame over WS to the app → app's `tool_reply` frame matches by id → resolve the original HTTPS response. Token format `as_<sessionId>_<verifier>`: 35 chars, 40-bit session-id (Crockford base32) used for DO routing, 128-bit verifier (base64url) checked against the DO's in-memory set. No persistence in v0 — DO dies on disconnect.

## Self-hosting

```bash
cd relay
npx wrangler deploy
```

`apps.json` registers app-ids and their allowed origins. Edit, redeploy. `TOKEN_PREFIX` (default `as`) is configurable via `wrangler.jsonc` `vars` for self-hosters who want a branded prefix.

## Testing

```bash
# Terminal 1
cd relay && npm run dev

# Terminal 2
node harness/run.mjs all          # 42 scenarios
node harness/run.mjs 22           # one scenario by id
node harness/run.mjs 20-29        # range
```

Scenarios are layered: 01–09 smoke, 10–19 raw WS protocol, 20–29 SDK + concurrency, 30–39 auth/origin/heartbeat/async, 40+ failure modes / reconnect.

## License

Apache 2
