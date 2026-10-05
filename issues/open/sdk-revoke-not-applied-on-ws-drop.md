# sdk: revoke/list silently mutate or fail to mutate the local token map when the reply doesn't arrive

## What's wrong

`revokeAgentToken` (`sdk/src/session.ts:146`) awaits the server reply *before* updating local state, so a dropped/timed-out reply skips the local delete:

```ts
async revokeAgentToken(token: string): Promise<{ ok: boolean }> {
  const id = this._uid()
  this._sendFrame({ type: "revoke_agent_token", id, token })
  const reply = await this._awaitReply(id, 10_000)   // can REJECT (ws closed / timeout)
  this.myTokens.delete(token)                          // never runs if the await throws
  return { ok: !!reply.ok }
}
```

Two failure modes:

1. **Revoked token resurrected.** If the WS drops or no reply arrives within 10 s while a revoke is in flight, `_awaitReply` rejects (`_onClose` rejects all pending with `"ws closed"` at `:302`, or the timeout at `:407`). The `await` throws, so `this.myTokens.delete(token)` never runs. The token stays in `myTokens` and is **re-minted on the next reconnect** (`:358-370`) — resurrecting a link the user explicitly asked to revoke.

2. **False success.** `_sendFrame` silently swallows send failures (`:381` `try { ... } catch {}`). A frame that never left the socket can still ride a stale/duplicate reply path, so a caller can observe `{ ok: true }` for a revoke the relay never received.

`listAgentTokens` has the same await-can-reject shape (`:154-166`), though its consequence is just a thrown call rather than state corruption.

## Why it matters

Revocation is the *only* way to invalidate a token (`expiresAt` is always `null`). If a revoke that the user believed succeeded silently un-applies on the next reconnect, a link the user intended to kill comes back to life — directly defeating the one control the threat model offers over a leaked URL.

## What to do

- Delete from `myTokens` **before/independently of** the await (optimistic local removal), or in a `finally`, so a dropped reply can't resurrect the token on remint.
- Surface send failures from `_sendFrame` for these control frames (don't swallow), so the caller can distinguish "sent and acked" from "never left."
- Reconsider whether `revoke`/`mint`/`list` should reject vs. resolve-with-status on WS drop, and document it.

## Acceptance

- A revoke issued just before a WS drop does not result in the token being re-minted on the subsequent reconnect.
- A revoke whose frame failed to send does not report `{ ok: true }`.

## Provenance

Found during a full line-by-line audit. Verified the await-then-delete ordering (`session.ts:148-150`), `_onClose` rejecting all pending (`:300-303`), the 10 s `_awaitReply` timeout (`:404-408`), `_sendFrame`'s swallowed catch (`:379-382`), and the remint loop re-minting from `myTokens` (`:358-370`).
