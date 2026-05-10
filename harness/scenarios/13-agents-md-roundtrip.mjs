// 13-agents-md-roundtrip — register with custom agentsMd, GET /agents.md returns it byte-for-byte.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("13-agents-md-roundtrip")
  const c = openRawWs()
  await c.waitOpen()

  const md = "# My App\n\nThese are operating instructions.\n\n- Tool one\n- Tool two\n"

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: md,
    tools: [],
  })
  const reg = await c.waitFor((m) => m.type === "register_reply" && m.ok)
  a.pass("registered")

  c.send({ type: "mint_agent_token", id: "req-1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply")
  const token = mint.token

  const r = await httpGet(`/v1/t/${token}/agents.md`)
  a.equal(r.status, 200, "GET agents.md → 200")
  a.equal(r.headers.get("content-type"), "text/markdown; charset=utf-8", "content-type is markdown")
  a.equal(r.body, md, "body matches what was registered")

  c.close()
}
