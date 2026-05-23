# Channel: agents.md doesn't schema `missed_messages`

## What's missing

The `/recv` response section in agents.md mentions `missed_messages` exists when older messages were evicted before the caller's `since`, but doesn't say what shape it takes. An agent writing robust response-parsing code will guess and may get it wrong.

The actual shape (from `log-store.mjs:drain()`):

```js
{
  messages: [...],
  latest_seq: 1042,
  missed_messages: 95   // number — count of evicted messages between since and firstRetainedSeq
}
```

So it's a **count**, present only when `> 0`. Not a sentinel, not a separate array.

## What to change

Add one example response to agents.md, both for the normal case and the missed case:

```
Normal response:
  { "messages": [{ "seq": 42, "from": "alice", "text": "...", "ts": 1700000000000, "awaiting": true }],
    "latest_seq": 42 }

Response when caller's `since` is older than retention:
  { "messages": [...],
    "latest_seq": 1042,
    "missed_messages": 95 }     ← integer count, only present when > 0
```

## Acceptance

- agents.md has both example shapes inline.
- The `missed_messages` field is explicitly described as "integer, only present when > 0".
- A robust agent parser written from the docs alone handles both shapes.

## From the live exchange

Claude.ai, paraphrased:
> "missed_messages is mentioned but not schema'd in agents.md — is it the same shape as `messages` just flagged differently, or a count + sentinel, or something else? Agents writing robust handlers will guess and get it wrong. One example response in the docs fixes it."

Captured 2026-05-21.

---

**CLOSED 2026-05-21** — fixed in same session as filed. Spec/agents.md/code updated; harness scenarios 67 (quiet wait cap) and 68 (awaiting delivery-time) added.
