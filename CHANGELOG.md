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
- **Harness scenarios 36–37**: SDK async-task round-trip via `session.completeTask()`, Sec-Fetch-Site CSRF defense on the user-tool surface.
- **Harness scenarios 60–70**: channel-basic, multiparty, long-poll wake, awaiting flag, scrollback, eviction, bad-input, quiet-wait-cap, awaiting-delivery-time, reject-unknown-fields, watch-survives-host-restart.
- **Chrome ext tests**: `reconnect.unit.mjs` (23 assertions, mocked WebSocket, no chromium needed) + `reconnect.e2e.mjs` (real chromium + extension load + WS-drop simulation).
- **`Session.completeTask(taskId, {status?, body?})`** in `@agent-socket/sdk` — lets tool handlers return `{status: 202, taskId}` and complete asynchronously via a follow-up `task_complete` frame.
- **`Session.ping()`** in `@agent-socket/sdk` — exposes the existing heartbeat with the in-flight-guard so MV3 service workers can keep their WS warm from `chrome.alarms` without setTimeout (which the SW idle-killer cancels).
- **CSRF defense on `/v1/t/<token>/<tool-path>`** — rejects browser-initiated cross-site requests via `Sec-Fetch-Site` (`csrf_denied` / 403). Read-only meta paths (`/agents.md`, `/tools.json`, `/_as_tasks/<id>`) are carved out so address-bar previews still work.
- **`agent-bridge/`** (merged from `claude/agent-website-extension-VsA69`) — per-user Node service exposing a local AI harness (`/run`, `/cancel`, `/health`) and fanning the mint URL out to Blitz campaigns. Not yet documented in detail; see `agent-bridge/index.mjs`.
- **Keybind-driven background-tab connect** in the chrome extension — `chrome.commands` shortcuts (`connect-slot-1..4`) open a configured URL in a background tab, mint a session, and copy the URL via an MV3 offscreen document (`offscreen.html`, `offscreen.js`).
- **Tools-lib profiles**: `reddit.com.json`, `docs.google.com.json`.
- **`/privacy`** route on the relay — static HTML served at `https://agentsocket.dev/privacy` for the Chrome Web Store submission.

### Fixed

- **Chrome ext WS dropped after 3-10 calls** → ported `autoReconnect` from `@agent-socket/sdk` (originally into `chrome-extension/lib/as-client.js`; that file has since been deleted as part of the SDK consolidation). Replaced the no-op keepalive alarm body with a real WS-ping that exercises the SW.
- **`channel watch` died after host restart** → stat-poll-based detection of inode change / size decrease replaces the inode-bound `fs.watch`. Three-agent verification + harness scenario 70.
- **`/send` and `/recv` silently swallowed unknown fields** (e.g. `since_seq` typo) → now reject with `400 bad_input` naming the field. Harness scenario 69.
- **`curl ... | bash` form of join.sh exited instantly** → switched recommended invocation to `bash <(curl ... | jq -r .script)` (process substitution preserves stdin).
- **Landing page returned 404 at `/`** → added a self-contained HTML landing page.

### Changed

- **Default relay URL**: `https://agentsocket.dev` (was placeholder during early v0). `aisocket.dev` kept as an alias on the same Worker.
- **`wrangler.toml` → `wrangler.jsonc`** for the relay config (supports comments, parseable via portable sed+jq pipeline).
- **`.env`** carries only `CLOUDFLARE_API_TOKEN` + optional `EXPECTED_ACCOUNT_ID`. `account_id` lives in `wrangler.jsonc` as single source of truth.
- **agents.md** (served by the channel host) restructured around three calling patterns with response shapes, awaiting-flag semantics, and an explicit untrusted-input trust note.
- **Chrome extension consolidates onto `@agent-socket/sdk`** — the 370-line `chrome-extension/lib/as-client.js` (a slim re-implementation of the SDK wire protocol) is deleted. The extension now imports the compiled SDK directly from `chrome-extension/lib/sdk/`, vendored by `chrome-extension/scripts/vendor-sdk.sh`. A CI `vendor-freshness` job runs the script and fails on a diff to prevent silent drift. Net: −370 LOC of duplicated wire-protocol logic; the wire protocol now has a single source of truth.

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
- chrome-ext-consolidate-as-client (landed as the SDK-vendoring refactor described above)
- relay-csrf-sec-fetch-site

### Still open

- `relay-tool-content-type` — relay always serves `application/json`; future change to allow tools to set their own content-type.
- `agent-bridge-token-in-repo` — `agent-bridge/campaigns.json` ships a live-looking bearer token (from the merged bridge commit); needs rotation + `.gitignore`.
- `agent-bridge-tokensRemapped-map-as-array` — bridge treats SDK's `Map` as an array, so reconnect fanout silently throws.
- `agent-bridge-run-no-auth` — `/run` spawns the local Claude harness with `--dangerously-skip-permissions`; needs a shared-secret auth layer.
- `chrome-ext-keybind-url-scheme` — `/configure_keybind` accepts arbitrary URL schemes (`file://`, `data:`); needs an `http(s):` allowlist + private-network blocklist.

---

Earlier history pre-dates the public-launch effort and is captured in commit messages on the `master` branch.
