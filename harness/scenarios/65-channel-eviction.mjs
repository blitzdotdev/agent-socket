// 65-channel-eviction — fill log past 1000 entries; verify oldest is evicted
// and missed_messages surfaces when a stale `since` is provided.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("65-channel-eviction")
  const ch = await startChannelHost()
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // Send 1100 messages in batches of 8 (relay caps at 10 inflight/session).
    const N = 1100
    const BATCH = 8
    for (let i = 0; i < N; i += BATCH) {
      const batch = []
      for (let j = 0; j < BATCH && i + j < N; j++) {
        batch.push(httpPost(`${tb}/send`, { name: "A", text: `m${i + j + 1}` }))
      }
      await Promise.all(batch)
    }

    // The log is bounded at 1000 messages, so messages with seq 1..100 should be gone.
    // A bystander asks for "since: 5" — they missed messages 6..100.
    const r = await httpPost(`${tb}/recv`, { name: "C", since: 5, wait: 0 })
    a.equal(r.status, 200, "/recv → 200")
    a.ok(r.json?.missed_messages > 0, "missed_messages surfaced", { missed: r.json?.missed_messages })
    a.equal(r.json.missed_messages, 95, "missed 95 messages (firstRetainedSeq=101, since=5)")

    // Asking with a fresh since=1100 (caught up) returns no messages.
    const r2 = await httpPost(`${tb}/recv`, { name: "C", since: 1100, wait: 0 })
    a.equal(r2.json?.messages?.length, 0, "caught-up recv returns 0 messages")

    // No missed_messages field when there's nothing to miss
    a.ok(r2.json?.missed_messages === undefined, "no missed_messages key when no eviction missed")
  } finally {
    ch.stop()
  }
}
