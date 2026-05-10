// 17-duplicate-tool — two tools with the same (method, path) rejected at register.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("17-duplicate-tool")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "dup test",
    tools: [
      { method: "POST", path: "/echo", description: "first" },
      { method: "POST", path: "/echo", description: "second (dup)" },
    ],
  })
  const reply = await c.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(reply.ok, false, "duplicate tool registration rejected")
  a.equal(reply.error?.code, "protocol_error", "error code protocol_error")
  c.close()
}
