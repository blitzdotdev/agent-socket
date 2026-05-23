// 64-channel-scrollback — A sends 100 messages; B's first /recv returns last 50.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("64-channel-scrollback")
  const ch = await startChannelHost()
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // Fire 100 sends in batches of 8 (relay caps at 10 inflight/session).
    const N = 100
    const BATCH = 8
    for (let i = 0; i < N; i += BATCH) {
      const batch = []
      for (let j = 0; j < BATCH && i + j < N; j++) {
        batch.push(httpPost(`${tb}/send`, { name: "A", text: `m${i + j + 1}` }))
      }
      await Promise.all(batch)
    }

    // B's first recv (no since) should return the last 50
    const rB = await httpPost(`${tb}/recv`, { name: "B", wait: 0 })
    a.equal(rB.status, 200, "/recv → 200")
    a.equal(rB.json?.messages?.length, 50, "scrollback capped at 50")
    a.equal(rB.json?.latest_seq, 100, "latest_seq matches the 100th send")

    // Verify oldest of the 50 is m51, newest is m100
    const first = rB.json.messages[0]
    const last  = rB.json.messages[rB.json.messages.length - 1]
    a.equal(first?.text, "m51", "first message of scrollback is m51")
    a.equal(last?.text, "m100", "last message of scrollback is m100")
  } finally {
    ch.stop()
  }
}
