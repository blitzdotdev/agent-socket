// 62-limits — limits in docs/protocol.md that no other scenario covers:
//   - register with agentsMd over 65,536 characters → agents_md_too_large, close 4413;
//   - a registration near the frame cap (agentsMd at exactly 65,536
//     multi-byte characters, ~3 MiB of tool schemas) is accepted, stored in
//     chunks, and comes back byte-for-byte after the object is reset;
//   - token labels are cut to 256 chars, appDescription to 1024;
//   - at most 4 sockets may wait on /v1/_ws?session=; the 5th gets 4409.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, evict, needsDebug } from "../lib/relay.mjs"

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const a = new Assert("62-limits")

  // agentsMd over the cap at register.
  {
    const c = openRawWs()
    await c.waitOpen()
    c.send({ type: "register", appId: "as_app_anon", agentsMd: "x".repeat(65_537), tools: [] })
    const r = await c.waitFor((m) => m.type === "register_reply")
    a.equal(r.error?.code, "agents_md_too_large", "65,537-char agentsMd refused")
    a.equal((await c.closed).code, 4413, "…with close 4413")
  }

  // A big registration survives a reset.
  const agentsMd = "€".repeat(65_536)  // 192 KiB of UTF-8, 128 KiB as UTF-16
  const schema = { type: "object", description: "ü".repeat(100_000) }
  const tools = Array.from({ length: 30 }, (_, i) => ({ path: `/t${i}`, description: `tool ${i}`, input_schema: schema }))
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd, appDescription: "d".repeat(2000), tools })
  const reg = await c.waitFor((m) => m.type === "register_reply")
  a.ok(reg.ok, `${(JSON.stringify(tools).length / 1048576).toFixed(1)} MiB registration accepted`, { reg })
  c.send({ type: "mint_agent_token", id: "m1", label: "L".repeat(300) })
  const mint = await c.waitFor((m) => m.id === "m1")
  a.equal(mint.label.length, 256, "label cut to 256 chars")
  const before = { md: (await httpGet(`/v1/t/${mint.token}/agents.md`)).body, tj: (await httpGet(`/v1/t/${mint.token}/tools.json`)).body }
  a.equal(JSON.parse(before.tj).app.description.length, 1024, "appDescription cut to 1024 chars")
  await evict(reg.sessionId)
  await c.closed
  const md = (await httpGet(`/v1/t/${mint.token}/agents.md`)).body
  const tj = (await httpGet(`/v1/t/${mint.token}/tools.json`)).body
  a.ok(md === before.md && md.endsWith(agentsMd), "agents.md identical after the reset")
  a.ok(tj === before.tj, "tools.json identical after the reset")

  // Pending resume sockets.
  const waiting = []
  for (let i = 0; i < 4; i++) {
    const w = openRawWs({ resumeSession: reg.sessionId })
    await w.waitOpen()
    waiting.push(w)
  }
  const fifth = openRawWs({ resumeSession: reg.sessionId })
  await fifth.waitOpen()
  const fc = await Promise.race([fifth.closed, new Promise((r) => setTimeout(() => r(null), 3000))])
  a.equal(fc?.code, 4409, "5th waiting resume socket → 4409")
  const reason = fc?.reason ?? ""
  a.ok(/too many resume attempts/.test(reason), "reason says why", { reason })
  for (const w of waiting) w.close()
  // End the session (the resume secret is in reg).
  const e = openRawWs({ resumeSession: reg.sessionId })
  await e.waitOpen()
  e.send({ type: "end", sessionId: reg.sessionId, secret: reg.resumeSecret })
  await e.waitFor((m) => m.type === "end_reply")
}
