# sdk: teardown leaks — heartbeat timer re-armed during close, and a failed connect() leaves a live reconnecting socket

## What's wrong

Two related cleanup gaps in `sdk/src/session.ts`.

### A) Heartbeat ping timer re-armed during/after teardown (`:223`)

`_onMessage` calls `_scheduleNextPing()` unconditionally on *every* inbound frame:

```ts
this._scheduleNextPing()  // any inbound traffic resets the idle timer
```

`_scheduleNextPing` (`:420`) sets a fresh `heartbeatPingTimer` with no guard on `this.ws` / `giveUpReconnect` / readyState. A frame processed in the same tick as close (or any message arriving during teardown) re-creates the timer *after* `_onClose`/`close()` already ran `_teardownHeartbeat()` and set `this.ws = null`. `_sendPing` then no-ops (it guards on `!this.ws`), but **the timer itself leaks** — it is never cleared after the connection is gone. In Node this keeps the event loop alive / blocks clean shutdown; on reconnect it can collide with the new connection's heartbeat scheduling.

### B) Failed `connect()` leaves the socket open and reconnecting (`:92-122`)

`_connectAndRegister` opens the socket and installs handlers, then can throw without closing it:

```ts
this.ws = await openWs(wsUrl)
await this._waitOpen(this.ws)
this._installHandlers(this.ws)            // message/close/error listeners attached
...
const reply = await this._waitForFrame((m) => m.type === "register_reply", 10_000)
if (!reply.ok) { ... throw new Error(...) }   // ws never closed
```

If registration is rejected (`reply.ok === false`) or `register_reply` never arrives (the `_waitForFrame` timeout rejects), the function throws but never calls `this.ws.close()`. The installed `close` handler is wired to `_onClose`, and since `giveUpReconnect` is still `false`, a later socket close will fire `onDisconnect` and start reconnecting a session the caller already saw `connect()` reject for. So a failed initial `connect()` can leave a live socket reconnecting in the background with no handle to stop it.

## Why it matters

- (A) leaks timers on every clean close/reconnect — accumulates over a long-lived process, prevents graceful Node shutdown, and can double-fire heartbeats after reconnect.
- (B) means a rejected `connect()` doesn't actually stop: the caller gets a thrown promise but the SDK keeps a socket alive and reconnecting, minting/registering against a session the app abandoned.

## What to do

- (A) Guard `_scheduleNextPing` to bail when `!this.ws` or `giveUpReconnect`, and/or don't call it from `_onMessage` once teardown has started.
- (B) On the register-failure and register-timeout paths in `_connectAndRegister`, `close()` the socket and run `_teardownHeartbeat()` before throwing (and consider whether a failed *initial* connect should set `giveUpReconnect`).

## Acceptance

- After `close()` or a clean reconnect, no `heartbeatPingTimer` remains pending (Node process can exit without lingering timers).
- A `connect()` that throws on register failure/timeout leaves no open socket and no background reconnect loop.

## Provenance

Found during a full line-by-line audit. Verified the unconditional `_scheduleNextPing()` in `_onMessage` (`session.ts:223`) and that `_scheduleNextPing` (`:420`) has no `ws`/state guard; verified the register-failure (`:115-118`) and `_waitForFrame` timeout (`:114`) throw paths in `_connectAndRegister` do not close the socket.

## Resolution (2026-10-05)

Fixed on wt/sdk-ext: handlers are installed only after register succeeds, the socket is closed on any register failure, register waits reject on close, and frames from a socket that is no longer current are ignored (no heartbeat re-arm). Tests: sdk/test/session.test.mjs.
