// 31-sdk-tool-roundtrip — register a tool with a real handler via SDK,
// curl it, verify the handler ran and the response made it back.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, httpPost } from "../lib/relay.mjs"
import { connect } from "@agent-socket/sdk"

export default async function () {
  const a = new Assert("31-sdk-tool-roundtrip")
  let handlerCallCount = 0

  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# sdk roundtrip",
    appDescription: "SDK e2e",
    tools: [
      {
        path: "/double",
        description: "Returns input n doubled.",
        handler: async ({ body }) => {
          handlerCallCount++
          const { n } = JSON.parse(body || "{}")
          return { n, doubled: n * 2 }
        },
      },
      {
        method: "POST",
        path: "/error",
        description: "Always 500.",
        handler: async () => {
          throw new Error("boom")
        },
      },
      {
        path: "/custom-status",
        description: "Returns explicit 418.",
        handler: async () => ({ status: 418, body: { teapot: true } }),
      },
    ],
    baseUrl: RELAY_HTTP,
    autoReconnect: false,
  })

  const link = await session.mintAgentToken({ label: "test" })
  const token = link.token

  const r = await httpPost(`/v1/t/${token}/double`, { n: 7 })
  a.equal(r.status, 200, "double → 200")
  a.equal(r.json, { n: 7, doubled: 14 }, "doubled body returned")
  a.equal(handlerCallCount, 1, "handler ran exactly once")

  const e = await httpPost(`/v1/t/${token}/error`, {})
  a.equal(e.status, 500, "error tool → 500")
  a.equal(e.json?.error?.code, "handler_error", "handler error envelope used")
  a.equal(e.json?.error?.message, "boom", "error message preserved")

  const c = await httpPost(`/v1/t/${token}/custom-status`, {})
  a.equal(c.status, 418, "explicit status honored")
  a.equal(c.json, { teapot: true }, "explicit body honored")

  session.close()
}
