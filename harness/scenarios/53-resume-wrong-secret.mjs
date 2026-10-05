// 53-resume-wrong-secret — a resume with a wrong secret, a malformed secret,
// another session's id, an agent token's verifier as the secret, or a
// non-resume first frame is refused (register_reply resume_failed + close
// 4401, or close on timeout) and leaves the held session intact. A plain
// upgrade can't take a held session either (4409). The SDK, handed a bad
// saved secret, falls back to a fresh session.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost, killWs, RELAY_HTTP, needsDebug } from "../lib/relay.mjs"
import { connect } from "@agent-socket/sdk"

async function attempt(sessionId, frame) {
  const c = openRawWs({ resumeSession: sessionId })
  await c.waitOpen()
  c.send(frame)
  const reply = await c.waitFor((m) => m.type === "register_reply", 3000).catch(() => null)
  const closed = await Promise.race([c.closed, new Promise((r) => setTimeout(() => r(null), 3000))])
  c.close()
  return { reply, closed }
}

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const a = new Assert("53-resume-wrong-secret")
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/echo", description: "e" }] })
  const { sessionId, resumeSecret } = await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  await killWs(sessionId)
  await c.closed

  const reg = { appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/echo", description: "e" }] }
  const flipped = (resumeSecret[0] === "A" ? "B" : "A") + resumeSecret.slice(1)
  const verifier = token.split("_").slice(2).join("_")
  const cases = [
    ["wrong secret", { type: "resume", sessionId, secret: flipped, ...reg }],
    ["malformed secret", { type: "resume", sessionId, secret: "short", ...reg }],
    ["missing secret", { type: "resume", sessionId, ...reg }],
    ["agent-token verifier as secret", { type: "resume", sessionId, secret: verifier, ...reg }],
    ["full agent token as secret", { type: "resume", sessionId, secret: token, ...reg }],
  ]
  for (const [name, frame] of cases) {
    const { reply, closed } = await attempt(sessionId, frame)
    a.ok(reply && reply.ok === false && reply.error?.code === "resume_failed", `${name}: resume_failed`, { reply })
    a.equal(closed?.code, 4401, `${name}: closed 4401`)
  }
  // Right secret, wrong session-id in the frame.
  const other = await attempt(sessionId, { type: "resume", sessionId: "00000000", secret: resumeSecret, ...reg })
  a.equal(other.closed?.code, 4401, "frame naming another session: 4401")

  // Plain upgrade forced onto the held session: refused.
  const plain = openRawWs({ forceSession: sessionId })
  await plain.waitOpen()
  a.equal((await plain.closed).code, 4409, "plain upgrade on a held session → 4409")

  // Register frame on a resume socket is ignored (only `resume` is accepted).
  const regOnResume = openRawWs({ resumeSession: sessionId })
  await regOnResume.waitOpen()
  regOnResume.send({ type: "register", ...reg })
  const noReply = await regOnResume.waitFor((m) => m.type === "register_reply", 1000).catch(() => null)
  a.equal(noReply, null, "register on a resume socket gets no reply")
  regOnResume.close()

  // The session survived all of that: the right secret still resumes it.
  const good = openRawWs({ resumeSession: sessionId })
  await good.waitOpen()
  good.send({ type: "resume", sessionId, secret: resumeSecret, ...reg })
  const ok = await good.waitFor((m) => m.type === "register_reply")
  a.ok(ok.ok && ok.resumed, "right secret still resumes after the refusals", { ok })
  good.ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "tool_call") good.send({ type: "tool_reply", id: m.id, status: 200, body: {} }) })
  a.equal((await httpPost(`/v1/t/${token}/echo`, {})).status, 200, "same URL works")
  good.ws.close(1000)

  // SDK with a bad saved secret: falls back to a fresh session.
  const c3 = openRawWs()
  await c3.waitOpen()
  c3.send({ type: "register", ...reg })
  const r3 = await c3.waitFor((m) => m.type === "register_reply" && m.ok)
  await killWs(r3.sessionId)
  const s = await connect({ ...reg, tools: [], baseUrl: RELAY_HTTP, resume: { sessionId: r3.sessionId, secret: flipped } })
  a.ok(s.connected && s.sessionId !== r3.sessionId, "SDK with a bad secret lands in a fresh session", { sid: s.sessionId })
  a.ok(typeof s.resumeSecret === "string" && s.resumeSecret !== flipped, "and holds the fresh session's secret")
  s.close()
}
