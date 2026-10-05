// 29-token-after-close — token URL hit after app's WS closes returns
// 503 app_offline (consistent regardless of whether the DO is still in
// memory or freshly spun up). Verifies the "app_offline before token check"
// ordering — design doc §6.5 says the relay shouldn't leak session-lifecycle
// info via different error codes.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("29-token-after-close")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "after-close test",
    tools: [{ method: "POST", path: "/echo", description: "echo" }],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  // Close the WS cleanly (1000 ends the session; a bare close() would only
  // detach it for the resume grace window), wait for the close to propagate.
  c.ws.close(1000)
  await new Promise((r) => setTimeout(r, 300))

  // Now hit the token URL. Should be app_offline (not token_invalid).
  const r = await httpPost(`/v1/t/${token}/echo`, { x: 1 })
  a.equal(r.status, 503, "post-close → 503")
  a.equal(r.json?.error?.code, "app_offline",
    "code is app_offline (not token_invalid — consistent error regardless of DO eviction state)")
  // The message tells the agent what to do about a dead link.
  a.ok(/ask the user to reconnect/.test(r.json?.error?.message ?? ""), `message guides the agent: ${r.json?.error?.message}`)

  // A token for a session that never existed gets the very same answer.
  const ids = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  const sid = Array.from({ length: 8 }, () => ids[Math.floor(Math.random() * ids.length)]).join("")
  const never = await httpPost(`/v1/t/as_${sid}_${"A".repeat(22)}/echo`, { x: 1 })
  a.equal(never.status, 503, "never-existed session → 503")
  a.equal(JSON.stringify(never.json), JSON.stringify(r.json), "same body as an ended session (no lifecycle leak)")
}
