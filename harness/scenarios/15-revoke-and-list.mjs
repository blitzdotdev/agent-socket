// 15-revoke-and-list — mint two tokens, list shows both, revoke one, list shows one,
// revoked token returns 401 on agent calls.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost, httpGet } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("15-revoke-and-list")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "# revoke test",
    tools: [{ method: "POST", path: "/echo", description: "echo" }],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "alice" })
  c.send({ type: "mint_agent_token", id: "m2", label: "bob" })
  const t1 = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const t2 = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m2")
  a.ok(t1.token !== t2.token, "two distinct tokens minted", { t1: t1.token, t2: t2.token })

  c.send({ type: "list_agent_tokens", id: "l1" })
  const list1 = await c.waitFor((m) => m.type === "list_agent_tokens_reply" && m.id === "l1")
  a.equal(list1.tokens.length, 2, "list shows 2 tokens")
  const labels = list1.tokens.map((t) => t.label).sort()
  a.equal(labels, ["alice", "bob"], "labels round-trip")

  // Revoke alice
  c.send({ type: "revoke_agent_token", id: "r1", token: t1.token })
  const rev1 = await c.waitFor((m) => m.type === "revoke_agent_token_reply" && m.id === "r1")
  a.equal(rev1.ok, true, "revoke returns ok")

  c.send({ type: "list_agent_tokens", id: "l2" })
  const list2 = await c.waitFor((m) => m.type === "list_agent_tokens_reply" && m.id === "l2")
  a.equal(list2.tokens.length, 1, "list shows 1 token after revoke")
  a.equal(list2.tokens[0].label, "bob", "bob remains")

  // Try the revoked token — should be 401, and no tool_call frame should reach the app.
  const inboxBeforeRevoked = c.inbox.length
  const r = await httpPost(`/v1/t/${t1.token}/echo`, {})
  a.equal(r.status, 401, "revoked token → 401")
  a.equal(r.json?.error?.code, "token_invalid", "code is token_invalid")
  // Give the relay 200ms to forward the (rejected) call, in case it does so wrongly.
  await new Promise((r) => setTimeout(r, 200))
  const newFrames = c.inbox.slice(inboxBeforeRevoked).filter((m) => m.type === "tool_call")
  a.equal(newFrames.length, 0, "no tool_call frame sent to app for revoked token")

  // Bob's token still works
  const echoPromise = (async () => {
    const call = await c.waitFor((m) => m.type === "tool_call", 5000)
    c.send({ type: "tool_reply", id: call.id, status: 200, body: { ok: true } })
  })()
  const r2 = await httpPost(`/v1/t/${t2.token}/echo`, {})
  await echoPromise
  a.equal(r2.status, 200, "live token → 200")

  c.close()
}
