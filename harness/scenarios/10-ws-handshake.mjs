// 10-ws-handshake — open WS, send register, receive register_reply { ok, sessionId }.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("10-ws-handshake")
  const c = openRawWs()
  await c.waitOpen()
  a.pass("WS open")

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "# test\nhello",
    tools: [],
  })

  const reply = await c.waitFor((m) => m.type === "register_reply")
  a.equal(reply.ok, true, "register_reply.ok === true")
  a.ok(typeof reply.sessionId === "string" && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(reply.sessionId),
    "sessionId is 8-char Crockford base32",
    { sessionId: reply.sessionId })

  c.close()
}
