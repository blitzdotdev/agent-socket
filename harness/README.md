# `@agent-socket/harness`

Runtime end-to-end scenarios for the agent-socket relay + SDK.

Not on npm; runs from the monorepo root.

## Quick start

```bash
# From the repo root:
npm run harness              # builds the SDK, then runs every scenario
node harness/run.mjs 28      # one specific scenario
node harness/run.mjs 40-49   # a range
```

Without `RELAY_URL`, `run.mjs` boots its own `wrangler dev` (`DEBUG=1`, `MAX_SYNC_TOOL_MS=3000`, `HEARTBEAT_TIMEOUT_MS=15000`, `RESUME_GRACE_MS=3000`) with Durable Object storage in a fresh temp dir, and stops it at the end. It listens on `HARNESS_PORT` (default: a free port); `HARNESS_INSPECTOR_PORT` pins wrangler's inspector port, and `HARNESS_ENV=production` runs the production config, whose Durable Object class is key-value backed (the top level is SQLite backed). Set `RELAY_URL` (and `WRANGLER_LOG` for log slices and the log checks in 58, 60 and 61) to run against a relay you started yourself; also export the same `HEARTBEAT_TIMEOUT_MS` / `RESUME_GRACE_MS` it runs with, or 51, 54, 60 and 61 SKIP. `LONG_GAP_MS` (default 62000) is how long 58 keeps a session waiting. SDK scenarios import `sdk/dist`, so run `npm run build -w sdk` first when calling `run.mjs` directly.

## Layout

- `run.mjs` — entry point. Discovers `scenarios/NN-*.mjs` files, runs them in numbered order, stops on first failure unless `--continue`. A scenario that returns `{ skip: "reason" }` is reported as SKIP.
- `lib/` — shared helpers:
  - `relay.mjs` — `RELAY_HTTP` / `RELAY_WS`, `httpGet`, `httpPost(path, body)`, `openRawWs({ forceSession?, resumeSession? })`, `killWs(sessionId, { end?, holdMs? })`, `debugState(sessionId)` (storage keys, alarm, hold; no secrets), `evict(sessionId)` (reset the session's Durable Object: memory and sockets gone, storage kept), `resumeGraceMs()`, `heartbeatTimeoutMs()`, `sdkHeartbeat()` (SDK ping interval that fits the relay's liveness window), `until(cond, what, ms)`.
  - `logs.mjs` — tails the wrangler log for failure output; `logMark()` / `logSince(mark)` for log checks.
  - `browser.mjs` — Puppeteer helper for visual scenarios.
  - `assert.mjs` — tiny assertion harness.
- `scenarios/NN-name.mjs` — each scenario exports a default async function. Numbered groups:
  - **01–03** Relay boots, bad URLs, token format
  - **10–19** Raw WS handshake + register + mint + tools.json + agents.md
  - **20–29** SDK happy path, concurrency limits, post-close behavior, tool timeout
  - **31–40** CSRF defense, tool round-trip, ping-pong, async tasks (raw + SDK), content-type
  - **41–49** SDK reconnect (resume first, re-mint when the session is gone), WS takeover, bad replies/registers, body cap, header passthrough, response sandbox, register timeout, frame cap
  - **50** Puppeteer pixel-art-canvas visual test (SKIP without chromium)
  - **51** App liveness (SKIP unless `HEARTBEAT_TIMEOUT_MS` is short)
  - **52–55** Session resume: raw protocol (same URL, gap behaviour, tools replaced), refused secrets, expiry after the grace window (SKIP unless `RESUME_GRACE_MS` is short), concurrent attempts vs. the live socket
  - **56–57** `update_tools` (raw + SDK)
  - **58–62** Durable sessions: a 62 s gap with an eviction in it, a reset while the app is connected, every way a session ends wiping storage (clean close, alarm expiry, `end`, SDK close while away), hibernation + heartbeat auto-response + liveness alarm, and the limits nothing else covers
  - **90** `/v1/_ws` rate limit (last, so its burst can't starve the others)

## Adding a scenario

1. Create `scenarios/NN-short-name.mjs` (next unused number).
2. Export `default async function () { /* asserts */ }`.
3. Use `new Assert("NN-short-name")` to track pass/fail.
4. Reach the relay via `RELAY_HTTP` from `lib/relay.mjs`.
5. Return `{ skip: "reason" }` if a prerequisite is missing.

Example:

```js
import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("99-example")
  const r = await httpPost("/v1/t/bad/agents.md", null)
  a.equal(r.status, 404, "unknown token → 404")
}
```

## Chrome extension tests

Separate from the harness because they need chromium:

```bash
node chrome-extension/test/reconnect.unit.mjs   # mocked WS; no chromium
node chrome-extension/test/reconnect.e2e.mjs    # real chromium; headless=new
```

The E2E uses `/usr/bin/chromium` by default, override with `CHROMIUM_PATH=`.
The unit test drives the vendored SDK at `chrome-extension/lib/sdk/` against a mocked WebSocket.

## CI

`.github/workflows/ci.yml` runs the harness on every push/PR. See that file for the exact matrix.
