// 28-tool-timeout — tool handler that never replies hits MAX_SYNC_TOOL_MS,
// agent gets 504 tool_timeout. Pending entry is cleared so subsequent calls work.
//
// Reads MAX_SYNC_TOOL_MS from relay/.dev.vars to compute the expected window
// so the test works regardless of whether dev is configured for fast tests
// (e.g. 3000) or production-like (e.g. 30000).

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"
import fs from "node:fs"
import path from "node:path"
import url from "node:url"

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const DEV_VARS = path.join(__dirname, "..", "..", "relay", ".dev.vars")

function expectedTimeoutMs() {
  try {
    const text = fs.readFileSync(DEV_VARS, "utf8")
    const m = text.match(/^MAX_SYNC_TOOL_MS\s*=\s*(\d+)/m)
    if (m) return parseInt(m[1], 10)
  } catch {}
  return 30_000  // production default in wrangler.toml
}

export default async function () {
  const a = new Assert("28-tool-timeout")
  const expectedMs = expectedTimeoutMs()
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "timeout test",
    tools: [
      { method: "POST", path: "/stall", description: "never replies" },
      { method: "POST", path: "/echo", description: "echoes" },
    ],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  // Fire stall — fake app receives tool_call but doesn't reply.
  const startedAt = Date.now()
  const r = await httpPost(`/v1/t/${token}/stall`, {})
  const elapsed = Date.now() - startedAt

  a.equal(r.status, 504, "stalled call → 504")
  a.equal(r.json?.error?.code, "tool_timeout", "code is tool_timeout")
  const lo = Math.floor(expectedMs * 0.8)
  const hi = Math.ceil(expectedMs * 2)
  a.ok(elapsed >= lo && elapsed < hi,
    `timeout fired around MAX_SYNC_TOOL_MS=${expectedMs} (elapsed: ${elapsed}ms, expected ${lo}..${hi})`,
    { elapsed, expectedMs })

  // Pending should be drained — a fresh call works.
  const echoPromise = (async () => {
    const call = await c.waitFor((m) => m.type === "tool_call" && m.path === "/echo", 5000)
    c.send({ type: "tool_reply", id: call.id, status: 200, body: { ok: true } })
  })()
  const r2 = await httpPost(`/v1/t/${token}/echo`, { x: 1 })
  await echoPromise
  a.equal(r2.status, 200, "fresh call after timeout works")

  c.close()
}
