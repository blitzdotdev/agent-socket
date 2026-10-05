// 42-no-ws-takeover — an agent-URL holder can't attach a WebSocket to the
// session, and a rejected extra socket doesn't disconnect the live app.
// Regression for: WS upgrade on /v1/t/<token>/… was forwarded to the DO,
// and the 4409 close of the extra socket nulled the app's socket, so the
// next upgrade was accepted as the app.

import WebSocket from "ws"
import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpPost, RELAY_WS } from "../lib/relay.mjs"

function upgradeOutcome(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }))
    ws.on("open", () => ws.on("close", (code) => resolve({ opened: true, code })))
    ws.on("error", () => resolve({ error: true }))
  })
}

export default async function () {
  const a = new Assert("42-no-ws-takeover")
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# test", tools: [{ path: "/echo", description: "echo" }] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "victim" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")

  const call = async () => {
    const replied = c.waitFor((m) => m.type === "tool_call", 5000)
      .then((m) => c.send({ type: "tool_reply", id: m.id, status: 200, body: { from: "app" } }))
    const r = await httpPost(`/v1/t/${token}/echo`, {})
    await replied
    return r
  }

  // Same session-id, junk verifier — the session-id is visible in every URL.
  const sid = token.split("_")[1]
  const junk = `as_${sid}_${"A".repeat(22)}`
  for (let i = 1; i <= 2; i++) {
    const out = await upgradeOutcome(`${RELAY_WS}/v1/t/${junk}/x`)
    a.equal(out.status, 400, `upgrade #${i} on token path rejected with 400`, out)
  }
  const real = await upgradeOutcome(`${RELAY_WS}/v1/t/${token}/x`)
  a.equal(real.status, 400, "upgrade with a valid token is rejected too", real)

  const r = await call()
  a.equal(r.status, 200, "live app still serves tool calls", { status: r.status, body: r.json })
  a.equal(r.json?.from, "app", "reply came from the real app", { body: r.json })

  c.close()
}
