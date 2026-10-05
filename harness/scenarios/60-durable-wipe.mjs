// 60-durable-wipe — every way a session ends leaves its object's storage
// empty, with no alarm left:
//   - a clean close (1000) wipes at once;
//   - the hold running out wipes from the alarm, with no request needed;
//   - an `end` frame with the secret (on /v1/_ws?session=) wipes at once; a
//     wrong secret gets 4401 and changes nothing;
//   - SDK close() while disconnected sends that `end`;
//   - a refused resume on a session that never existed leaves nothing behind.
// Needs a short RESUME_GRACE_MS (run.mjs boots the relay with 3000).

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, killWs, debugState, needsDebug, resumeGraceMs, sdkHeartbeat, until, RELAY_HTTP } from "../lib/relay.mjs"
import { logMark, logSince } from "../lib/logs.mjs"
import { connect } from "@agent-socket/sdk"

const reg = { appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/echo", description: "e" }] }

async function registered() {
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", ...reg })
  const { sessionId, resumeSecret } = await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.id === "m1")
  return { c, sessionId, resumeSecret, token }
}

const empty = (st) => !st.session && st.storageKeys.length === 0 && st.alarm === null

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const grace = resumeGraceMs()
  if (grace > 15_000) return { skip: `RESUME_GRACE_MS=${grace} too long to test` }
  const a = new Assert("60-durable-wipe")

  // Clean close.
  {
    const { c, sessionId, token } = await registered()
    a.ok((await debugState(sessionId)).storageKeys.length > 0, "session stored")
    c.ws.close(1000, "done")
    await c.closed
    await until(async () => empty(await debugState(sessionId)), "the wipe after a 1000 close", 3000)
    a.equal((await httpGet(`/v1/t/${token}/agents.md`)).status, 503, "1000 close: link dead at once")
  }

  // Hold expiry: the alarm wipes; nothing touches the object in between.
  {
    const { c, sessionId, token } = await registered()
    await killWs(sessionId)
    await c.closed
    const held = await debugState(sessionId)
    a.ok(held.session && held.alarm === held.heldUntil && held.heldUntil - Date.now() <= grace, "held with the alarm at the deadline", { held })
    const mark = logMark()
    await new Promise((r) => setTimeout(r, grace + 1500))
    a.ok(new RegExp(`alarm: hold expired sessionId=${sessionId}`).test(logSince(mark)), "the alarm ended the session", { log: logSince(mark).slice(-600) })
    a.ok(empty(await debugState(sessionId)), "storage empty, no alarm")
    a.equal((await httpGet(`/v1/t/${token}/agents.md`)).status, 503, "link dead after the hold")
  }

  // `end` frame.
  {
    const { c, sessionId, resumeSecret, token } = await registered()
    await killWs(sessionId, { holdMs: 60_000 })
    await c.closed
    const bad = openRawWs({ resumeSession: sessionId })
    await bad.waitOpen()
    bad.send({ type: "end", sessionId, secret: "C".repeat(43) })
    const badReply = await bad.waitFor((m) => m.type === "end_reply")
    a.ok(badReply.ok === false && badReply.error?.code === "resume_failed", "end with a wrong secret refused", { badReply })
    a.equal((await bad.closed).code, 4401, "…and closed 4401")
    a.equal((await httpGet(`/v1/t/${token}/agents.md`)).status, 200, "session untouched by the bad end")

    const e = openRawWs({ resumeSession: sessionId })
    await e.waitOpen()
    e.send({ type: "end", sessionId, secret: resumeSecret })
    a.equal((await e.waitFor((m) => m.type === "end_reply")).ok, true, "end with the secret accepted")
    a.equal((await e.closed).code, 1000, "end socket closed 1000")
    a.ok(empty(await debugState(sessionId)), "end: storage empty, no alarm")
    a.equal((await httpGet(`/v1/t/${token}/agents.md`)).status, 503, "end: link dead at once")
  }

  // SDK close() while it is away.
  {
    let reconnect = null
    const s = await connect({ ...reg, tools: [], baseUrl: RELAY_HTTP, onDisconnect: (i) => { reconnect = i.reconnect }, ...sdkHeartbeat() })
    const link = await s.mintAgentToken({ label: "sdk" })
    const sessionId = s.sessionId
    await killWs(sessionId, { holdMs: 60_000 })
    await until(() => reconnect !== null, "the SDK noticing the drop")
    a.equal((await httpGet(`/v1/t/${link.token}/agents.md`)).status, 200, "held while the SDK is away")
    s.close()
    await until(async () => empty(await debugState(sessionId)), "the SDK's end", 5000)
    a.equal((await httpGet(`/v1/t/${link.token}/agents.md`)).status, 503, "SDK close() while away: link dead")
  }

  // Resume attempt on a session id nobody registered.
  {
    const ghost = "GH0ST" + "ABC"
    const r = openRawWs({ resumeSession: ghost })
    await r.waitOpen()
    r.send({ type: "resume", sessionId: ghost, secret: "D".repeat(43), ...reg })
    a.equal((await r.closed).code, 4401, "resume of an unknown session → 4401")
    await until(async () => empty(await debugState(ghost)), "the empty object to drop its storage", 3000)
  }
}
