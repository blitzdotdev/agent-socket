// 55-resume-concurrent — with the app socket live, a resume attempt with a
// bad secret is refused (4401) and a plain upgrade on the session is refused
// (4409); neither disturbs the live app. A resume WITH the secret replaces the
// live socket (the old one gets 4410): only the app holds the secret, and the
// old socket is typically half-open (the app saw the drop before the relay).
// Tool calls in flight on the replaced socket fail with 503.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("55-resume-concurrent")
  const reg = { appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/echo", description: "e" }, { path: "/stall", description: "never answers" }] }
  const live = openRawWs()
  await live.waitOpen()
  live.send({ type: "register", ...reg })
  const { sessionId, resumeSecret } = await live.waitFor((m) => m.type === "register_reply" && m.ok)
  live.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await live.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  live.ws.on("message", (d) => {
    const m = JSON.parse(d.toString())
    if (m.type === "tool_call" && m.path === "/echo") live.send({ type: "tool_reply", id: m.id, status: 200, body: { from: "live" } })
  })
  let liveClose = null
  live.closed.then((c) => { liveClose = c })

  const bad = openRawWs({ resumeSession: sessionId })
  await bad.waitOpen()
  bad.send({ type: "resume", sessionId, secret: "A".repeat(43), ...reg })
  a.equal((await bad.closed).code, 4401, "concurrent resume with a bad secret → 4401")

  const plain = openRawWs({ forceSession: sessionId })
  await plain.waitOpen()
  a.equal((await plain.closed).code, 4409, "concurrent plain upgrade → 4409")

  const idle = openRawWs({ resumeSession: sessionId })  // never sends a frame
  await idle.waitOpen()

  const r1 = await httpPost(`/v1/t/${token}/echo`, {})
  a.ok(r1.status === 200 && r1.json?.from === "live", "live app still serves calls", { r1 })
  a.equal(liveClose, null, "live socket untouched")

  // Valid resume takes over; a call stuck on the old socket fails.
  const stuck = httpPost(`/v1/t/${token}/stall`, {})
  await live.waitFor((m) => m.type === "tool_call" && m.path === "/stall")
  const next = openRawWs({ resumeSession: sessionId })
  await next.waitOpen()
  next.send({ type: "resume", sessionId, secret: resumeSecret, ...reg })
  const ok = await next.waitFor((m) => m.type === "register_reply")
  a.ok(ok.ok && ok.resumed, "resume with the secret accepted while the old socket is live", { ok })
  a.equal((await live.closed).code, 4410, "old socket closed 4410 (replaced)")
  const s = await stuck
  a.equal(s.status, 503, "call in flight on the replaced socket → 503")
  next.ws.on("message", (d) => {
    const m = JSON.parse(d.toString())
    if (m.type === "tool_call") next.send({ type: "tool_reply", id: m.id, status: 200, body: { from: "next" } })
  })
  const r2 = await httpPost(`/v1/t/${token}/echo`, {})
  a.ok(r2.status === 200 && r2.json?.from === "next", "same URL now served by the resumed socket", { r2 })

  idle.close()
  next.ws.close(1000)
}
