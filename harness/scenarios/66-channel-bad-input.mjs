// 66-channel-bad-input — /send and /recv reject invalid bodies cleanly.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("66-channel-bad-input")
  const ch = await startChannelHost()
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // /send without name
    const r1 = await httpPost(`${tb}/send`, { text: "no name" })
    a.equal(r1.status, 400, "/send without name → 400")
    a.equal(r1.json?.error?.code, "bad_input", "/send no-name code is bad_input")

    // /send without text
    const r2 = await httpPost(`${tb}/send`, { name: "alice" })
    a.equal(r2.status, 400, "/send without text → 400")
    a.equal(r2.json?.error?.code, "bad_input", "/send no-text code is bad_input")

    // /recv with message but no name
    const r3 = await httpPost(`${tb}/recv`, { message: "anon broadcast" })
    a.equal(r3.status, 400, "/recv with message but no name → 400")
    a.equal(r3.json?.error?.code, "bad_input", "anonymous send-via-recv rejected")

    // /send with oversize text → message_too_large
    const big = "x".repeat(64 * 1024 + 1)
    const r4 = await httpPost(`${tb}/send`, { name: "alice", text: big })
    a.equal(r4.status, 400, "/send oversize → 400")
    a.equal(r4.json?.error?.code, "message_too_large", "oversize code is message_too_large")
  } finally {
    ch.stop()
  }
}
