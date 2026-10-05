// 23-eleventh-inflight — the (MAX_INFLIGHT+1)th simultaneous tool call is
// rejected with 429 `too_many_inflight`. The first MAX_INFLIGHT sit pending;
// we drain by closing the WS (which fails them with 503). MAX_INFLIGHT is 100.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost, RELAY_IS_LOCAL } from "../lib/relay.mjs"

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

  const MAX_INFLIGHT = 100

  // Fire MAX_INFLIGHT concurrent calls that won't be answered.
  const stalled = []
  for (let i = 0; i < MAX_INFLIGHT; i++) {
    stalled.push(httpPost(`/v1/t/${token}/stall`, { i }))
  }

  // Wait until the relay has actually received all MAX_INFLIGHT tool_call
  // frames before firing the next one — otherwise we race the pending counter.
  // Over the internet, 100 fresh connections take several seconds to land.
  const attempts = RELAY_IS_LOCAL ? 100 : 400
  for (let attempt = 0; attempt < attempts; attempt++) {
    const seen = c.inbox.filter((m) => m.type === "tool_call").length
    if (seen >= MAX_INFLIGHT) break
    await new Promise((r) => setTimeout(r, 50))
  }
  a.equal(c.inbox.filter((m) => m.type === "tool_call").length, MAX_INFLIGHT, `relay received ${MAX_INFLIGHT} stalled tool_calls`)

  // (MAX_INFLIGHT+1)th — should hit 429.
  const overflow = await httpPost(`/v1/t/${token}/stall`, { i: MAX_INFLIGHT + 1 })
  a.equal(overflow.status, 429, `call ${MAX_INFLIGHT + 1} → 429`)
  a.equal(overflow.json?.error?.code, "too_many_inflight", "code is too_many_inflight")

  // Drain: close WS, the stalled calls should resolve with 503 app_offline.
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
