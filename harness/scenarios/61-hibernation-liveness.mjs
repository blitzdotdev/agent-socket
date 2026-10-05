// 61-hibernation-liveness — the relay hibernates between events, and liveness
// still works:
//   - an app that only sends the fixed heartbeat frame gets its pong from the
//     runtime (auto-response: the session object never sees the ping), and
//     those auto-responses count as signs of life: it outlives its
//     HEARTBEAT_TIMEOUT_MS window;
//   - an app that sends nothing is closed 4408 by the liveness alarm;
//   - an old-style ping (any other id) is still answered with its own id;
//   - the object hibernates while only auto-responses flow (workerd evicts an
//     idle object after ~10 s): the liveness alarm wakes it with its memory
//     reset and the socket still open, the state is reloaded from storage,
//     and a tool call goes through.
// Needs HEARTBEAT_TIMEOUT_MS between ~12 s (longer than workerd's idle time
// before hibernating, so the alarm finds a hibernated object) and 30 s
// (run.mjs boots the relay with 15000).

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost, debugState, needsDebug, heartbeatTimeoutMs } from "../lib/relay.mjs"
import { logMark, logSince } from "../lib/logs.mjs"

const HEARTBEAT_PING = '{"type":"ping","id":"as_hb"}'
const HEARTBEAT_PONG = '{"type":"pong","id":"as_hb"}'

async function registeredApp() {
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/t", description: "t" }] })
  const { sessionId } = await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === "tool_call") c.send({ type: "tool_reply", id: m.id, status: 200, body: { ok: true } })
  })
  return { c, token, sessionId }
}

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const timeoutMs = heartbeatTimeoutMs()
  if (timeoutMs < 12_000 || timeoutMs > 30_000) return { skip: `needs HEARTBEAT_TIMEOUT_MS in 12-30 s, have ${timeoutMs}` }
  const a = new Assert("61-hibernation-liveness")

  const hb = await registeredApp()
  const silent = await registeredApp()
  const silentClosed = silent.c.closed
  const pongs = []
  hb.c.ws.on("message", (d) => { if (d.toString() === HEARTBEAT_PONG) pongs.push(Date.now()) })
  const before = await debugState(hb.sessionId)

  // Heartbeat only, every second, for 1.4 timeout windows. Frequent pings
  // keep the next liveness alarm close to a full window away, which leaves
  // the object idle long enough to hibernate before it.
  const timer = setInterval(() => hb.c.ws.send(HEARTBEAT_PING), 1000)
  const mark = logMark()
  await new Promise((r) => setTimeout(r, timeoutMs * 1.4))

  const sc = await Promise.race([silentClosed, new Promise((r) => setTimeout(() => r(null), 1000))])
  a.equal(sc?.code, 4408, "silent app closed 4408 by the liveness alarm")
  a.ok(pongs.length >= timeoutMs * 1.4 / 1000 - 2, "heartbeat answered byte-for-byte", { pongs: pongs.length })
  const st = await debugState(hb.sessionId)
  a.ok(st.appConnected, "heartbeat-only app still connected past its liveness window", { st })
  a.equal(st.lastFrameAt, before.lastFrameAt, "the object never saw a heartbeat frame (auto-response)")
  a.ok(st.autoResponseAt !== null && Date.now() - st.autoResponseAt < timeoutMs, "auto-responses tracked for liveness", { st })

  const log = logSince(mark)
  a.ok(new RegExp(`loaded sessionId=${hb.sessionId} app=attached`).test(log), "woke from hibernation with the app attached", { log: log.slice(-800) })
  const r = await httpPost(`/v1/t/${hb.token}/t`, {})
  a.ok(r.status === 200 && r.json?.ok === true, "tool call after hibernation", { r })

  // Old-style ping, any id: answered by the object with the same id.
  hb.c.send({ type: "ping", id: "legacy-1" })
  const pong = await hb.c.waitFor((m) => m.type === "pong" && m.id === "legacy-1", 3000)
  a.equal(pong.id, "legacy-1", "old-style ping still answered")

  clearInterval(timer)
  hb.c.ws.close(1000)
  silent.c.close()
}
