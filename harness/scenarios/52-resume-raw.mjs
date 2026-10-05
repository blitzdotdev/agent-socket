// 52-resume-raw — raw protocol: register_reply carries a resumeSecret; after
// the app socket drops, the session is held. During the gap agents.md still
// answers and a tool call gets 503 app_offline + Retry-After. A socket on
// /v1/_ws?session=<id> with a `resume` frame takes the session back: the SAME
// agent URL works again, the resume's tool list replaces the old one, and
// tokens revoked in the resume frame are gone.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, httpPost, killWs, needsDebug } from "../lib/relay.mjs"

function answerTools(c, tag) {
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === "tool_call") c.send({ type: "tool_reply", id: m.id, status: 200, body: { from: tag, path: m.path } })
  })
}

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const a = new Assert("52-resume-raw")
  const c1 = openRawWs()
  await c1.waitOpen()
  c1.send({ type: "register", appId: "as_app_anon", agentsMd: "# v1", tools: [{ path: "/echo", description: "echo" }] })
  const reg = await c1.waitFor((m) => m.type === "register_reply")
  a.ok(reg.ok && /^[A-Za-z0-9_-]{43}$/.test(reg.resumeSecret ?? ""), "register_reply carries a 43-char resumeSecret", { reg })
  const { sessionId, resumeSecret } = reg
  c1.send({ type: "mint_agent_token", id: "m1", label: "keep" })
  const { token } = await c1.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  c1.send({ type: "mint_agent_token", id: "m2", label: "revoke-offline" })
  const { token: token2 } = await c1.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m2")
  answerTools(c1, "v1")
  a.equal((await httpPost(`/v1/t/${token}/echo`, {})).status, 200, "URL works before the drop")

  a.equal((await killWs(sessionId)).status, 200, "kill-ws")
  const closed1 = await c1.closed
  a.equal(closed1.code, 1011, "old socket closed with 1011")

  // During the gap.
  const md = await httpGet(`/v1/t/${token}/agents.md`)
  a.equal(md.status, 200, "agents.md still served while the app is away")
  const r = await fetch(`${process.env.RELAY_URL ?? "http://localhost:8787"}/v1/t/${token}/echo`, { method: "POST", body: "{}" })
  const body = await r.json()
  a.equal(r.status, 503, "tool call during the gap → 503")
  a.equal(body?.error?.code, "app_offline", "code is app_offline")
  a.equal(r.headers.get("retry-after"), "2", "Retry-After: 2")

  // Resume with a changed tool list and an offline revoke.
  const c2 = openRawWs({ resumeSession: sessionId })
  await c2.waitOpen()
  c2.send({
    type: "resume", sessionId, secret: resumeSecret,
    appId: "as_app_anon", agentsMd: "# v2",
    tools: [{ path: "/echo", description: "echo v2" }, { path: "/new", description: "added on resume" }],
    revokeTokens: [token2],
  })
  const rr = await c2.waitFor((m) => m.type === "register_reply")
  a.ok(rr.ok && rr.resumed === true && rr.sessionId === sessionId && rr.resumeSecret === resumeSecret,
    "resume accepted for the same session", { rr })
  answerTools(c2, "v2")

  const after = await httpPost(`/v1/t/${token}/echo`, {})
  a.equal(after.status, 200, "SAME URL works after resume")
  a.equal(after.json?.from, "v2", "served by the resumed socket", { body: after.json })
  const added = await httpPost(`/v1/t/${token}/new`, {})
  a.equal(added.status, 200, "tool added on resume is callable")
  const tj = JSON.parse((await httpGet(`/v1/t/${token}/tools.json`)).body)
  a.equal(tj.tools.map((t) => t.path), ["/echo", "/new"], "tools.json reflects the resumed tool list")
  a.equal(tj.tools[0].description, "echo v2", "descriptions replaced")
  a.ok((await httpGet(`/v1/t/${token}/agents.md`)).body.includes("# v2"), "agents.md replaced")
  a.equal((await httpPost(`/v1/t/${token2}/echo`, {})).status, 401, "token revoked in the resume frame → 401")

  // A second register on the resumed socket is still refused.
  c2.send({ type: "register", appId: "as_app_anon", agentsMd: "x", tools: [] })
  const again = await c2.waitFor((m) => m.type === "register_reply" && !m.ok)
  a.equal(again.error?.code, "protocol_error", "register after resume → already registered")

  // A clean close (1000) ends the session at once: no grace.
  c2.ws.close(1000, "done")
  await c2.closed
  await new Promise((r) => setTimeout(r, 200))
  const gone = await httpGet(`/v1/t/${token}/agents.md`)
  a.equal(gone.status, 503, "after a 1000 close the session is gone (agents.md → 503)")
}
