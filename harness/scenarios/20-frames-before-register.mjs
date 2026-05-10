// 20-frames-before-register — sending mint/revoke/list before register
// returns a protocol_error reply rather than crashing or silently succeeding.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("20-frames-before-register")
  const c = openRawWs()
  await c.waitOpen()

  c.send({ type: "mint_agent_token", id: "m1", label: "early" })
  const r = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1", 3000)
  a.equal(r.ok, false, "pre-register mint rejected")
  a.equal(r.error?.code, "protocol_error", "error code protocol_error")

  // After this, register should still work normally
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "x", tools: [] })
  const reg = await c.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(reg.ok, true, "register works after rejected early mint")
  c.close()
}
