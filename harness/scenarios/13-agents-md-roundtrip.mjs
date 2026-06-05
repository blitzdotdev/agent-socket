// 13-agents-md-roundtrip — register with custom agentsMd, GET /agents.md returns it.
//
// Since the framework-preamble fix (commit f5b12d2), the relay prepends a canonical
// "how to call tools" contract to served agents.md UNLESS the app's own doc already
// references `tools.json`. This scenario's fixture md doesn't reference tools.json,
// so the served body is preamble + app text. The exact preamble shape is covered
// in scenario 38; here we just check the app's text is preserved AT THE END and
// the content type is still markdown.

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
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  a.pass("registered")

  c.send({ type: "mint_agent_token", id: "req-1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply")
  const token = mint.token

  const r = await httpGet(`/v1/t/${token}/agents.md`)
  a.equal(r.status, 200, "GET agents.md → 200")
  a.equal(r.headers.get("content-type"), "text/markdown; charset=utf-8", "content-type is markdown")
  a.ok(r.body.endsWith(md), "app's registered md is preserved at end of served body")
  a.ok(r.body.length > md.length, "preamble was prepended (served body strictly longer than app md)")

  c.close()
}
