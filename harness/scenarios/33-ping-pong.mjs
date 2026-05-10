// 33-ping-pong — app sends ping, relay replies with pong of same id;
// pings don't count against MAX_INFLIGHT.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("33-ping-pong")
  const c = openRawWs()
  await c.waitOpen()

  // Pre-register ping is fine (heartbeat doesn't depend on registration).
  c.send({ type: "ping", id: "early-1" })
  const pong1 = await c.waitFor((m) => m.type === "pong" && m.id === "early-1", 3000)
  a.equal(pong1.id, "early-1", "pong matches early ping id")

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "ping test",
    tools: [{ method: "POST", path: "/echo", description: "echo" }],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  // Post-register ping
  c.send({ type: "ping", id: "post-1" })
  const pong2 = await c.waitFor((m) => m.type === "pong" && m.id === "post-1", 3000)
  a.equal(pong2.id, "post-1", "pong matches post-register ping id")

  // Pings don't count toward inflight cap — fire 10 pings then 10 stalled
  // tool calls; the 10th tool call must still succeed (i.e. ping wasn't
  // counted in pending).
  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  for (let i = 0; i < 10; i++) c.send({ type: "ping", id: `p${i}` })
  // Drain the 10 pongs to keep inbox clean (best-effort).
  for (let i = 0; i < 10; i++) {
    await c.waitFor((m) => m.type === "pong" && m.id === `p${i}`, 1000).catch(() => {})
  }

  // Now fire 10 in-flight tool calls — should all be accepted.
  const stalled = []
  for (let i = 0; i < 10; i++) stalled.push(httpPost(`/v1/t/${token}/echo`, { i }))
  // Wait for relay to receive them.
  for (let attempt = 0; attempt < 50; attempt++) {
    const seen = c.inbox.filter((m) => m.type === "tool_call").length
    if (seen >= 10) break
    await new Promise((r) => setTimeout(r, 50))
  }
  const seen = c.inbox.filter((m) => m.type === "tool_call").length
  a.equal(seen, 10, "10 tool_calls accepted (pings didn't fill the inflight cap)")

  c.close()
  await Promise.allSettled(stalled)
}
