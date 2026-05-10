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

  // Close the WS cleanly, wait briefly for the close event to propagate.
  c.close()
  await new Promise((r) => setTimeout(r, 300))

  // Now hit the token URL. Should be app_offline (not token_invalid).
  const r = await httpPost(`/v1/t/${token}/echo`, { x: 1 })
  a.equal(r.status, 503, "post-close → 503")
  a.equal(r.json?.error?.code, "app_offline",
    "code is app_offline (not token_invalid — consistent error regardless of DO eviction state)")
}
