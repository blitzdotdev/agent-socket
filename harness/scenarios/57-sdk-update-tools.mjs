// 57-sdk-update-tools — session.updateTools() against the real relay: the
// SAME agent URL serves the new tools and agents.md and calls the new
// handlers; after a forced drop the SDK's resume re-sends the updated set (not
// the one passed to connect()); a refused update rejects with the relay's code
// and leaves the live tools alone.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, httpGet, httpPost, killWs, needsDebug } from "../lib/relay.mjs"
import { connect, noBackoff } from "@agent-socket/sdk"

const until = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 100)) }

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const a = new Assert("57-sdk-update-tools")
  const reconnects = []
  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# before",
    tools: [{ path: "/a", description: "a", handler: () => ({ from: "a" }) }],
    baseUrl: RELAY_HTTP,
    onDisconnect: noBackoff(),
    onReconnect: (i) => reconnects.push(i),
  })
  try {
    const { token } = await session.mintAgentToken({ label: "t" })
    const paths = async () => JSON.parse((await httpGet(`/v1/t/${token}/tools.json`)).body).tools.map((t) => t.path)

    await session.updateTools([
      { path: "/b", description: "b", handler: () => ({ from: "b" }) },
      { path: "/c", description: "c", handler: () => ({ from: "c" }) },
    ], "# after")
    a.equal(await paths(), ["/b", "/c"], "tools.json updated on the same URL")
    a.ok((await httpGet(`/v1/t/${token}/agents.md`)).body.includes("# after"), "agents.md updated")
    const b = await httpPost(`/v1/t/${token}/b`, {})
    a.ok(b.status === 200 && b.json?.from === "b", "new handler answers", { b })
    a.equal((await httpPost(`/v1/t/${token}/a`, {})).status, 404, "old tool gone")

    // A drop: the resume carries the updated set.
    a.equal((await killWs(session.sessionId)).status, 200, "kill-ws")
    await until(() => reconnects.length === 1 && session.connected)
    a.equal(reconnects[0]?.resumed, true, "resumed")
    a.equal(await paths(), ["/b", "/c"], "resume re-sent the updated tools")
    a.ok((await httpGet(`/v1/t/${token}/agents.md`)).body.includes("# after"), "resume re-sent the updated agents.md")
    a.equal((await httpPost(`/v1/t/${token}/c`, {})).json?.from, "c", "handler works after the resume")

    // Refused: duplicate path.
    let err = null
    try {
      await session.updateTools([
        { path: "/z", description: "z", handler: () => 1 },
        { path: "/z", description: "z again", handler: () => 2 },
      ])
    } catch (e) { err = e }
    a.equal(err?.code, "protocol_error", "duplicate path rejected with the relay's code", { err: err?.message })
    a.equal(await paths(), ["/b", "/c"], "live tools unchanged after the refused update")
    a.equal((await httpPost(`/v1/t/${token}/b`, {})).status, 200, "still serving")
  } finally {
    session.close()
  }
}
