// 45-body-cap — agent request bodies over 1 MiB get 413 at the worker, before
// any DO buffers them; a junk verifier with a body doesn't reset the session.
// Regression for: the DO drained the whole (uncapped) body before the token
// check, so anyone who knew a session-id could push huge bodies into it.

import net from "node:net"
import { Assert } from "../lib/assert.mjs"
import { openRawWs, RELAY_HTTP } from "../lib/relay.mjs"

// Send headers promising a 100 MB body plus `sent` bytes of it, then wait for the
// status line. Raw socket because fetch() holds the response until the request
// body is fully sent.
function endlessPost(path, sent = 1) {
  const u = new URL(RELAY_HTTP)
  return new Promise((resolve) => {
    const s = net.connect(Number(u.port || 80), u.hostname, () => {
      s.write(`POST ${path} HTTP/1.1\r\nHost: ${u.host}\r\nContent-Length: 100000000\r\n\r\n${"x".repeat(sent)}`)
    })
    const done = (status) => { clearTimeout(timer); s.destroy(); resolve(status) }
    const timer = setTimeout(() => done(0), 3000)
    s.on("data", (d) => done(Number(d.toString().split(" ")[1])))
    s.on("error", () => done(0))
  })
}

async function post(path, body) {
  const r = await fetch(`${RELAY_HTTP}${path}`, { method: "POST", body, signal: AbortSignal.timeout(5000) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json }
}

export default async function () {
  const a = new Assert("45-body-cap")
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [{ path: "/t", description: "t" }] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const { token } = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  let calls = 0
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString())
    if (m.type === "tool_call") { calls++; c.send({ type: "tool_reply", id: m.id, status: 200, body: { n: m.body.length } }) }
  })

  const junk = `as_${token.split("_")[1]}_${"A".repeat(22)}`
  const big = "x".repeat(1024 * 1024 + 1)
  const r1 = await post(`/v1/t/${junk}/t`, big)
  a.equal(r1.status, 413, "junk verifier + body over 1 MiB → 413")
  a.equal(r1.json?.error?.code, "body_too_large", "code is body_too_large")

  const r2 = await post(`/v1/t/${token}/t`, big)
  a.equal(r2.status, 413, "valid token + body over 1 MiB → 413")

  a.equal(await endlessPost(`/v1/t/${token}/t`, 1.5 * 1024 * 1024), 413, "unfinished body past the cap → prompt 413")

  for (let i = 0; i < 3; i++) {
    const r = await post(`/v1/t/${junk}/t`, "x".repeat(100_000))
    a.equal(r.status, 401, `junk verifier + small body #${i + 1} → 401`)
  }

  const r4 = await post(`/v1/t/${token}/t`, "x".repeat(1024 * 1024))
  a.equal(r4.status, 200, "body of exactly 1 MiB still forwarded; session survived")
  a.equal(r4.json?.n, 1024 * 1024, "app saw the whole body")
  a.equal(calls, 1, "only the in-cap call reached the app")

  c.close()
}
