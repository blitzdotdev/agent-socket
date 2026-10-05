// Same app as index.html, in Node 22+. Run: npm i @agent-socket/sdk && node node.mjs
import { connect } from "@agent-socket/sdk"

let count = 0
const session = await connect({
  baseUrl: process.env.AGENT_SOCKET_URL ?? "https://agentsocket.dev",
  appId: "minimal-example",
  agentsMd: "# Counter\nA process with one counter. Call /increment to add to it.",
  tools: [{
    path: "/increment",
    description: "Add `by` (default 1) to the counter. Returns the new count.",
    input_schema: { type: "object", properties: { by: { type: "integer" } } },
    handler: ({ body }) => ({ count: (count += JSON.parse(body || "{}").by ?? 1) }),
  }],
})
const link = await session.mintAgentToken({ label: "minimal" })
console.log(`Paste this into your AI chat: ${link.url}`)
