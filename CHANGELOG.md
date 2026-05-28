# Changelog

All notable changes to agent-socket are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), but pre-1.0 we don't strictly version every change.

## Unreleased

Pre-launch polish toward the first public OSS release at `github.com/teenybase/agentsocket`. Not on npm or the Chrome Web Store yet.

### Added

- **Public landing page** at `https://agentsocket.dev/` with four audience-specific sections (paste-URL, SDK, channel host, chrome extension), favicon, Open Graph + Twitter card meta tags.
- **Chrome extension** (`chrome-extension/`) — MV3 service worker exposing tab-driving tools (`/eval`, `/click`, `/fill`, `/navigate`, `/screenshot`, `/page_info`, `/dom_query`, etc.) plus site-specific profiles for github.com, news.ycombinator.com, x.com.
- **Channel mode CLI** (`cli/`) — `agent-socket channel host/join/send/recv/watch/peers/stop`. Per-host log + outbox files at `~/.agent-socket/current/`. `/join.sh` endpoint serves a self-contained bash client for zero-install joining.
- **`scripts/deploy.sh`** — single entry point for ALL wrangler operations (deploy / tail / rollback / status / smoke / whoami / dev). Loads CF API token from `.env`, reads `account_id` from `wrangler.jsonc`.
- **`scripts/test-deploy.sh`** — 12-case portability test for the JSONC parser pipeline (BSD sed / GNU sed / BusyBox sed all work).
- **Harness scenarios 60–70**: channel-basic, multiparty, long-poll wake, awaiting flag, scrollback, eviction, bad-input, quiet-wait-cap, awaiting-delivery-time, reject-unknown-fields, watch-survives-host-restart.
- **Chrome ext tests**: `reconnect.unit.mjs` (21 assertions, mocked WebSocket, no chromium needed) + `reconnect.e2e.mjs` (real chromium + extension load + WS-drop simulation).

### Fixed

- **Chrome ext WS dropped after 3-10 calls** → ported `autoReconnect` from `@agent-socket/sdk` into `chrome-extension/lib/as-client.js`. Replaced the no-op keepalive alarm body with a real WS-ping that exercises the SW.
- **`channel watch` died after host restart** → stat-poll-based detection of inode change / size decrease replaces the inode-bound `fs.watch`. Three-agent verification + harness scenario 70.
- **`/send` and `/recv` silently swallowed unknown fields** (e.g. `since_seq` typo) → now reject with `400 bad_input` naming the field. Harness scenario 69.
- **`curl ... | bash` form of join.sh exited instantly** → switched recommended invocation to `bash <(curl ... | jq -r .script)` (process substitution preserves stdin).
- **Landing page returned 404 at `/`** → added a self-contained HTML landing page.

### Changed

- **Default relay URL**: `https://agentsocket.dev` (was placeholder during early v0). `aisocket.dev` kept as an alias on the same Worker.
- **`wrangler.toml` → `wrangler.jsonc`** for the relay config (supports comments, parseable via portable sed+jq pipeline).
- **`.env`** carries only `CLOUDFLARE_API_TOKEN` + optional `EXPECTED_ACCOUNT_ID`. `account_id` lives in `wrangler.jsonc` as single source of truth.
- **agents.md** (served by the channel host) restructured around three calling patterns with response shapes, awaiting-flag semantics, and an explicit untrusted-input trust note.

### Closed (selected design history)

- channel-docs-missed-messages-shape
- channel-docs-send-vs-recv-framing
- channel-dynamic-wait-cap
- channel-join-sh-bash-stdin-bug
- channel-prompt-injection-threat-model
- channel-reject-unknown-fields
- channel-spec-awaiting-semantics
- channel-watch-survive-host-restart
- chrome-ext-default-base-aisocket
- chrome-ext-ws-drops-no-reconnect

### Still open

- `chrome-ext-consolidate-as-client` — extension duplicates SDK wire protocol; future refactor.
- `relay-tool-content-type` — relay always serves `application/json`; future change to allow tools to set their own content-type.

---

Earlier history pre-dates the public-launch effort and is captured in commit messages on the `master` branch.
