// 41-sdk-reconnect-remint — SDK with autoReconnect:true survives a forced
// WS close, gets a new sessionId, re-mints all previously-active tokens,
// emits onSessionChanged with the {oldUrl → newUrl} map. Old URL → 503,
// new URL → 200.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, httpPost } from "../lib/relay.mjs"
import { connect, noBackoff } from "@agent-socket/sdk"

export default async function () {
  const a = new Assert("41-sdk-reconnect-remint")

  let sessionChangeCount = 0
  let lastChangeInfo = null

  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# reconnect test",
    tools: [{ path: "/echo", description: "echo", handler: async () => ({ ok: true }) }],
    baseUrl: RELAY_HTTP,
    autoReconnect: true,
    onDisconnect: noBackoff(),  // reconnect immediately for fast tests
    onSessionChanged: (info) => {
      sessionChangeCount++
      lastChangeInfo = info
    },
  })

  const priorSessionId = session.sessionId
  const link = await session.mintAgentToken({ label: "alice" })
  const oldUrl = link.url
  const oldToken = link.token

  // Verify the URL works pre-disconnect.
  const beforeR = await httpPost(`/v1/t/${oldToken}/echo`, {})
  a.equal(beforeR.status, 200, "old URL works before disconnect")

  // Force-close the WS via debug endpoint.
  const killR = await fetch(`${RELAY_HTTP}/_debug/kill-ws/${priorSessionId}`, { method: "POST" })
  a.equal(killR.status, 200, "kill-ws returned 200")

  // Wait for SDK to reconnect, remint, and fire onSessionChanged.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (sessionChangeCount > 0 && session.connected && session.sessionId !== priorSessionId) break
    await new Promise((r) => setTimeout(r, 100))
  }
  a.equal(sessionChangeCount, 1, "onSessionChanged fired exactly once")
  a.ok(lastChangeInfo && lastChangeInfo.priorSessionId === priorSessionId,
    "priorSessionId matches", { lastChangeInfo })
  a.ok(lastChangeInfo && lastChangeInfo.sessionId === session.sessionId,
    "sessionId matches new session", { lastChangeInfo })
  a.ok(lastChangeInfo && lastChangeInfo.tokensRemapped instanceof Map,
    "tokensRemapped is a Map")
  a.ok(lastChangeInfo && lastChangeInfo.tokensRemapped.size === 1,
    "tokensRemapped has 1 entry")

  const newUrl = lastChangeInfo.tokensRemapped.get(oldUrl)
  a.ok(newUrl && newUrl.startsWith(RELAY_HTTP) && newUrl !== oldUrl,
    "new URL is different and still under same base", { oldUrl, newUrl })

  // Old URL is dead.
  const oldR = await httpPost(`/v1/t/${oldToken}/echo`, {})
  a.equal(oldR.status, 503, "old URL → 503 (app_offline)")

  // New URL works.
  const newToken = newUrl.match(/\/v1\/t\/([^/]+)\/agents.md/)[1]
  const newR = await httpPost(`/v1/t/${newToken}/echo`, {})
  a.equal(newR.status, 200, "new URL → 200")

  session.close()
}
