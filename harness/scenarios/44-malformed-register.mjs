// 44-malformed-register — a register frame with the wrong field types gets a
// register_reply { ok:false }, not silence.
// Regression for: non-array `tools`, a null tool, or a non-string `method`
// threw inside handleRegister, so no reply was sent and the SDK waited out
// its register timeout.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("44-malformed-register")
  const cases = [
    { name: "tools is a number", tools: 5 },
    { name: "tools is an object", tools: { path: "/x" } },
    { name: "tools is a string", tools: "/x" },
    { name: "tool is null", tools: [null] },
    { name: "method is a number", tools: [{ path: "/x", method: 5, description: "x" }] },
    { name: "description is an object", tools: [{ path: "/x", description: { a: 1 } }] },
  ]
  for (const k of cases) {
    const c = openRawWs()
    await c.waitOpen()
    c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: k.tools })
    let reply = null
    try { reply = await c.waitFor((m) => m.type === "register_reply", 2000) } catch {}
    a.ok(reply !== null, `${k.name}: register_reply sent`)
    a.equal(reply.ok, false, `${k.name}: rejected`)
    a.equal(reply.error?.code, "protocol_error", `${k.name}: protocol_error`)
    c.close()
  }
}
