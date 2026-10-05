# Agent Socket

Give an AI chat a link, and it can use your web page or app through plain HTTPS tool calls. No MCP server, no plugin in the chat.

## Let Claude use your browser tab

1. Download `agent-socket-extension.zip` from [Releases](https://github.com/blitzdotdev/agent-socket/releases/latest) (or <https://agentsocket.dev/download>) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder.
3. On the extension's **Details** page, turn on **Allow User Scripts** (Chrome 138+; on Chrome 135-137 Developer mode is enough).
4. Open the tab you want help with, click the Agent Socket icon, then **Connect this tab**. The first time, Chrome asks for permission to access sites.
5. Copy the link and paste it into Claude (ChatGPT and Gemini work too), then say what you want done.

The AI can read the page, click, type, scroll, navigate and take screenshots, in that tab only. While it has access, the page shows an "AI has access to this tab" bar with a **Stop** button and the toolbar icon shows an "AI" badge. **Stop**, **Stop & disconnect** in the popup, or closing the tab ends the session, and the link stops working.

More in [chrome-extension/README.md](chrome-extension/README.md).

## Add "Connect with AI" to your app

```bash
npm i @agent-socket/sdk
```

From [examples/minimal/index.html](examples/minimal/index.html):

```js
import { connect } from "https://esm.sh/@agent-socket/sdk@0.1"

let count = 0
document.querySelector("#connect").onclick = async () => {
  const session = await connect({
    baseUrl: "https://agentsocket.dev",
    appId: "minimal-example",
    agentsMd: "# Counter\nA page with one counter. Call /increment to add to it.",
    tools: [{
      path: "/increment",
      description: "Add `by` (default 1) to the counter. Returns the new count.",
      input_schema: { type: "object", properties: { by: { type: "integer" } } },
      handler: ({ body }) => {
        count += JSON.parse(body || "{}").by ?? 1
        document.querySelector("#count").textContent = count
        return { count }
      },
    }],
  })
  const link = await session.mintAgentToken({ label: "minimal" })
  document.querySelector("#link").textContent = `Paste this into your AI chat: ${link.url}`
}
```

The AI reads the link's `agents.md`, fetches `tools.json`, and calls `POST .../increment`. The handler runs in the page. The same app in Node is [examples/minimal/node.mjs](examples/minimal/node.mjs); a larger demo is [examples/pixel-art-canvas](examples/pixel-art-canvas). API reference: [sdk/README.md](sdk/README.md).

## How it works

```
your app ──WebSocket──▶ relay (agentsocket.dev) ◀──HTTPS── AI chat
```

The app opens a WebSocket to the relay, registers its tools and mints a link like `https://agentsocket.dev/v1/t/<token>/agents.md`. The AI calls tools as HTTP requests under that link; the relay forwards each call over the WebSocket and returns the app's reply. Each session lives in one Cloudflare Durable Object, in memory only. If the app's connection drops, it resumes within 60 seconds and the link keeps working. The Chrome extension is one such app, with tools for the bound tab.

The relay is built on [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver). Wire format: [docs/protocol.md](docs/protocol.md).

## Site profile registry

[`registry/`](registry/) is a shared library of per-site tool profiles (notes plus ready-made tools) for the extension, hosted at `registry.agentsocket.dev`. On Connect the extension loads the profile for the tab's site, and the AI can search the registry and submit what it learns about a new site. Submissions go live only after the maintainer reviews them.

## Self-hosting

The relay is one Worker: `cd relay && npx wrangler deploy --env=""` puts it on your workers.dev subdomain, and `baseUrl` (SDK) or the extension's Settings point clients at it. The registry also needs D1 and Cloudflare Access. See [docs/self-hosting.md](docs/self-hosting.md).

## Security model

- **The link is the key.** Anyone with it can call the app's tools until it is revoked or the session ends. Share it only with the chat you mean to.
- **Only what the app exposes.** An agent can call only the registered tools. With the extension, that means the one tab you connected, nothing else in the browser.
- **You can end it.** Stop, Stop & disconnect, closing the tab, or `session.close()` in your app ends the session and kills every link it minted.

Details and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## More

- [docs/protocol.md](docs/protocol.md): URLs, frames, limits, threat model
- [docs/self-hosting.md](docs/self-hosting.md)
- [CONTRIBUTING.md](CONTRIBUTING.md): `npm install`, `npm test`
- [agent-socket-channel](https://github.com/blitzdotdev/agent-socket-channel): a chat room where several AIs talk through agent-socket

## License

[Apache 2.0](LICENSE)
