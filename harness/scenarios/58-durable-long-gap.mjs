// 58-durable-long-gap — a session survives a gap longer than the old 60 s
// in-memory grace AND an eviction of its Durable Object in the middle of it:
// the hold lives in storage, the deadline in an alarm. After the gap,
// agents.md/tools.json still answer from rehydrated state, a revoked token
// stays revoked, a pending async task is still pollable, a tool call gets
// 503 app_offline (with how long the app has been away), a wrong secret is
// still refused, and a resume with the secret brings the SAME URL back, with
// list_agent_tokens recovering the live token from its sealed copy.
//
// The gap is LONG_GAP_MS (default 62 s); the drop holds the session for 120 s
// via the DEBUG ?hold= override (the harness relay's own grace is 3 s).

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, httpPost, killWs, evict, debugState, needsDebug, RELAY_HTTP } from "../lib/relay.mjs"
import { logMark, logSince } from "../lib/logs.mjs"

const GAP_MS = parseInt(process.env.LONG_GAP_MS ?? "62000", 10)
const reg = { appId: "as_app_anon", agentsMd: "# durable", tools: [{ path: "/echo", description: "echo" }, { path: "/slow", description: "async" }] }

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const a = new Assert("58-durable-long-gap")

  const c1 = openRawWs()
  await c1.waitOpen()
  c1.send({ type: "register", ...reg })
  const { sessionId, resumeSecret } = await c1.waitFor((m) => m.type === "register_reply" && m.ok)
  const mint = async (c, id, label) => { c.send({ type: "mint_agent_token", id, label }); return (await c.waitFor((m) => m.id === id)).token }
  const keep = await mint(c1, "m1", "keep")
  const gone = await mint(c1, "m2", "revoked")
  c1.send({ type: "revoke_agent_token", id: "r1", token: gone })
  a.equal((await c1.waitFor((m) => m.id === "r1")).ok, true, "revoked one token")
  c1.ws.on("message", (d) => {
    const m = JSON.parse(d.toString())
    if (m.type !== "tool_call") return
    if (m.path === "/slow") c1.send({ type: "tool_reply", id: m.id, status: 202, taskId: "t1" })
    else c1.send({ type: "tool_reply", id: m.id, status: 200, body: { from: "c1" } })
  })
  a.equal((await httpPost(`/v1/t/${keep}/slow`, {})).status, 202, "async task started")

  // Storage holds verifier hashes and sealed tokens, never a token or the secret.
  const st = await debugState(sessionId)
  const keys = st.storageKeys.join(" ")
  a.ok(st.storageKeys.includes("m") && st.storageKeys.some((k) => k.startsWith("r:")), "meta + registration stored", { keys })
  a.ok(st.storageKeys.filter((k) => k.startsWith("t:")).length === 1 && st.storageKeys.includes("k:t1"), "one token, one task stored", { keys })
  a.ok(!keys.includes(keep.split("_")[2]) && !keys.includes(resumeSecret), "no verifier or secret in storage keys", { keys })
  a.ok(st.alarm !== null, "liveness alarm armed while connected", { st })

  // Drop, then evict the object partway through the gap.
  a.equal((await killWs(sessionId, { holdMs: 120_000 })).status, 200, "kill-ws with a 120 s hold")
  await c1.closed
  await new Promise((r) => setTimeout(r, GAP_MS / 2))
  const mark = logMark()
  a.equal((await evict(sessionId)).status, 200, "evicted the session's object")
  await new Promise((r) => setTimeout(r, GAP_MS / 2))

  const md = await httpGet(`/v1/t/${keep}/agents.md`)
  a.ok(md.status === 200 && md.body.includes("# durable"), `agents.md served ${Math.round(GAP_MS / 1000)} s after the drop, after an eviction`, { status: md.status })
  a.ok(/\[DO\] loaded sessionId=/.test(logSince(mark)), "state was reloaded from storage", { log: logSince(mark).slice(-800) })
  const tj = JSON.parse((await httpGet(`/v1/t/${keep}/tools.json`)).body)
  a.equal(tj.tools.map((t) => t.path), ["/echo", "/slow"], "tools.json from storage")
  a.equal((await httpGet(`/v1/t/${gone}/agents.md`)).status, 401, "revoked token still 401 after the reload")
  const poll = await httpGet(`/v1/t/${keep}/_as_tasks/t1`)
  a.ok(poll.status === 202 && JSON.parse(poll.body).completed === false, "pending task still pollable", { poll })
  const r = await fetch(`${RELAY_HTTP}/v1/t/${keep}/echo`, { method: "POST", body: "{}" })
  const err = (await r.json()).error
  a.equal(r.status, 503, "tool call while away → 503")
  a.equal(r.headers.get("retry-after"), "2", "Retry-After: 2")
  a.ok(err?.code === "app_offline" && /offline for \d+ s/.test(err.message), "message says how long the app has been away", { err })
  const held = await debugState(sessionId)
  a.ok(held.session && !held.appConnected && held.heldUntil > Date.now() && held.alarm === held.heldUntil, "held, alarm at the hold deadline", { held })

  // A wrong secret is still refused; the right one resumes.
  const bad = openRawWs({ resumeSession: sessionId })
  await bad.waitOpen()
  bad.send({ type: "resume", sessionId, secret: "B".repeat(43), ...reg })
  a.equal((await bad.closed).code, 4401, "wrong secret → 4401 after the reload")

  const c2 = openRawWs({ resumeSession: sessionId })
  await c2.waitOpen()
  c2.send({ type: "resume", sessionId, secret: resumeSecret, ...reg })
  const rr = await c2.waitFor((m) => m.type === "register_reply")
  a.ok(rr.ok && rr.resumed && rr.sessionId === sessionId, "resumed the same session", { rr })
  c2.ws.on("message", (d) => {
    const m = JSON.parse(d.toString())
    if (m.type === "tool_call") c2.send({ type: "tool_reply", id: m.id, status: 200, body: { from: "c2" } })
  })
  const after = await httpPost(`/v1/t/${keep}/echo`, {})
  a.ok(after.status === 200 && after.json?.from === "c2", "SAME URL works after the long gap", { after })
  c2.send({ type: "list_agent_tokens", id: "l1" })
  const list = await c2.waitFor((m) => m.id === "l1")
  a.equal(list.tokens.map((t) => [t.token, t.label]), [[keep, "keep"]], "list recovers the live token (and only it)")
  c2.send({ type: "task_complete", taskId: "t1", status: 200, body: { done: true } })
  await new Promise((r) => setTimeout(r, 100))
  const done = await httpGet(`/v1/t/${keep}/_as_tasks/t1`)
  a.ok(done.status === 200 && JSON.parse(done.body).done === true, "task completed after the resume", { done })
  a.equal((await httpGet(`/v1/t/${gone}/agents.md`)).status, 401, "revoked token still 401 after the resume")

  c2.ws.close(1000, "done")
  await c2.closed
}
