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
  // Keep the registered app inside the relay's liveness window.
  const pinger = setInterval(() => app.send({ type: "ping", id: "p" }), 2000)

  // The relay sends the close at the deadline. The client's close event comes
  // once the TCP connection ends: for a hibernatable socket that never sent a
  // frame, workerd finishes that only when the session object next goes idle,
  // up to ~10 s later. So check the close frame's arrival (the client enters
  // CLOSING) against the deadline, and the code once the close completes.
  let frameAt = null
  for (const end = Date.now() + 13_000; frameAt === null && Date.now() < end;) {
    if (idle.ws.readyState >= 2) frameAt = Date.now()
    else await new Promise((resolve) => setTimeout(resolve, 50))
  }
  a.ok(frameAt !== null, "unregistered socket sent its close within 13 s")
  a.ok(frameAt - t0 >= 9_000, "not closed before the 10 s deadline", { ms: frameAt - t0 })
  const r = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))])
  a.ok(r !== null, "close completed")
  a.equal(r.code, 4408, "close code 4408")

  app.send({ type: "mint_agent_token", id: "m1", label: "x" })
  const mint = await app.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  a.equal(mint.ok, true, "registered socket still live past the deadline")
  clearInterval(pinger)
  app.close()
}
