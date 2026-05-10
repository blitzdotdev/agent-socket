// 27-ws-drop-fails-inflight — agent call is in flight, app's WS drops mid-flight,
// agent's HTTP returns 503 app_offline (not a hung connection).

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("27-ws-drop-fails-inflight")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "drop test",
    tools: [{ method: "POST", path: "/stall", description: "stalls" }],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  // Start an agent call that the fake app deliberately won't reply to.
  const agentCall = httpPost(`/v1/t/${token}/stall`, { x: 1 })

  // Wait until the relay has forwarded the tool_call.
  await c.waitFor((m) => m.type === "tool_call", 5000)
  a.pass("relay forwarded tool_call to app")

  // Now drop the WS without replying. The pending HTTP request should resolve.
  c.close()

  const r = await agentCall
  a.equal(r.status, 503, "in-flight call → 503 after WS drop")
  a.equal(r.json?.error?.code, "app_offline", "code is app_offline")
}
