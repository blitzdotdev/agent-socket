// 63-channel-awaiting-flag — verifies the per-message awaiting flag.
// Two assertions:
//   (a) plain /send → recipient sees awaiting:false (sender isn't waiting)
//   (b) /recv with message + wait>0 → recipient sees awaiting:true

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("63-channel-awaiting-flag")
  const ch = await startChannelHost()
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // (a) plain send — recipient should see awaiting:false
    const recvB1 = httpPost(`${tb}/recv`, { name: "B", since: 0, wait: 2 })
    await sleep(60)
    await httpPost(`${tb}/send`, { name: "A", text: "plain" })
    const r1 = await recvB1
    a.equal(r1.json?.messages?.[0]?.awaiting, false, "(a) plain send → awaiting:false")

    // (b) /recv with message — A is now waiting, so B sees awaiting:true
    const recvB2 = httpPost(`${tb}/recv`, { name: "B", since: r1.json.latest_seq, wait: 2 })
    await sleep(60)
    const recvA  = httpPost(`${tb}/recv`, { name: "A", since: r1.json.latest_seq, wait: 2, message: "with wait" })
    const [r2, rA] = await Promise.all([recvB2, recvA])
    a.equal(r2.json?.messages?.length, 1, "(b) B got A's broadcast")
    a.equal(r2.json?.messages?.[0]?.awaiting, true, "(b) send-and-wait → awaiting:true")
    // A's own recv saw no messages (B never replied)
    a.equal(rA.json?.messages?.length, 0, "(b) A's recv saw nothing (B never replied)")
  } finally {
    ch.stop()
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
