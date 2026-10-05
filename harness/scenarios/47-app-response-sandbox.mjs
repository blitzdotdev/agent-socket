// 47-app-response-sandbox — app-controlled tool/task responses can't run
// script on the relay's origin: any *+xml type is downgraded to text/plain
// like text/html, and every such response carries a sandboxing CSP.
// Regression for: application/foo+xml (rendered as XML, script and all, by
// Chrome) passed through verbatim, and there was no CSP backstop.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, RELAY_HTTP } from "../lib/relay.mjs"

const CSP = "sandbox; default-src 'none'"

export default async function () {
  const a = new Assert("47-app-response-sandbox")
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/t", description: "t" }] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const replies = []
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === "tool_call") c.send({ type: "tool_reply", id: m.id, ...replies.shift() })
  })
  const call = async (reply) => {
    replies.push(reply)
    return fetch(`${RELAY_HTTP}/v1/t/${token}/t`, { method: "POST", body: "{}" })
  }

  const svgish = '<x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script>'
  for (const ct of ["application/foo+xml", "application/rss+xml; charset=utf-8", "text/html"]) {
    const r = await call({ status: 200, body: svgish, headers: { "content-type": ct } })
    a.ok(r.headers.get("content-type").startsWith("text/plain"), `${ct} downgraded to text/plain`, { got: r.headers.get("content-type") })
    a.equal(r.headers.get("content-security-policy"), CSP, `${ct}: sandbox CSP`)
  }

  const plain = await call({ status: 200, body: "hi", headers: { "content-type": "text/markdown" } })
  a.equal(plain.headers.get("content-type"), "text/markdown", "safe type still passes through")
  a.equal(plain.headers.get("content-security-policy"), CSP, "string reply: sandbox CSP")

  const json = await call({ status: 200, body: { ok: true } })
  a.equal(json.headers.get("content-security-policy"), CSP, "JSON reply: sandbox CSP")

  await call({ status: 202, taskId: "t1" })
  c.send({ type: "task_complete", taskId: "t1", status: 200, body: svgish, headers: { "content-type": "image/foo+xml" } })
  await new Promise((r) => setTimeout(r, 200))
  const poll = await fetch(`${RELAY_HTTP}/v1/t/${token}/_as_tasks/t1`)
  a.ok(poll.headers.get("content-type").startsWith("text/plain"), "task +xml downgraded", { got: poll.headers.get("content-type") })
  a.equal(poll.headers.get("content-security-policy"), CSP, "task poll: sandbox CSP")

  c.close()
}
