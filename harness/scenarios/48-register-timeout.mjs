// 48-register-timeout — a socket that hasn't registered within 10 s is closed
// (4408); a registered one on another session is unaffected.
// Regression for: an upgrade that never registered pinned its (non-
// hibernating) session DO for as long as the client held the socket.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("48-register-timeout")
  const idle = openRawWs()
  const app = openRawWs()
  await Promise.all([idle.waitOpen(), app.waitOpen()])
  const closed = new Promise((resolve) => idle.ws.on("close", (code) => resolve({ code, at: Date.now() })))
  const t0 = Date.now()
  app.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [] })
  await app.waitFor((m) => m.type === "register_reply" && m.ok)

  const r = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 13_000))])
  a.ok(r !== null, "unregistered socket closed within 13 s")
  a.equal(r.code, 4408, "close code 4408")
  a.ok(r.at - t0 >= 9_000, "not closed before the 10 s deadline", { ms: r.at - t0 })

  app.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const mint = await app.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  a.equal(mint.ok, true, "registered socket still live past the deadline")
  app.close()
}
