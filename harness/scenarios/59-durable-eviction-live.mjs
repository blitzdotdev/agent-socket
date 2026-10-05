// 59-durable-eviction-live — the session's object is reset (eviction, relay
// restart) while the app is connected. The app's socket goes with it; the
// reloaded object finds no app socket and starts the hold, so the app's resume
// works and every URL survives. A token revoked before the reset stays revoked.
// Both with a raw socket and with the SDK, which resumes on its own.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, httpPost, evict, debugState, needsDebug, sdkHeartbeat, until, RELAY_HTTP } from "../lib/relay.mjs"
import { connect, noBackoff } from "@agent-socket/sdk"

const reg = { appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/echo", description: "e" }] }

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const a = new Assert("59-durable-eviction-live")

  // Raw: register, mint, revoke, evict.
  const c1 = openRawWs()
  await c1.waitOpen()
  c1.send({ type: "register", ...reg })
  const { sessionId, resumeSecret } = await c1.waitFor((m) => m.type === "register_reply" && m.ok)
  c1.send({ type: "mint_agent_token", id: "m1", label: "a" })
  const { token } = await c1.waitFor((m) => m.id === "m1")
  c1.send({ type: "mint_agent_token", id: "m2", label: "b" })
  const { token: revoked } = await c1.waitFor((m) => m.id === "m2")
  c1.send({ type: "revoke_agent_token", id: "r1", token: revoked })
  await c1.waitFor((m) => m.id === "r1")
  await evict(sessionId)
  const closed = await Promise.race([c1.closed, new Promise((r) => setTimeout(() => r(null), 15_000))])
  a.ok(closed !== null, "the app's socket dropped with the object", { closed })

  const st = await debugState(sessionId)
  a.ok(st.session && !st.appConnected && st.heldUntil !== null && st.alarm === st.heldUntil, "reloaded object holds the session", { st })
  a.equal((await httpGet(`/v1/t/${token}/agents.md`)).status, 200, "agents.md after the reset")
  a.equal((await httpGet(`/v1/t/${revoked}/agents.md`)).status, 401, "revoked token still 401 after the reset")

  const c2 = openRawWs({ resumeSession: sessionId })
  await c2.waitOpen()
  c2.send({ type: "resume", sessionId, secret: resumeSecret, ...reg })
  const rr = await c2.waitFor((m) => m.type === "register_reply")
  a.ok(rr.ok && rr.resumed, "resume after the reset", { rr })
  c2.ws.on("message", (d) => {
    const m = JSON.parse(d.toString())
    if (m.type === "tool_call") c2.send({ type: "tool_reply", id: m.id, status: 200, body: {} })
  })
  a.equal((await httpPost(`/v1/t/${token}/echo`, {})).status, 200, "same URL works")
  a.equal((await httpGet(`/v1/t/${revoked}/agents.md`)).status, 401, "revoked token still 401 after the resume")
  c2.ws.close(1000)
  await c2.closed

  // SDK: the reset looks like any drop; it resumes the same session.
  const reconnects = [], changes = []
  const s = await connect({
    ...reg,
    tools: [{ path: "/echo", description: "e", handler: () => ({ sdk: true }) }],
    baseUrl: RELAY_HTTP,
    onDisconnect: noBackoff(),
    onReconnect: (i) => reconnects.push(i),
    onSessionChanged: (i) => changes.push(i),
    ...sdkHeartbeat(),
  })
  try {
    const link = await s.mintAgentToken({ label: "sdk" })
    await evict(s.sessionId)
    await until(() => reconnects.length >= 1 && s.connected, "the SDK's resume", 20_000)
    a.ok(reconnects[0].resumed, "SDK resumed the same session", { reconnects })
    a.equal(changes.length, 0, "no onSessionChanged")
    const r = await httpPost(`/v1/t/${link.token}/echo`, {})
    a.ok(r.status === 200 && r.json?.sdk === true, "SDK link works after the reset", { r })
    const tokens = await s.listAgentTokens()
    a.equal(tokens.map((t) => t.token), [link.token], "list after the reset")
  } finally {
    s.close()
  }
}
