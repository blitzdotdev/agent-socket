# Changelog

## 0.1.0

First public release.

- **Relay** (`relay/`, hosted at agentsocket.dev): Cloudflare Worker and Durable Object. Agents use `/v1/t/<token>/agents.md`, `tools.json` and one URL per tool; apps connect over a WebSocket at `/v1/_ws`. Async tool calls with polling, session resume that keeps links working through a dropped connection (60 s), CSRF check on tool calls, sandboxed tool responses, per-session limits and a per-IP connection rate limit.
- **SDK** (`@agent-socket/sdk` 0.1.0): register tools, mint, list and revoke links, complete async tasks. Reconnects automatically, resumes the same session, and re-mints links only when the session is gone. Can resume a saved session after a page or worker restart. Runs in browsers, Workers and Node 22+, no dependencies.
- **Chrome extension** (0.2.0): lets an AI chat use one tab you choose (read, click, type, scroll, navigate, screenshot, run JavaScript). Shows an in-page bar with Stop and a toolbar badge while connected. Keeps its link across service-worker restarts.
- **Registry** (`registry/`): shared per-site tool profiles with search, and submissions that go live after admin review. Admin pages sit behind Cloudflare Access.
- **Examples**: `examples/minimal` (one tool, browser and Node) and `examples/pixel-art-canvas`.
- **Docs**: [protocol](docs/protocol.md) and [self-hosting](docs/self-hosting.md).
