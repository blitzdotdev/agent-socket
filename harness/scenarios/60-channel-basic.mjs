// 60-channel-basic — start a channel host, agent /send + /recv round-trips.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("60-channel-basic")
  const ch = await startChannelHost()
  try {
    a.ok(/\/v1\/t\/as_[A-Z0-9]{8}_/.test(ch.tokenBase), "tokenBase has expected shape", { tokenBase: ch.tokenBase })

    const tb = relative(ch.tokenBase)

    const r1 = await httpPost(`${tb}/send`, { name: "alice", text: "hello" })
    a.equal(r1.status, 200, "/send → 200")
    a.equal(r1.json?.ok, true, "/send returns ok:true")
    a.equal(r1.json?.seq, 1, "first send → seq 1")

    const r2 = await httpPost(`${tb}/recv`, { name: "bob", wait: 0 })
    a.equal(r2.status, 200, "/recv → 200")
    a.equal(r2.json?.messages?.length, 1, "bob sees alice's message in scrollback")
    a.equal(r2.json?.messages?.[0]?.text, "hello", "message text matches")
    a.equal(r2.json?.messages?.[0]?.from, "alice", "from matches")

    // Bob's recv with the same since returns nothing (he's caught up).
    const r3 = await httpPost(`${tb}/recv`, { name: "bob", since: r2.json.latest_seq, wait: 0 })
    a.equal(r3.json?.messages?.length, 0, "bob caught up sees no more messages")
  } finally {
    ch.stop()
  }
}

function relative(absUrl) {
  return absUrl.replace(/^https?:\/\/[^/]+/, "")
}
