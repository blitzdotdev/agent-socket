// 12-roundtrip-raw — register a tool, mint a token, curl it as the agent.
// The fake app (this scenario) replies to the tool_call with an echo body;
// the curl response should match.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("12-roundtrip-raw")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "# test",
    tools: [
      { method: "POST", path: "/echo", description: "Echoes the body." },
    ],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  a.pass("registered with /echo tool")

  c.send({ type: "mint_agent_token", id: "req-1", label: "echo-test" })
  const reply = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "req-1")
  const token = reply.token
  a.ok(token, "minted token", { reply })

  // Set up tool_call handler in the WS client BEFORE issuing curl.
  // We use a handler-style: as soon as we see a tool_call, we send back the reply.
  const echoPromise = (async () => {
    const call = await c.waitFor((m) => m.type === "tool_call", 10_000)
    const parsed = JSON.parse(call.body || "{}")
    c.send({
      type: "tool_reply",
      id: call.id,
      status: 200,
      body: { ...parsed, echoed: true, path: call.path },
    })
  })()

  // Now act as the agent — POST to the /echo tool.
  const r = await httpPost(`/v1/t/${token}/echo`, { hello: "world" })
  await echoPromise

  a.equal(r.status, 200, "agent POST → 200")
  a.ok(r.json && r.json.echoed === true, "response body has echoed: true", { body: r.json })
  a.equal(r.json.hello, "world", "request body round-tripped")
  a.equal(r.json.path, "/echo", "path forwarded correctly")

  c.close()
}
