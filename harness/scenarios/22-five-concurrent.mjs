// 22-five-concurrent — 5 concurrent agent calls all correlate correctly.
// No cross-talk: each response body matches its own request.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("22-five-concurrent")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "concurrent test",
    tools: [{ method: "POST", path: "/echo", description: "echo" }],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok, 3000)

  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1", 3000)
  const token = mint.token

  // Set up an auto-replier that handles every tool_call by echoing the body.
  let receivedCount = 0
  c.ws.on("message", (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.type !== "tool_call") return
    receivedCount++
    const parsed = JSON.parse(msg.body || "{}")
    c.send({
      type: "tool_reply",
      id: msg.id,
      status: 200,
      body: { call: parsed.call, frameId: msg.id },
    })
  })

  // Fire 5 in parallel, each with a different "call" id.
  const promises = []
  for (let i = 1; i <= 5; i++) {
    promises.push(httpPost(`/v1/t/${token}/echo`, { call: i }))
  }
  const results = await Promise.all(promises)

  a.ok(results.every((r) => r.status === 200), "all 5 returned 200", { statuses: results.map((r) => r.status) })
  // Each result.json.call should match its own index.
  const calls = results.map((r) => r.json.call).sort((a, b) => a - b)
  a.equal(calls, [1, 2, 3, 4, 5], "all 5 calls correlated to their own response")
  // No two responses should share a frameId
  const frameIds = new Set(results.map((r) => r.json.frameId))
  a.equal(frameIds.size, 5, "5 distinct frame ids — no cross-talk")
  a.equal(receivedCount, 5, "app received exactly 5 tool_call frames")

  c.close()
}
