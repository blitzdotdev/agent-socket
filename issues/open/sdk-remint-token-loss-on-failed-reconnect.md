# sdk: minted tokens permanently lost if the FIRST reconnect attempt fails (myTokens cleared before remint, not restored)

## What's wrong

`_reconnectAndRemint` (`sdk/src/session.ts:335`) snapshots and clears `myTokens` *before* attempting to reconnect, and on a failed attempt it returns without restoring them:

```ts
const priorSessionId = this._sessionId
const priorTokens = Array.from(this.myTokens.values())
this.myTokens.clear()                                // cleared up front

try {
  await this._connectAndRegister()
  this.attempt = 0
} catch (e) {
  this.attempt += 1
  ...
  void this.onDisconnect({ ... reconnect, ... })     // schedules the NEXT _reconnectAndRemint
  return                                              // priorTokens discarded here
}
// remint loop reads `priorTokens` ... only reached on success
```

`priorTokens` is a local. On the catch path it is dropped, and `myTokens` is already empty. The **next** `_reconnectAndRemint` (fired by the catch's `onDisconnect` → backoff → `reconnect()`) reads `this.myTokens`, which is now empty — so even after the relay comes back and a later attempt succeeds, **none of the originally-minted tokens are re-minted**.

## Why it matters

When the WS drops and the very first reconnect attempt fails (relay momentarily down, register times out at `:114`), every paste-link the user already handed to an agent goes silently dead. No `onSessionChanged` remap is ever emitted for them, so the host has no way to learn the new URLs. The user-visible symptom is "all my agent links stopped working after a blip and never recovered."

This is distinct from the already-filed `sdk-reconnect-remint-race` (which is about the WS dropping *during* the remint loop). Here a single clean failed attempt before the loop loses every token.

## What to do

- Do not clear `myTokens` until a reconnect actually succeeds; or
- On the catch path, restore `priorTokens` back into `myTokens` (or keep a separate `pendingRemint` set that survives failed attempts) before returning, so the next successful reconnect re-mints them.

## Acceptance

- WS drops with N active minted tokens; the first reconnect attempt fails; a later attempt succeeds → all N tokens are re-minted under the new session and reported via `onSessionChanged`.
- No path leaves `myTokens` permanently empty while the user still holds live paste-links.

## Provenance

Found during a full line-by-line audit. Verified the clear-before-try ordering (`session.ts:336-337`), the catch-path `return` that discards `priorTokens` (`:343-356`), and that the remint loop only runs on the success path (`:358-370`).
