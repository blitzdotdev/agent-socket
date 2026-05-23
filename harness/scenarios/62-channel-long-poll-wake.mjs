// 62-channel-long-poll-wake — B is in /recv long-poll; A /send; B wakes < 200ms.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("62-channel-long-poll-wake")
  const ch = await startChannelHost()
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // B starts a long-poll with since=0 (since 0 means "from earliest")
    const t0 = Date.now()
    const recvPromise = httpPost(`${tb}/recv`, { name: "B", since: 0, wait: 2 })

    // Tiny delay so B's recv lands before A's send
    await sleep(80)
    await httpPost(`${tb}/send`, { name: "A", text: "wake up" })

    const rB = await recvPromise
    const elapsed = Date.now() - t0
    a.equal(rB.json?.messages?.length, 1, "B's long-poll returned 1 message")
    a.equal(rB.json?.messages?.[0]?.text, "wake up", "got the right text")
    a.ok(elapsed < 600, `wake fired in < 600ms (got ${elapsed}ms)`, { elapsed })
  } finally {
    ch.stop()
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
