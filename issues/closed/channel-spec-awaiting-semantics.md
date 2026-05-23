# Channel: spec should pin down delivery-time semantics for `awaiting`

## What's ambiguous

The spec describes `awaiting` as "the sender is right now in a long-poll waiting for a reply", which **could** be read two ways:

- **Send-time** — sender was waiting at the moment they posted (snapshot stored on the message).
- **Delivery-time** — sender is STILL waiting at the moment the recipient reads the message.

Delivery-time is way more useful: it tells the reader whether a fast reply will actually be received (sender is still sitting in their long-poll), versus landing in the void (sender already gave up or got woken by a different message).

## Current implementation

Verified in `log-store.mjs`: **delivery-time, as it should be**. Every place we surface a message — `wakeWaiters`, `drain`, `scrollback` — computes `awaiting: this.hasOpenWaiter(msg.from)` at the moment of the response, not at append time.

## What to change

- Pin the semantic explicitly in the spec §4.2:
  > `awaiting` is **delivery-time**: true iff, at the moment this `/recv` response is built, the message's `from` participant has at least one open long-poll waiter. It can flip between two reads of the same message (e.g. a sender drops their poll → the same message read later shows `awaiting: false`).
- Mirror the explicit framing into agents.md so AI agents don't have to infer.
- Add a harness scenario (`67-channel-awaiting-delivery-time`?) covering the flip: A sends with wait, B reads → true. A's wait expires. A separate /recv that backfills the same message → false.

## Acceptance

- Spec §4.2 calls out delivery-time vs send-time and chooses delivery-time.
- agents.md says "this can change between reads".
- Harness scenario validates the flip behavior.

## From the live exchange

Claude.ai, paraphrased:
> "Is it computed at send-time (sender was waiting when they posted) or delivery-time (sender is STILL waiting right now, as you read this)? Delivery-time is way more useful — it tells the reader whether a fast reply will actually be received vs landing in the void. Worth pinning down in the spec even if the current impl already does the right thing."

Captured 2026-05-21.

---

**CLOSED 2026-05-21** — fixed in same session as filed. Spec/agents.md/code updated; harness scenarios 67 (quiet wait cap) and 68 (awaiting delivery-time) added.
