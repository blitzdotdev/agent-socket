# Changelog

## Unreleased

- **Chrome extension**: a session timer: sessions stop 60 minutes after Connect by default (Settings: 15 min to 8 h, or no limit), shown in the bar and the popup, with Stop now, Change and Remove timer; expiry is a clean Stop. A site lock, on by default: tools act only while the tab is on an allowed origin (at first the one it was on at Connect), checked on every call and pinned to the checked document; elsewhere calls return 403 `origin_not_allowed`, `/navigate` refuses other origins, and the bar says "AI paused" with **Allow** for that site. The popup lists the allowed sites and has "Let the AI use other sites in this tab" (default in Settings). On another allowed site the session's tools swap to that site's profile on the same link. `/page_info` returns `session_ends_at` and `allowed_origins`.

## 0.2.0

SDK `@agent-socket/sdk` 0.2.0, Chrome extension 0.4.0.

- **Relay**: sessions are durable. A dropped app's session is held for 24 hours (was 60 s) in Durable Object storage, with an alarm for the deadline, so links survive laptop sleep, network loss and relay restarts. Storage keeps no resume secret or usable token (a derived check value, verifier hashes, sealed tokens). The relay hibernates between events: the runtime answers the SDK's heartbeat itself. New `end` frame ends a held session with the secret. Async results are capped at 64 KiB of UTF-8 (was characters) and their content-type at 256 characters. The held-session `app_offline` message says how long the app has been away. Deploying this drops sessions that are live at the time once (they were in memory); clients reconnect into new sessions.
- **SDK**: the heartbeat is the fixed frame `{"type":"ping","id":"as_hb"}` (works with older relays too); `close()` while disconnected ends the held session; new `endSession()`.
- **Chrome extension** (0.4.0): a worker that restarts while the relay can't be reached keeps the saved link and retries until the relay answers, instead of dropping it; Stop while waiting ends the held session. The access bar is draggable, and Stop can no longer leave a stale "AI" badge behind.
- **Docs**: protocol.md gains Storage, `end`, and a Limits table with what happens at each limit; SECURITY.md and PRIVACY.md describe the 24-hour hold.

## 0.1.0

First public release.

- **Relay** (`relay/`, hosted at agentsocket.dev): Cloudflare Worker and Durable Object. Agents use `/v1/t/<token>/agents.md`, `tools.json` and one URL per tool; apps connect over a WebSocket at `/v1/_ws`. Async tool calls with polling, session resume that keeps links working through a dropped connection (60 s), CSRF check on tool calls, sandboxed tool responses, per-session limits and a best-effort per-IP connection rate limit.
- **SDK** (`@agent-socket/sdk` 0.1.0): register tools, mint, list and revoke links, complete async tasks. Reconnects automatically, resumes the same session, and re-mints links only when the session is gone. Can resume a saved session after a page or worker restart. Runs in browsers, Workers and Node 22+, no dependencies.
- **Chrome extension** (0.3.0): lets an AI chat use one tab you choose (read, click, type, scroll, navigate, screenshot, run JavaScript). Shows a draggable in-page bar with Stop and a toolbar badge while connected, and says so when the link changes. Keeps its link across service-worker restarts. Loads the site's tools from the registry on Connect; the AI can search the registry, save tools locally (you choose Keep or Discard) and submit them for review.
- **Registry** (`registry/`): shared per-site tool profiles with search, and submissions that go live after admin review. Admin pages sit behind Cloudflare Access.
- **Examples**: `examples/minimal` (one tool, browser and Node) and `examples/pixel-art-canvas`.
- **Docs**: [protocol](docs/protocol.md) and [self-hosting](docs/self-hosting.md).
