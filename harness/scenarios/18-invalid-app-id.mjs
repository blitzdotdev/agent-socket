// 18-invalid-app-id — app-id is a free-form label: any [A-Za-z0-9_.-]{1,64}
// registers (and shows up in tools.json), anything else is invalid_app_id.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

async function register(appId) {
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId, agentsMd: "test", tools: [] })
  const reply = await c.waitFor((m) => m.type === "register_reply", 3000)
  c.close()
  return reply
}

export default async function () {
  const a = new Assert("18-invalid-app-id")
  for (const bad of ["", "has space", "x".repeat(65), "<script>", 42, null]) {
    const reply = await register(bad)
    a.equal(reply.ok, false, `${JSON.stringify(bad)} rejected`)
    a.equal(reply.error?.code, "invalid_app_id", `${JSON.stringify(bad)}: invalid_app_id`)
  }
  for (const good of ["as_app_anon", "my-app.v2", "x".repeat(64)]) {
    a.equal((await register(good)).ok, true, `${good.slice(0, 20)} accepted`)
  }
}
