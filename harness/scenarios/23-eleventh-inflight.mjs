// 23-eleventh-inflight — 11th simultaneous tool call is rejected with 429
// `too_many_inflight`. The first 10 sit pending; we drain by closing the WS
// (which fails them with 503).

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("23-eleventh-inflight")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "rate-limit test",
    tools: [{ method: "POST", path: "/stall", description: "never replies" }],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  // The fake app deliberately ignores tool_calls — never replies.
  // (No listener installed, so frames pile up in c.inbox.)

  // Fire 10 concurrent calls that won't be answered.
  const stalled = []
  for (let i = 0; i < 10; i++) {
    stalled.push(httpPost(`/v1/t/${token}/stall`, { i }))
  }

  // Wait until the relay has actually received 10 tool_call frames before
  // firing the 11th — otherwise we race the relay's pending counter.
  for (let attempt = 0; attempt < 50; attempt++) {
    const seen = c.inbox.filter((m) => m.type === "tool_call").length
    if (seen >= 10) break
    await new Promise((r) => setTimeout(r, 50))
  }
  a.equal(c.inbox.filter((m) => m.type === "tool_call").length, 10, "relay received 10 stalled tool_calls")

  // 11th — should hit 429.
  const eleventh = await httpPost(`/v1/t/${token}/stall`, { i: 11 })
  a.equal(eleventh.status, 429, "11th call → 429")
  a.equal(eleventh.json?.error?.code, "too_many_inflight", "code is too_many_inflight")

  // Drain: close WS, the 10 stalled should resolve with 503 app_offline.
  c.close()
  const results = await Promise.allSettled(stalled)
  for (const r of results) {
    if (r.status !== "fulfilled") {
      a.ok(false, "stalled call should have settled", { reason: r.reason?.message })
      continue
    }
    a.equal(r.value.status, 503, "stalled call → 503 after WS close")
    a.equal(r.value.json?.error?.code, "app_offline", "code is app_offline")
  }
}
