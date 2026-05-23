// 68-channel-awaiting-delivery-time — `awaiting` is computed at delivery
// time, not send time. The same message can show awaiting:true to one
// reader and awaiting:false to another if the sender's wait expired in
// between.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("68-channel-awaiting-delivery-time")
  const ch = await startChannelHost({ waitCapMs: 500, quietCapMs: 500 })
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // bob is waiting; alice does a send-and-wait (350ms). bob's recv returns
    // immediately with awaiting:true.
    const bobP = httpPost(`${tb}/recv`, { name: "bob", since: 0, wait: 2 })
    await sleep(50)
    const aliceP = httpPost(`${tb}/recv`, { name: "alice", since: 0, wait: 0.35, message: "still here?" })
    const bob1 = await bobP
    a.equal(bob1.json?.messages?.[0]?.awaiting, true, "delivery-time true: alice still waiting when bob read")
    await aliceP   // wait for alice's recv to finish

    // Now alice has stopped waiting. A NEW reader (carl) fetches with no
    // since — alice's earlier message should now show awaiting:false because
    // alice has no open long-poll.
    await sleep(50)
    const carl = await httpPost(`${tb}/recv`, { name: "carl", wait: 0 })
    const aliceMsg = carl.json.messages.find((m) => m.from === "alice")
    a.ok(aliceMsg, "carl sees alice's earlier message in scrollback")
    a.equal(aliceMsg.awaiting, false,
      "delivery-time false: alice's wait expired before carl read — same message, different awaiting")
  } finally {
    ch.stop()
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
