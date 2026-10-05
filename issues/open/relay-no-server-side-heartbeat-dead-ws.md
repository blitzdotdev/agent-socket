# relay: never detects a dead/half-open app WebSocket; HEARTBEAT_* config is unwired on the relay side

## What's wrong

The relay DO does no server-initiated liveness checking. There is no `setInterval`, no DO `alarm`, and no outgoing `ping` anywhere in `relay/src/relay-do.ts`. The `onMessage` handler only *responds* to app-sent `ping` frames and explicitly ignores `pong` (`:177-182`).

`wrangler.jsonc` defines `HEARTBEAT_INTERVAL_MS` and `HEARTBEAT_TIMEOUT_MS`, and `relay/src/types.ts:7-8` declares them in `Env`, but **neither var is referenced in any relay source file**. The only heartbeat that exists is in the SDK (client → relay pings), which does not help the relay notice a silently-dead client.

## Why it matters

When the app's TCP connection half-opens (network partition, laptop sleep, NAT idle timeout) with no clean WS close frame, `onClose` never fires. Because `static options = { hibernate: false }` (`:70`) the isolate stays pinned. The DO still believes the app is live:

- `onRequest`'s app-offline check (`!this.appWs || !this.appId`, `:444`) passes because both are still set.
- It proceeds to `this.send(...)` (`:567`); the buffered `send()` returns `true` on a half-open socket, so the `if (!sent)` fast-fail (`:575`) doesn't trigger.
- The agent's request then hangs for the full `MAX_SYNC_TOOL_MS` (30 s) before returning `tool_timeout`.

Net: agents see 30-second hangs instead of a prompt `app_offline`, and the DO lingers holding session state for a peer that is gone. The heartbeat the design clearly intended (the env vars exist) was never wired into the DO.

## What to do

- Wire up the existing `HEARTBEAT_INTERVAL_MS` / `HEARTBEAT_TIMEOUT_MS`: have the DO send periodic `ping` frames to the app and track `pong`s (currently dropped at `:163-165`); on timeout, close the WS and run the normal `onClose` cleanup.
- A DO `alarm` is the natural mechanism (survives across requests; works with `hibernate: false`).
- On timeout, resolve any in-flight `pending` requests with `app_offline` immediately rather than letting them ride out the 30 s tool timeout.

## Acceptance

- A half-open app WS (killed at the TCP layer without a close frame) is detected within ~`HEARTBEAT_TIMEOUT_MS` and the DO transitions to app-offline.
- Agent requests after the app silently dies return `app_offline` promptly, not after a 30 s `tool_timeout`.
- The `HEARTBEAT_*` env vars are actually read by the relay.

## Provenance

Found during a full line-by-line audit. Verified: no `setInterval`/`alarm`/outgoing-`ping` in `relay-do.ts`; `pong` is explicitly ignored (`:163-165`); `HEARTBEAT_INTERVAL_MS`/`HEARTBEAT_TIMEOUT_MS` appear only in `wrangler.jsonc` and `types.ts`, never read in source.
