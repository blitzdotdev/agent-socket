// 21-sdk-connect — connect via the SDK; session.sessionId is set, connected:true.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP } from "../lib/relay.mjs"
import { connect } from "@agent-socket/sdk"

export default async function () {
  const a = new Assert("21-sdk-connect")

  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# sdk test",
    appDescription: "SDK connect smoke",
    tools: [],
    baseUrl: RELAY_HTTP,
    autoReconnect: false,  // disable for cleaner test teardown
  })

  a.ok(typeof session.sessionId === "string", "sessionId is a string", { sessionId: session.sessionId })
  a.ok(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(session.sessionId), "sessionId is 8-char Crockford base32", { sessionId: session.sessionId })
  a.equal(session.connected, true, "session.connected === true")

  session.close()
}
