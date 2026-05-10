// 26-second-ws-rejected — second WS to the SAME session-id is rejected
// with WS close code 4409. Uses the DEBUG-only ?force_session= URL param
// so both clients land in the same DO.

import { Assert } from "../lib/assert.mjs"
import { openRawWs } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("26-second-ws-rejected")
  const SESSION = "Q7R5X2KM"

  const c1 = openRawWs({ forceSession: SESSION })
  await c1.waitOpen()
  c1.send({ type: "register", appId: "as_app_anon", agentsMd: "first", tools: [] })
  const r1 = await c1.waitFor((m) => m.type === "register_reply", 3000)
  a.equal(r1.ok, true, "first WS registers ok")
  a.equal(r1.sessionId, SESSION, "first WS got the forced session-id")

  // Open a second WS forced to the same session-id. Should be closed by
  // the DO with code 4409.
  const c2 = openRawWs({ forceSession: SESSION })

  // Listen for close on c2.
  let closeCode = null
  let closeReason = null
  c2.ws.on("close", (code, reasonBuf) => {
    closeCode = code
    closeReason = reasonBuf?.toString() ?? ""
  })

  await c2.waitOpen()  // upgrade succeeds; the close happens inside onConnect.
  // Wait for the close event.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (closeCode !== null) break
    await new Promise((r) => setTimeout(r, 50))
  }
  a.equal(closeCode, 4409, "second WS closed with code 4409", { closeCode, closeReason })
  a.ok(/already connected/i.test(closeReason ?? ""), "close reason mentions 'already connected'", { closeReason })

  c1.close()
}
