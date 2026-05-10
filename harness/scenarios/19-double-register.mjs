// 19-double-register — second register on the same WS is rejected with protocol_error.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("19-double-register")
  const c = openRawWs()
  await c.waitOpen()

  c.send({ type: "register", appId: "as_app_anon", agentsMd: "first", tools: [] })
  const r1 = await c.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(r1.ok, true, "first register ok")

  c.send({ type: "register", appId: "as_app_anon", agentsMd: "second", tools: [] })
  const r2 = await c.waitFor((m) => m.type === "register_reply" && m !== r1, 3000)
  a.equal(r2.ok, false, "second register rejected")
  a.equal(r2.error?.code, "protocol_error", "error code protocol_error")

  c.close()
}
