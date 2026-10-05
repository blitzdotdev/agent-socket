// 46-no-ip-headers-to-app — the tool_call frame carries the agent's own X-*
// headers but none of the proxy/CF headers that identify the agent's IP.
// Regression for: every x-* header was forwarded, including the x-real-ip /
// x-forwarded-for that Cloudflare adds.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, RELAY_HTTP } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("46-no-ip-headers-to-app")
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/t", description: "t" }] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")

  const call = c.waitFor((m) => m.type === "tool_call", 5000)
  const res = fetch(`${RELAY_HTTP}/v1/t/${token}/t`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trace-id": "abc",
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-proto": "https",
      "cf-connecting-ip": "203.0.113.7",
    },
    body: "{}",
  })
  const m = await call
  c.send({ type: "tool_reply", id: m.id, status: 200, body: {} })
  await res

  a.equal(m.headers["x-trace-id"], "abc", "agent's own X-* header forwarded")
  a.equal(m.headers["content-type"], "application/json", "content-type forwarded")
  const leaked = Object.keys(m.headers).filter((k) => /^(x-real-ip|x-forwarded-|cf-)/.test(k))
  a.equal(leaked, [], "no IP/proxy headers reach the app")
  c.close()
}
