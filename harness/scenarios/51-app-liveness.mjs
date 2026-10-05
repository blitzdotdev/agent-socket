// 51-app-liveness — an app socket silent for longer than HEARTBEAT_TIMEOUT_MS
// is treated as dead: the relay closes it (4408) and agents get app_offline
// right away. An app that keeps pinging is unaffected.
// Regression for: HEARTBEAT_* were never read, so a half-open app socket kept
// the session "live" and every agent call waited out the tool timeout.
//
// Needs a short timeout (run.mjs boots the relay with 6000); SKIPs otherwise.

import fs from "node:fs"
import path from "node:path"
import url from "node:url"
import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost } from "../lib/relay.mjs"

const DEV_VARS = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "relay", ".dev.vars")

function heartbeatTimeoutMs() {
  if (process.env.HEARTBEAT_TIMEOUT_MS) return parseInt(process.env.HEARTBEAT_TIMEOUT_MS, 10)
  try {
    const m = fs.readFileSync(DEV_VARS, "utf8").match(/^HEARTBEAT_TIMEOUT_MS\s*=\s*(\d+)/m)
    if (m) return parseInt(m[1], 10)
  } catch {}
  return 50_000
}

async function registeredApp() {
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/t", description: "t" }] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === "tool_call") c.send({ type: "tool_reply", id: m.id, status: 200, body: {} })
  })
  return { c, token }
}

export default async function () {
  const timeoutMs = heartbeatTimeoutMs()
  if (timeoutMs > 15_000) return { skip: `HEARTBEAT_TIMEOUT_MS=${timeoutMs} too long to test` }
  const a = new Assert("51-app-liveness")

  const silent = await registeredApp()
  const pinger = await registeredApp()
  const closed = new Promise((resolve) => silent.c.ws.on("close", (code) => resolve(code)))
  let n = 0
  const timer = setInterval(() => pinger.c.send({ type: "ping", id: `p${n++}` }), timeoutMs / 3)

  await new Promise((r) => setTimeout(r, timeoutMs + 1500))
  clearInterval(timer)

  const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r(null), 1000))])
  a.equal(code, 4408, "silent app's socket closed by the relay with 4408")
  // The silent app still answers tool calls if one reaches it, so a 200 here
  // would mean the relay still routed to it.
  const t0 = Date.now()
  const r = await httpPost(`/v1/t/${silent.token}/t`, {})
  a.equal(r.status, 503, "agent call to the silent session → 503")
  a.equal(r.json?.error?.code, "app_offline", "code is app_offline")
  a.ok(Date.now() - t0 < 1000, "answered promptly, not after the tool timeout", { ms: Date.now() - t0 })

  const r2 = await httpPost(`/v1/t/${pinger.token}/t`, {})
  a.equal(r2.status, 200, "pinging app still serves calls")

  silent.c.close()
  pinger.c.close()
}
