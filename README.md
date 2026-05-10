# agent-socket

A relay that lets any web app expose itself to AI chats via a paste-able URL.

```
[your app] ──WS──▶ [agent-socket relay] ◀──HTTPS── [AI chat (Claude / ChatGPT / Gemini)]
```

The agent-side surface is plain HTTPS that any chat can hit via curl-like tool use. No MCP support required from the chat. End-users click "Connect with AI" in your app, paste one URL into their AI chat, and the AI can drive your app via tool calls.

## Status

v0 — actively in development. Not production-ready.

## Architecture

- Cloudflare Worker + Durable Object, built on [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver).
- One DO instance per WebSocket session.
- App registers tools by HTTP `{method, path, description, handler}`.
- Agent calls `<method> /v1/t/<token>/<path>` with a JSON body; relay proxies through the WS to the app's handler.
- See [`docs/superpowers/specs/2026-05-10-agent-socket-design.md`](../../docs/superpowers/specs/2026-05-10-agent-socket-design.md) (in the parent teeny repo) for the full v0 spec.

## Layout

```
agent-socket/
  relay/            # CF Worker + DO. The hosted relay (also self-hostable).
  sdk/              # @agent-socket/sdk — JS/TS client for Node + browser + CLI.
  cli/              # @agent-socket/cli — `npx agent-socket dev`.
  examples/
    pixel-art-canvas/   # primary v0 demo — AI paints pixel art live.
    todo/               # simplest possible integration (single HTML file).
    drawing-canvas/     # planned.
    mindmap/            # planned.
    retro-game/         # planned.
  harness/          # runtime test harness — scenarios that drive the stack end-to-end.
  docs/
    protocol.md     # wire format spec.
    self-hosting.md # deploy your own relay.
```

## Quick start (dev)

```bash
# from this directory
npm install

# Terminal 1 — relay
npm run dev -w relay

# Terminal 2 — verify with the harness
npm run harness 01      # smoke test
```

## License

TBD.
