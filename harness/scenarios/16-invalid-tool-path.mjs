// 16-invalid-tool-path — paths failing the v0 validator are rejected at register.
//   - path params (`/users/:id`)
//   - whitespace
//   - reserved prefix `_as_*`
//   - exact reserved `/agents.md` and `/tools.json`

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

async function tryRegister(badPath) {
  const c = openRawWs()
  await c.waitOpen()
  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "test",
    tools: [{ method: "POST", path: badPath, description: "x" }],
  })
  const reply = await c.waitFor((m) => m.type === "register_reply", 3000)
  c.close()
  return reply
}

export default async function () {
  const a = new Assert("16-invalid-tool-path")
  const cases = [
    { path: "/users/:id", reason: "path-params" },
    { path: "/has space", reason: "whitespace" },
    { path: "/_as_tasks/foo", reason: "reserved prefix _as_" },
    { path: "/agents.md", reason: "reserved exact /agents.md" },
    { path: "/tools.json", reason: "reserved exact /tools.json" },
    { path: "no_leading_slash", reason: "must start with /" },
  ]
  for (const { path, reason } of cases) {
    const reply = await tryRegister(path)
    a.equal(reply.ok, false, `register with ${reason} fails`)
    a.ok(reply.error?.code === "reserved_path",
      `error code is reserved_path for ${reason}`,
      { path, reply })
  }
}
