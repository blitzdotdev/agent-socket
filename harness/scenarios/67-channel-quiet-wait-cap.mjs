// 67-channel-quiet-wait-cap — when no message has been posted recently AND
// no peer is waiting, the server honors a higher `wait` cap (quietCapMs).
// When the channel is active, the lower cap (waitCapMs) applies.

import { Assert } from "../lib/assert.mjs"
import { httpPost } from "../lib/relay.mjs"
import { startChannelHost } from "../lib/channel.mjs"

export default async function () {
  const a = new Assert("67-channel-quiet-wait-cap")

  // Active cap 500ms, quiet cap 2000ms, quiet threshold 200ms after last activity.
  const ch = await startChannelHost({
    waitCapMs: 500,
    quietCapMs: 2000,
    quietThresholdMs: 200,
  })
  try {
    const tb = ch.tokenBase.replace(/^https?:\/\/[^/]+/, "")

    // (a) Active state: someone just sent → active cap (500ms) applies.
    await httpPost(`${tb}/send`, { name: "alice", text: "ping" })
    const t0 = Date.now()
    await httpPost(`${tb}/recv`, { name: "bob", since: 999, wait: 3 })  // ask for 3s
    const activeElapsed = Date.now() - t0
    a.ok(activeElapsed < 1000, `active state caps at ~500ms (got ${activeElapsed}ms)`, { activeElapsed })

    // Sleep past the quiet threshold so the channel goes quiet.
    await sleep(300)

    // (b) Quiet state: no recent activity, no waiter → quiet cap (2000ms) applies.
    const t1 = Date.now()
    await httpPost(`${tb}/recv`, { name: "bob", since: 999, wait: 3 })
    const quietElapsed = Date.now() - t1
    a.ok(quietElapsed > 1500 && quietElapsed < 2500,
        `quiet state honors quietCapMs ~2000ms (got ${quietElapsed}ms)`, { quietElapsed })
  } finally {
    ch.stop()
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
