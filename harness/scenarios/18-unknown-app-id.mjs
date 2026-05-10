// 18-unknown-app-id — register with an app-id absent from apps.json fails.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("18-unknown-app-id")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_does_not_exist",
    agentsMd: "test",
    tools: [],
  })
  const reply = await c.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(reply.ok, false, "unknown app-id rejected")
  a.equal(reply.error?.code, "unknown_app_id", "error code unknown_app_id")
  c.close()
}
