# sdk: _reconnectAndRemint can race if WS drops mid-remint loop

## What's wrong

`sdk/src/session.ts`'s `_reconnectAndRemint` (around lines 315-345 post-deploy) runs through prior tokens sequentially and calls `mintAgentToken` for each one. If the freshly-reconnected WS drops mid-loop, `_onClose` fires synchronously, which:

1. Schedules another `_reconnectAndRemint` via `onDisconnect → exponentialBackoff → setTimeout(reconnect, …)`.
2. The outer loop's remaining `mintAgentToken` calls hit a `ws.readyState !== OPEN` state; `_awaitReply` eventually rejects with a timeout (or the `_onClose` handler fails them via "ws closed").
3. The catch in the loop swallows individual mint failures: `} catch { /* Skip — tokens that failed remint stay dead. */ }`.
4. The new inner `_reconnectAndRemint` starts with an already-cleared `myTokens` (line 319 cleared it at the start of the outer call), so it re-mints zero tokens.
5. The outer call's `priorTokens` snapshot is the original list, but only the tokens already minted before the drop made it into the new session. The rest are orphaned in the (now-dead) prior session.

Net effect: `onSessionChanged.tokensRemapped` may be missing entries the caller expected. With chrome-ext today minting one token, the window is tiny (a single mint attempt) and the bug is essentially invisible. The race grows wider any time a session uses multiple tokens.

## Why it matters

Today: rare. The chrome-ext mints once on connect, so the loop has one iteration and the failure window is minimal.

Tomorrow: any app that mints multiple tokens per session (sub-flows, multi-tab driving, CLI bridges) exposes the race more readily. The symptom would be "some tokens come back after reconnect, some don't, no error surfaced."

## What to do

1. **Serialize reconnect via a single in-flight Promise.** Guard `_reconnectAndRemint` with a `_reconnectInFlight` Promise; if `_onClose` fires while it's in flight, mark `_reconnectQueued` instead of scheduling immediately. When the current call settles, if `_reconnectQueued` is set, run another pass.

2. **Make the priorTokens snapshot persistent across nested calls.** Don't clear `this.myTokens` until the loop completes; instead, track a separate `_remintPending` set that survives mid-loop drops.

3. **Document the gap.** Add a comment that mid-loop drops result in incomplete `tokensRemapped` for that round, and the next reconnect will mint fresh tokens (under a third session-id) for whichever the consumer still cares about.

Option 1 is the cleanest. ~15 LOC.

## Acceptance

- A test that drops the WS mid-remint (after `register_reply ok` for the new session, between two `mintAgentToken` calls) results in: either both tokens remapped successfully on the FOLLOWING reconnect, or both old URLs reported as remapped to the latest session-id in `tokensRemapped`.

## Provenance

Surfaced 2026-06-05 by an extra-high-effort `/code-review`. Edge-case; not deploy-blocking. Worth landing whenever the chrome-ext or a future consumer ships multi-mint flows.
