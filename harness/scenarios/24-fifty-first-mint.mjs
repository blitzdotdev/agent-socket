// 24-fifty-first-mint — 51st mint_agent_token returns too_many_tokens.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("24-fifty-first-mint")
  const c = openRawWs()
  await c.waitOpen()

  c.send({ type: "register", appId: "as_app_anon", agentsMd: "test", tools: [] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  // First 50 mints should succeed.
  for (let i = 0; i < 50; i++) {
    c.send({ type: "mint_agent_token", id: `m${i}`, label: `t${i}` })
    const r = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === `m${i}`)
    if (!r.ok) {
      a.ok(false, `mint ${i + 1} should succeed but got ${r.error?.code}`, { reply: r })
      return
    }
  }
  a.pass("first 50 mints succeeded")

  // 51st should fail.
  c.send({ type: "mint_agent_token", id: "m51", label: "extra" })
  const r51 = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m51")
  a.equal(r51.ok, false, "51st mint rejected")
  a.equal(r51.error?.code, "too_many_tokens", "code is too_many_tokens")

  c.close()
}
