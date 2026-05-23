// 61-channel-multiparty — A sends, B and C both see; sender doesn't see own.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("61-channel-multiparty")
  const ch = await startChannelHost()
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    await httpPost(`${tb}/send`, { name: "A", text: "msg 1 from A" })

    const rB = await httpPost(`${tb}/recv`, { name: "B", wait: 0 })
    a.equal(rB.json?.messages?.length, 1, "B sees A's message")
    a.equal(rB.json?.messages?.[0]?.from, "A", "B sees sender=A")

    const rC = await httpPost(`${tb}/recv`, { name: "C", wait: 0 })
    a.equal(rC.json?.messages?.length, 1, "C also sees A's message")

    // Sender's own scrollback skips their own message.
    const rA = await httpPost(`${tb}/recv`, { name: "A", wait: 0 })
    a.equal(rA.json?.messages?.length, 0, "A's scrollback excludes A's own message")
  } finally {
    ch.stop()
  }
}
