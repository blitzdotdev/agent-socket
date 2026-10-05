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

Without `RELAY_URL`, `run.mjs` boots its own `wrangler dev` on a free port (`DEBUG=1`, `MAX_SYNC_TOOL_MS=3000`, `HEARTBEAT_TIMEOUT_MS=6000`) and stops it at the end. Set `RELAY_URL` (and `WRANGLER_LOG` for log slices on failure) to run against a relay you started yourself. SDK scenarios import `sdk/dist`, so run `npm run build -w sdk` first when calling `run.mjs` directly.

## Layout

- `run.mjs` — entry point. Discovers `scenarios/NN-*.mjs` files, runs them in numbered order, stops on first failure unless `--continue`. A scenario that returns `{ skip: "reason" }` is reported as SKIP.
- `lib/` — shared helpers:
  - `relay.mjs` — `RELAY_HTTP` / `RELAY_WS`, `httpGet`, `httpPost(path, body)`, `openRawWs()`.
  - `logs.mjs` — tails the wrangler log for failure output.
  - `browser.mjs` — Puppeteer helper for visual scenarios.
  - `assert.mjs` — tiny assertion harness.
- `scenarios/NN-name.mjs` — each scenario exports a default async function. Numbered groups:
  - **01–03** Relay boots, bad URLs, token format
  - **10–19** Raw WS handshake + register + mint + tools.json + agents.md
  - **20–29** SDK happy path, concurrency limits, post-close behavior, tool timeout
  - **31–40** CSRF defense, tool round-trip, ping-pong, async tasks (raw + SDK), content-type
  - **41–49** SDK reconnect, WS takeover, bad replies/registers, body cap, header passthrough, response sandbox, register timeout, frame cap
  - **50** Puppeteer pixel-art-canvas visual test (SKIP without chromium)
  - **51** App liveness (SKIP unless `HEARTBEAT_TIMEOUT_MS` is short)
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
node chrome-extension/test/reconnect.unit.mjs   # 23 assertions, mocked WS; no chromium
node chrome-extension/test/reconnect.e2e.mjs    # real chromium; headless=new
```

The E2E uses `/usr/bin/chromium` by default, override with `CHROMIUM_PATH=`.
The unit test drives the vendored SDK at `chrome-extension/lib/sdk/` against a mocked WebSocket.

## CI

`.github/workflows/ci.yml` runs the harness on every push/PR. See that file for the exact matrix.
