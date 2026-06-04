# `@agent-socket/harness`

Runtime end-to-end scenarios for the agent-socket relay + SDK + CLI + chrome extension.

Not on npm; runs from the monorepo root.

## Quick start

```bash
# From the repo root:
node harness/run.mjs all     # ~45 sec, 42 scenarios
node harness/run.mjs 60      # one specific scenario
node harness/run.mjs 60-69   # a range
```

The harness boots its own `wrangler dev` for the relay before each scenario set; no separate setup needed.

## Layout

- `run.mjs` — entry point. Discovers `scenarios/NN-*.mjs` files, runs them in numbered order, stops on first failure unless `--continue`.
- `lib/` — shared helpers:
  - `relay.mjs` — boots/tails wrangler dev, exposes `httpPost(path, body)` and `openRawWs()`.
  - `channel.mjs` — boots a channel host programmatically (via the SDK, not the CLI) for in-process scenario testing.
  - `browser.mjs` — Puppeteer helper for visual scenarios.
  - `assert.mjs` — tiny assertion harness.
- `scenarios/NN-name.mjs` — each scenario exports a default async function. Numbered groups:
  - **01–03** Relay boots, bad URLs, token format
  - **10–19** Raw WS handshake + register + mint + tools.json + agents.md
  - **20–29** SDK happy path, concurrency limits, post-close behavior, tool timeout
  - **30–37** Origin/CSRF defenses, tool round-trip, ping-pong, async tasks (raw + SDK)
  - **41** SDK reconnect + remint
  - **50** Puppeteer pixel-art-canvas visual test
  - **60–70** Channel CLI (host/send/recv/watch + edge cases)

## Adding a scenario

1. Create `scenarios/NN-short-name.mjs` (next unused number).
2. Export `default async function () { /* asserts */ }`.
3. Use `new Assert("NN-short-name")` to track pass/fail.
4. Reach the relay via `RELAY_HTTP` from `lib/relay.mjs`.

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
