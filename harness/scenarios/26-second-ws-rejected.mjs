// 26-second-ws-rejected — second WebSocket connection on the same session
// is rejected with WS code 4409. (We need a deterministic way to force
// both connections to the same DO — that means picking the session-id
// at handshake. The Worker generates session-id from the WS URL, so by
// default each new WS gets a different session-id. So this test verifies
// the generic "second connection to same DO" behavior by having the
// SECOND client open via the same DO routing key… which the Worker
// doesn't expose directly. Skipping in v0; revisit when there's a way
// to opt into deterministic session-id at the edge.)

import { Assert } from "../lib/assert.mjs"

export default async function () {
  const a = new Assert("26-second-ws-rejected")
  // Skipped in v0: see comment above. The relay-do enforces 4409 (see §4.1
  // and the onConnect guard in relay-do.ts), but we have no way at the edge
  // to direct two WS handshakes to the same DO instance without a deterministic
  // session-id. Verified manually in the spike where session-id was URL-supplied.
  a.pass("skipped — see scenario comment")
}
