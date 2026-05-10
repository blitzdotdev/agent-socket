// 30-origin-denied — registered app with strict allowedOrigins rejects WS
// handshake from a non-allowed Origin. Bonus: same app accepts allowed origin.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("30-origin-denied")

  // Bad origin → register_reply { ok:false, error.code:"origin_denied" }
  const cBad = openRawWs({ origin: "https://evil.example" })
  await cBad.waitOpen()
  cBad.send({
    type: "register",
    appId: "as_app_test_strict",
    agentsMd: "test",
    tools: [],
  })
  const replyBad = await cBad.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(replyBad.ok, false, "bad origin rejected")
  a.equal(replyBad.error?.code, "origin_denied", "code is origin_denied")
  cBad.close()

  // Allowed origin → register_reply { ok:true }
  const cGood = openRawWs({ origin: "https://allowed.example" })
  await cGood.waitOpen()
  cGood.send({
    type: "register",
    appId: "as_app_test_strict",
    agentsMd: "test",
    tools: [],
  })
  const replyGood = await cGood.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(replyGood.ok, true, "allowed origin succeeds")
  cGood.close()

  // Non-browser (no Origin header) against strict app → rejected too
  const cNoOrigin = openRawWs()
  await cNoOrigin.waitOpen()
  cNoOrigin.send({
    type: "register",
    appId: "as_app_test_strict",
    agentsMd: "test",
    tools: [],
  })
  const replyNoOrigin = await cNoOrigin.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(replyNoOrigin.ok, false, "absent Origin against strict app rejected")
  a.equal(replyNoOrigin.error?.code, "origin_denied", "code is origin_denied")
  cNoOrigin.close()
}
