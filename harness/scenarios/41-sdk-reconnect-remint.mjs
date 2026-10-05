// 41-sdk-reconnect-remint — SDK with autoReconnect:true survives a forced WS
// close by RESUMING: same sessionId, the SAME agent URL keeps working, no
// onSessionChanged. Only when the session is gone (kill-ws ?end=1, as if the
// grace window ran out) does it open a new session, re-mint every active
// token and emit onSessionChanged with {oldUrl → newUrl}: old URL → 503, new
// URL → 200.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, httpPost, killWs, needsDebug, sdkHeartbeat, until } from "../lib/relay.mjs"
import { connect, noBackoff } from "@agent-socket/sdk"

export default async function () {
  const skip = await needsDebug()
  if (skip) return skip
  const a = new Assert("41-sdk-reconnect-remint")

  let sessionChangeCount = 0
  let lastChangeInfo = null
  const reconnects = []

  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# reconnect test",
    tools: [{ path: "/echo", description: "echo", handler: async () => ({ ok: true }) }],
    baseUrl: RELAY_HTTP,
    autoReconnect: true,
    onDisconnect: noBackoff(),  // reconnect immediately for fast tests
    ...sdkHeartbeat(),  // stay inside the harness relay's short liveness window
    onSessionChanged: (info) => {
      sessionChangeCount++
      lastChangeInfo = info
    },
    onReconnect: (info) => reconnects.push(info),
  })

  const priorSessionId = session.sessionId
  const link = await session.mintAgentToken({ label: "alice" })
  const oldUrl = link.url
  const oldToken = link.token

  const beforeR = await httpPost(`/v1/t/${oldToken}/echo`, {})
  a.equal(beforeR.status, 200, "URL works before disconnect")

  // 1. A drop: the SDK resumes the same session.
  a.equal((await killWs(priorSessionId)).status, 200, "kill-ws returned 200")
  // Resumed = onReconnect fired AND the SDK is connected on the new socket;
  // only then must the relay route calls to it.
  await until(() => reconnects.length >= 1 && session.connected, "the resume")
  a.equal(reconnects.length, 1, "exactly one reconnect (no second drop)", { reconnects })
  a.ok(reconnects[0]?.resumed === true && reconnects[0]?.sessionId === priorSessionId, "onReconnect: resumed the same session", { reconnects })
  a.equal(session.sessionId, priorSessionId, "sessionId unchanged")
  a.equal(sessionChangeCount, 0, "onSessionChanged not fired on a resume")
  const resumedR = await httpPost(`/v1/t/${oldToken}/echo`, {})
  a.equal(resumedR.status, 200, "SAME URL works after the resume")

  // 2. The session is gone: the resume is refused, the SDK re-mints.
  a.equal((await killWs(priorSessionId, { end: true })).status, 200, "kill-ws ?end=1 returned 200")
  await until(() => sessionChangeCount > 0 && session.connected, "the fresh session")
  a.equal(sessionChangeCount, 1, "onSessionChanged fired exactly once")
  a.ok(lastChangeInfo && lastChangeInfo.priorSessionId === priorSessionId,
    "priorSessionId matches", { lastChangeInfo })
  a.ok(lastChangeInfo && lastChangeInfo.sessionId === session.sessionId && session.sessionId !== priorSessionId,
    "sessionId matches new session", { lastChangeInfo })
  a.ok(lastChangeInfo && lastChangeInfo.tokensRemapped instanceof Map,
    "tokensRemapped is a Map")
  a.ok(lastChangeInfo && lastChangeInfo.tokensRemapped.size === 1,
    "tokensRemapped has 1 entry")

  const newUrl = lastChangeInfo.tokensRemapped.get(oldUrl)
  a.ok(newUrl && newUrl.startsWith(RELAY_HTTP) && newUrl !== oldUrl,
    "new URL is different and still under same base", { oldUrl, newUrl })

  const oldR = await httpPost(`/v1/t/${oldToken}/echo`, {})
  a.equal(oldR.status, 503, "old URL → 503 (app_offline)")

  const newToken = newUrl.match(/\/v1\/t\/([^/]+)\/agents.md/)[1]
  const newR = await httpPost(`/v1/t/${newToken}/echo`, {})
  a.equal(newR.status, 200, "new URL → 200")

  // 3. close() is a clean 1000 close: the relay ends the session at once.
  session.close()
  await new Promise((r) => setTimeout(r, 300))
  const afterClose = await httpPost(`/v1/t/${newToken}/agents.md`, null)
  a.equal(afterClose.status, 503, "after close() the session is gone at once")
}
