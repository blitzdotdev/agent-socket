// 49-ws-frame-cap — app frames over 4 MiB close the socket with 1009 before
// the relay parses them; frames under the cap are handled normally.
// Regression for: the only cap was workerd's 32 MiB, so an app could make
// the DO parse 32 MiB JSON frames in an isolate other sessions share.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

async function sendPadded(mib) {
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd: "# t", tools: [] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  const closed = new Promise((resolve) => c.ws.on("close", (code) => resolve(code)))
  c.ws.send(JSON.stringify({ type: "ping", id: "p", pad: "x".repeat(mib * 1024 * 1024) }))
  const out = await Promise.race([c.waitFor((m) => m.type === "pong", 5000).then(() => "pong"), closed])
  c.close()
  return out
}

export default async function () {
  const a = new Assert("49-ws-frame-cap")
  a.equal(await sendPadded(3), "pong", "3 MiB frame handled")
  a.equal(await sendPadded(5), 1009, "5 MiB frame closes the socket with 1009")
}
