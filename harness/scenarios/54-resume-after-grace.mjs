// 54-resume-after-grace — once RESUME_GRACE_MS passes without a resume the
// session ends like before resume existed: the agent URL → 503 app_offline,
// a resume → 4401, and the SDK falls back to a fresh session and re-mints.
// Needs a short grace (run.mjs boots the relay with 3000); SKIPs otherwise.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, httpPost, killWs, resumeGraceMs, RELAY_HTTP } from "../lib/relay.mjs"
import { connect, noBackoff } from "@agent-socket/sdk"

export default async function () {
  const grace = resumeGraceMs()
  if (grace > 15_000) return { skip: `RESUME_GRACE_MS=${grace} too long to test` }
  const a = new Assert("54-resume-after-grace")

  const reg = { appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/echo", description: "e" }] }
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", ...reg })
  const { sessionId, resumeSecret } = await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  await killWs(sessionId)
  await c.closed
  await new Promise((r) => setTimeout(r, grace + 1000))

  const md = await httpGet(`/v1/t/${token}/agents.md`)
  a.equal(md.status, 503, "after the grace window agents.md → 503")
  a.equal(JSON.parse(md.body)?.error?.code, "app_offline", "code is app_offline")
  const late = openRawWs({ resumeSession: sessionId })
  await late.waitOpen()
  late.send({ type: "resume", sessionId, secret: resumeSecret, ...reg })
  const reply = await late.waitFor((m) => m.type === "register_reply")
  a.equal(reply.error?.code, "resume_failed", "late resume → resume_failed")
  a.equal((await late.closed).code, 4401, "late resume closed 4401")

  // SDK: drop, wait out the grace with reconnects held back, then reconnect.
  let release
  const gate = new Promise((r) => { release = r })
  const changes = []
  const s = await connect({
    ...reg,
    tools: [{ path: "/echo", description: "e", handler: () => ({ ok: true }) }],
    baseUrl: RELAY_HTTP,
    onDisconnect: async (info) => { await gate; noBackoff()(info) },
    onSessionChanged: (i) => changes.push(i),
  })
  const link = await s.mintAgentToken({ label: "sdk" })
  const prior = s.sessionId
  await killWs(prior)
  await new Promise((r) => setTimeout(r, grace + 1000))
  release()
  for (let i = 0; i < 50 && changes.length === 0; i++) await new Promise((r) => setTimeout(r, 100))
  a.equal(changes.length, 1, "onSessionChanged fired once")
  a.ok(changes[0].priorSessionId === prior && changes[0].sessionId === s.sessionId && s.sessionId !== prior,
    "fresh session after the grace window", { info: changes[0] })
  const fresh = changes[0].tokensRemapped.get(link.url)
  a.ok(fresh && fresh !== link.url, "token re-minted", { fresh })
  const freshToken = fresh.match(/\/v1\/t\/([^/]+)\//)[1]
  a.equal((await httpPost(`/v1/t/${freshToken}/echo`, {})).status, 200, "new URL works")
  a.equal((await httpPost(`/v1/t/${link.token}/echo`, {})).status, 503, "old URL → 503")
  s.close()
}
