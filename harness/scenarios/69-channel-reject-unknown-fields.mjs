// 69-channel-reject-unknown-fields — /send and /recv reject unknown JSON
// fields with bad_input (instead of silently swallowing them). Catches typos
// like since_seq vs since, text vs message.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("69-channel-reject-unknown-fields")
  const ch = await startChannelHost()
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // /send with an unknown field
    const r1 = await httpPost(`${tb}/send`, { name: "alice", text: "ok", haxxor: 1 })
    a.equal(r1.status, 400, "/send + unknown field → 400")
    a.equal(r1.json?.error?.code, "bad_input", "code bad_input")
    a.ok(/haxxor/.test(r1.json?.error?.message ?? ""), "error names the offending field", { msg: r1.json?.error?.message })

    // /recv with since_seq (the actual reported typo)
    const r2 = await httpPost(`${tb}/recv`, { name: "bob", since_seq: 5 })
    a.equal(r2.status, 400, "/recv + since_seq typo → 400")
    a.equal(r2.json?.error?.code, "bad_input", "code bad_input")
    a.ok(/since_seq/.test(r2.json?.error?.message ?? ""), "error names since_seq")

    // /recv with text (would be valid on /send but not here)
    const r3 = await httpPost(`${tb}/recv`, { name: "bob", text: "broadcast?" })
    a.equal(r3.status, 400, "/recv + text → 400")
    a.equal(r3.json?.error?.code, "bad_input")

    // Sanity: valid /send still works
    const r4 = await httpPost(`${tb}/send`, { name: "alice", text: "ok" })
    a.equal(r4.status, 200, "valid /send still works")
    a.equal(r4.json?.ok, true, "ok:true")

    // Sanity: valid /recv still works
    const r5 = await httpPost(`${tb}/recv`, { name: "bob", since: 0, wait: 0 })
    a.equal(r5.status, 200, "valid /recv still works")
    a.ok(Array.isArray(r5.json?.messages), "messages array present")
  } finally {
    ch.stop()
  }
}
