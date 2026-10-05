# harness: SDK/raw-WS scenarios leak live sessions and emit unhandled rejections on assertion failure (no try/finally)

## What's wrong

The harness runs every scenario in a single Node process (`harness/run.mjs` imports and invokes them in sequence). Scenarios 10–41 call `session.close()` / `c.close()` as the **last statement**, with no `try/finally` (verified: finally-count = 0 for these; the channel scenarios 60–69 correctly use `try/finally`). For example `31-sdk-tool-roundtrip.mjs:62`, `41-sdk-reconnect-remint.mjs`, `22-five-concurrent.mjs:56`.

Several scenarios also spawn fire-and-forget auto-repliers that are never awaited or torn down, e.g. `35-async-task.mjs:27-36`, `22-five-concurrent.mjs:26-38`, `28-tool-timeout.mjs:61-64`:

```js
;(async () => {
  const call = await c.waitFor((m) => m.type === "tool_call", 5000)
  ...
})()
```

## Why it matters

When an assertion throws mid-scenario (the normal failure path):

- `close()` never runs, so a live WebSocket leaks into the shared process. For SDK scenarios with `autoReconnect: true` (e.g. scenario 41 uses `noBackoff()`), the leaked session keeps **reconnecting and re-minting in the background** while later scenarios run — contaminating relay state and keeping the process from exiting cleanly.
- The un-awaited replier's `waitFor` can reject (relay never delivers the expected `tool_call`), surfacing as an `unhandledRejection` attributed to *some* scenario — possibly a *later* one — which masks or misreports the real failure.
- The leaked WS still carries its registered `message` listener, so stray frames can fire it during subsequent scenarios.

Net: a single failing scenario can cascade into false failures/flakiness in later scenarios and a process that won't exit, undermining the suite's reliability as a regression gate.

## What to do

- Wrap each scenario body in `try/finally` that closes the session/WS (match the pattern scenarios 60+ already use).
- Track/await the auto-replier (or attach it to the per-scenario WS and ensure it's torn down in the `finally`), so its rejection can't leak across scenarios.

## Acceptance

- A scenario that fails an assertion still closes its session/WS; no live session survives into the next scenario.
- No `unhandledRejection` is emitted from a scenario's auto-replier after that scenario ends.

## Provenance

Found during a full line-by-line audit. Verified scenarios 10–41 close as the final statement with no `try/finally` (finally-count = 0) while 60–69 use `try/finally` (finally-count = 1), and the un-awaited IIFE repliers in `35`/`22`/`28`. `run.mjs` runs all scenarios in one process.
