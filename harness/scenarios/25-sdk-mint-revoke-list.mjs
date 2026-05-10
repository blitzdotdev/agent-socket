// 25-sdk-mint-revoke-list — mint via SDK, list, revoke, list again.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP } from "../lib/relay.mjs"
import { connect } from "@agent-socket/sdk"

export default async function () {
  const a = new Assert("25-sdk-mint-revoke-list")

  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# mint via sdk",
    tools: [],
    baseUrl: RELAY_HTTP,
    autoReconnect: false,
  })

  const link1 = await session.mintAgentToken({ label: "alice" })
  const link2 = await session.mintAgentToken({ label: "bob" })
  a.ok(link1.token !== link2.token, "two distinct tokens", { link1: link1.token, link2: link2.token })
  a.ok(link1.url.startsWith(RELAY_HTTP) && link1.url.includes(link1.token), "URL includes the relay base + token", { url: link1.url })

  const list = await session.listAgentTokens()
  a.equal(list.length, 2, "list returns 2 tokens")
  const labels = list.map((t) => t.label).sort()
  a.equal(labels, ["alice", "bob"], "labels round-trip")

  const r = await session.revokeAgentToken(link1.token)
  a.equal(r.ok, true, "revoke ok")

  const list2 = await session.listAgentTokens()
  a.equal(list2.length, 1, "list shows 1 after revoke")
  a.equal(list2[0].label, "bob", "bob remains")

  session.close()
}
