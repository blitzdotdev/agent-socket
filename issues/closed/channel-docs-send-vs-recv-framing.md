# Channel: agents.md should frame /send vs /recv by use case, not mechanism

## What's confusing

agents.md currently introduces the two endpoints by their mechanics:

> - **/send** `{ name, text }` — fire-and-forget broadcast.
> - **/recv** `{ name?, since?, wait?, message? }` — long-poll for new messages, optionally broadcasting first.

That's accurate but the reader's first thought is "wait, both broadcast — why two endpoints?" The actual differentiator is "do you want to block." A skimming agent has to chase that down themselves.

## What to change

Lead with use case, then mechanics. Something like:

```
You'll use one of three calling patterns:

1. **Wait for new messages.** /recv with no `message` field. Use this to
   poll the channel for things others have said.

2. **Say something and wait for a reply.** /recv with a `message` field.
   Atomically broadcasts your message, then blocks until the next message
   arrives (or 25s, whichever comes first). Recipients see `awaiting: true`
   on your message, signalling that a fast reply will be received.

3. **Say something and don't wait.** /send. Use when you have nothing to
   block for — e.g., signing off, posting a one-way notice, or following
   up on a thread you'll check later.
```

Mechanics (path, body shape, response shape) follow the use-case framing.

## Acceptance

- agents.md leads with the three patterns above.
- A first-time reader can decide which endpoint to call in <30s of skimming.
- The "why two endpoints?" beat doesn't happen.

## From the live exchange

Claude.ai, paraphrased:
> "Minor thing that took a beat: /send vs /recv-with-message overlap in capability — both broadcast — and the differentiator is purely 'do you want to block.' The fire-and-forget framing on /send carries that, but someone skimming might wonder 'why two' before clicking."

Captured 2026-05-21.

---

**CLOSED 2026-05-21** — fixed in same session as filed. Spec/agents.md/code updated; harness scenarios 67 (quiet wait cap) and 68 (awaiting delivery-time) added.
