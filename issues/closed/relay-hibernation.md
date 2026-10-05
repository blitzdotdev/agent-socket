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

## Note: a longer resume grace needs this first

Users lose their link when a drop outlasts the 60 s `RESUME_GRACE_MS` (laptop
sleep, Chrome suspending the extension's worker), so raising it is tempting.
Don't do it on the in-memory DO: only a `setTimeout` keeps a detached session's
DO alive, and Cloudflare can evict a DO with no open socket or pending request
regardless of timers, losing the session early. A grace window measured in
minutes needs the session state in `ctx.storage` and the deadline in an alarm,
i.e. the work above. Meanwhile the extension tells the user when the link
changed (pill, popup banner, "NEW" badge) and the relay's `app_offline`
message tells the AI to ask for the new link.

## Fix

Done together with a long resume hold (24 h, `RESUME_GRACE_MS`):

- Session state lives in `ctx.storage` through the key-value API (works on the
  production key-value-backed class and the SQLite-backed self-host class; no
  new migration). Writes on register/resume/update_tools (registration in
  32 Ki-char chunks, only when it changed), mint/revoke, task 202/complete/poll
  and detach; reloaded in `onStart`. No resume secret or usable token is
  stored: an HKDF check value, verifier SHA-256 hashes and AES-GCM-sealed tokens
  whose key lives only in the open app socket's attachment.
- One alarm: the hold's expiry while the app is away, the liveness check
  (last frame or auto-response + `HEARTBEAT_TIMEOUT_MS`) while it is
  connected. The register/resume deadline stays a 10 s timer, cleared as soon
  as the socket registers or resumes.
- `hibernate: true`. The SDK sends the fixed heartbeat
  `{"type":"ping","id":"as_hb"}`, answered by `setWebSocketAutoResponse`;
  liveness reads `getWebSocketAutoResponseTimestamp`. Old pings still work.
- Found on the way: workerd finishes the server-side close of a hibernatable
  socket that never delivered a message only when the object next goes idle
  (~10 s), so refused upgrades now get a plain socket closed at once. Silent
  sockets hitting the register/resume deadline still see the close complete
  up to ~10 s late (the close frame itself is on time).

Tests: harness 48, 51–62 (`HARNESS_ENV=production` for the key-value-backed
class), `sdk/test`, `chrome-extension/test/reconnect.e2e.mjs` (relay outage +
worker restart).
