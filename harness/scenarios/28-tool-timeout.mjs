// 28-tool-timeout — tool handler that never replies hits MAX_SYNC_TOOL_MS,
// agent gets 504 tool_timeout. Pending entry is cleared so subsequent calls work.
//
// Requires .dev.vars (or env override) to set MAX_SYNC_TOOL_MS to a low value
// so the test runs in seconds, not 30s.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("28-tool-timeout")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "timeout test",
    tools: [
      { method: "POST", path: "/stall", description: "never replies" },
      { method: "POST", path: "/echo", description: "echoes" },
    ],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  // Fire stall — fake app receives tool_call but doesn't reply.
  const startedAt = Date.now()
  const r = await httpPost(`/v1/t/${token}/stall`, {})
  const elapsed = Date.now() - startedAt

  a.equal(r.status, 504, "stalled call → 504")
  a.equal(r.json?.error?.code, "tool_timeout", "code is tool_timeout")
  // .dev.vars sets MAX_SYNC_TOOL_MS=3000; allow some slack.
  a.ok(elapsed >= 2500 && elapsed < 6000,
    `timeout fired in ~3s window (elapsed: ${elapsed}ms)`,
    { elapsed })

  // Pending should be drained — a fresh call works.
  const echoPromise = (async () => {
    const call = await c.waitFor((m) => m.type === "tool_call" && m.path === "/echo", 5000)
    c.send({ type: "tool_reply", id: call.id, status: 200, body: { ok: true } })
  })()
  const r2 = await httpPost(`/v1/t/${token}/echo`, { x: 1 })
  await echoPromise
  a.equal(r2.status, 200, "fresh call after timeout works")

  c.close()
}
