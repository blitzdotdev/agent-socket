# chrome-ext: popup.css doesn't style all statuses emitted by background.js

## What's wrong

`chrome-extension/background.js`'s `emitStatus` helper (added during the SDK consolidation, commit `a4c7926`) emits six status values across the session lifecycle:

- `connecting`
- `connected`
- `disconnected`
- `reconnect-failed`
- `closed`
- `idle`

`chrome-extension/popup.css` (around lines 30–32) defines dot styles for only four: `connected`, `connecting`, `disconnected`, `error`. The other three (`reconnect-failed`, `closed`, `idle`) render as an unstyled / grey dot the user can't interpret.

Worse: there is **no path from `reconnect-failed` to `closed`** when reconnect ultimately gives up (e.g. the consumer's `onDisconnect` calls `info.giveUp()`, or `autoReconnect` semantics evolve). The popup keeps displaying `reconnect-failed (attempt=N)` indefinitely; the user has no signal whether the session is dead vs. still retrying.

## Why it matters

- Users see a grey/unstyled dot for several legitimate states and can't tell which.
- "Permanently dead" looks identical to "still retrying" — easy to misread as a transient hiccup when the session is actually unrecoverable.
- The legacy `as-client.js` exposed the same vocabulary; the consolidation faithfully ported the names but didn't audit whether the CSS kept up.

## What to do

Pick (or do both):

1. **Expand popup.css** to cover all six statuses. `reconnect-failed` gets an amber dot; `closed`/`idle` get a neutral grey. Updates are cosmetic — a few CSS rules.

2. **Emit a terminal `closed` transition** when reconnect gives up. In `background.js`, the `onDisconnect` handler can detect when the consumer's `info.giveUp()` is called (or when `attempt` exceeds some cap) and emit `{status: "closed"}` so the popup converges.

Combine option 1 with a tiny popup.js change to also surface the `attempt` number when in `reconnect-failed` state (already passed through emitStatus payload).

## Acceptance

- All six emitted statuses have a corresponding dot color/icon in `popup.css`.
- A test that drives 5+ failed reconnect attempts shows the popup eventually transitioning to a terminal state, not staying on `reconnect-failed` forever.

## Provenance

Surfaced 2026-06-05 by an extra-high-effort `/code-review` of the deploy that landed the SDK consolidation. Not deploy-blocking — the relay is fine — but real UX cost for chrome-ext users.
