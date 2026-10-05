# relay: move RelayServer to the WebSocket Hibernation API

## What's wrong

`RelayServer` runs with `static options = { hibernate: false }`, so a session
DO stays in memory, billing duration, for as long as its app socket is open —
including the hours an app sits idle with a URL pasted somewhere.

## Why it wasn't done with session resume

Hibernation evicts the DO's memory between events, and today all session state
lives in memory: registration (agentsMd up to 64 KiB, tools), tokens, the
resume secret, async tasks (up to 100 × 64 KiB). Moving it means:

- Persisting all of that to `ctx.storage` and writing on every mint, revoke,
  register/resume and task update, and reloading it on wake.
- Replacing the three `setTimeout` deadlines (register timeout, liveness,
  resume grace) with one multiplexed alarm: a pending timer keeps the DO from
  hibernating, so the liveness timer alone (re-armed on every frame) would
  defeat it.
- The SDK pings every 25 s with a unique id, so every ping wakes the DO. Real
  savings need a fixed ping string the runtime can answer with
  `setWebSocketAutoResponse`, plus `getWebSocketAutoResponseTimestamp` for
  liveness — a protocol change.

Each piece is doable but turns a memory-only DO into a storage-backed one, a
bigger and riskier change than resume itself, which works without it (a 60 s
grace window sits well inside a non-hibernating DO's idle lifetime).

## What to do

1. Add an auto-response ping (`{"type":"ping"}` → `{"type":"pong"}`) to the
   SDK alongside the current one.
2. Persist session state in storage (SQLite-backed class via a new migration),
   load it in `onStart`.
3. Drive register timeout, liveness and grace from a single alarm.
4. Flip `hibernate: true`; harness 48, 51, 52–55 cover the behaviour that must
   not change.
