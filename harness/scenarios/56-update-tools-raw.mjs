// 56-update-tools-raw — raw protocol: an `update_tools` frame replaces the
// registered tools (and agents.md when given) on a live session. The SAME
// agent URL serves the new tools.json, routes calls to the new paths and 404s
// removed ones. Invalid updates (reserved path, duplicate, bad shape, oversized
// agents.md) are answered with an error and change nothing; the session stays
// up. Before register it's refused like the other id'd frames.

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet, httpPost } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("56-update-tools-raw")

  // Before register: protocol_error on the matching reply type.
  const early = openRawWs()
  await early.waitOpen()
  early.send({ type: "update_tools", id: "e1", tools: [] })
  const er = await early.waitFor((m) => m.type === "update_tools_reply")
  a.ok(er.id === "e1" && er.ok === false && er.error?.code === "protocol_error", "update_tools before register → protocol_error", { er })
  early.close()

  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# v1", tools: [{ path: "/a", description: "tool a" }] })
  a.equal((await c.waitFor((m) => m.type === "register_reply")).ok, true, "register ok")
  c.send({ type: "mint_agent_token", id: "m1", label: "t" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply")
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === "tool_call") c.send({ type: "tool_reply", id: m.id, status: 200, body: { path: m.path } })
  })
  let n = 0
  const update = async (frame) => {
    const id = `u${++n}`
    c.send({ type: "update_tools", id, ...frame })
    return c.waitFor((m) => m.type === "update_tools_reply" && m.id === id)
  }
  const toolPaths = async () => JSON.parse((await httpGet(`/v1/t/${token}/tools.json`)).body).tools.map((t) => `${t.method} ${t.path}`)

  a.equal((await httpPost(`/v1/t/${token}/a`, {})).status, 200, "/a works before the update")

  const ok = await update({ agentsMd: "# v2", tools: [{ path: "/b", description: "tool b" }, { method: "get", path: "/c", description: "tool c", input_schema: { type: "object" } }] })
  a.equal(ok.ok, true, "update_tools ok", { ok })
  a.equal(await toolPaths(), ["POST /b", "GET /c"], "tools.json shows the new list on the same URL")
  const tj = JSON.parse((await httpGet(`/v1/t/${token}/tools.json`)).body)
  a.equal(tj.tools[1].input_schema, { type: "object" }, "input_schema kept")
  a.ok((await httpGet(`/v1/t/${token}/agents.md`)).body.includes("# v2"), "agents.md replaced")
  const b = await httpPost(`/v1/t/${token}/b`, {})
  a.ok(b.status === 200 && b.json?.path === "/b", "new tool routed to the app", { b })
  a.equal((await httpPost(`/v1/t/${token}/a`, {})).status, 404, "removed tool → 404")

  // No agentsMd: keeps the current one.
  a.equal((await update({ tools: [{ path: "/b", description: "tool b" }, { path: "/d", description: "tool d" }] })).ok, true, "update without agentsMd ok")
  a.ok((await httpGet(`/v1/t/${token}/agents.md`)).body.includes("# v2"), "agents.md kept when omitted")
  a.equal(await toolPaths(), ["POST /b", "POST /d"], "tools replaced")

  // Refused updates change nothing.
  const bad = [
    [{ tools: [{ path: "/x", description: "x" }, { path: "/agents.md", description: "shadow" }] }, "reserved_path", "reserved path"],
    [{ tools: [{ path: "/_as_tasks", description: "x" }] }, "reserved_path", "_as_ prefix"],
    [{ tools: [{ path: "no-slash", description: "x" }] }, "reserved_path", "invalid path"],
    [{ tools: [{ path: "/x", description: "x" }, { path: "/x", method: "post", description: "x" }] }, "protocol_error", "duplicate METHOD+path"],
    [{ tools: [{ path: "/x", description: 5 }] }, "protocol_error", "non-string description"],
    [{ tools: "nope" }, "protocol_error", "tools not an array"],
    [{ agentsMd: "x".repeat(64 * 1024 + 1), tools: [] }, "agents_md_too_large", "oversized agents.md"],
    [{ agentsMd: 7, tools: [] }, "agents_md_too_large", "non-string agents.md"],
  ]
  for (const [frame, code, what] of bad) {
    const r = await update(frame)
    a.ok(r.ok === false && r.error?.code === code, `${what} → ${code}`, { r })
  }
  a.equal(await toolPaths(), ["POST /b", "POST /d"], "tools unchanged after refused updates")
  a.ok((await httpGet(`/v1/t/${token}/agents.md`)).body.includes("# v2"), "agents.md unchanged after refused updates")
  a.equal((await httpPost(`/v1/t/${token}/d`, {})).status, 200, "session still serving after refused updates")

  // An empty list is a valid update.
  a.equal((await update({ tools: [] })).ok, true, "empty tool list accepted")
  a.equal(await toolPaths(), [], "tools.json empty")

  c.ws.close(1000, "done")
  await c.closed
}
