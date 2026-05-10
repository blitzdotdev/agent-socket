// 11-mint-raw-ws — register, then mint_agent_token, verify reply shape.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("11-mint-raw-ws")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "# test",
    tools: [],
  })
  const reg = await c.waitFor((m) => m.type === "register_reply")
  a.equal(reg.ok, true, "registered ok")
  const sessionId = reg.sessionId

  c.send({ type: "mint_agent_token", id: "req-1", label: "test-token" })
  const reply = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "req-1")

  a.equal(reply.ok, true, "mint reply ok")
  a.ok(typeof reply.token === "string", "token is a string", { reply })
  // Token should match `as_<sessionId>_<22-char-base64url>`
  const re = new RegExp(`^as_${sessionId}_[A-Za-z0-9_-]{22}$`)
  a.ok(re.test(reply.token), "token matches expected format", { token: reply.token, sessionId })
  a.equal(reply.label, "test-token", "label round-trips")
  a.equal(reply.expiresAt, null, "expiresAt is null in v0")
  a.ok(typeof reply.url === "string" && reply.url.includes(reply.token), "url contains token", { url: reply.url })

  c.close()
}
