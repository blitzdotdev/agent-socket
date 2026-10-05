// 90-ws-rate-limit — a burst of /v1/_ws upgrades from one IP is cut off with
// 429 rate_limited (limit: 60 per 10 s), and upgrades work again once the
// window passes. Numbered last so the burst can't starve other scenarios.
// Regression for: unlimited unauthenticated upgrades, each spawning a DO.

import WebSocket from "ws"
import { Assert } from "../lib/assert.mjs"
import { RELAY_WS } from "../lib/relay.mjs"

function upgrade() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${RELAY_WS}/v1/_ws`)
    ws.on("unexpected-response", (_req, res) => {
      let body = ""
      res.on("data", (d) => { body += d })
      res.on("end", () => resolve({ status: res.statusCode, body }))
    })
    ws.on("open", () => { ws.close(); resolve({ status: 101 }) })
    ws.on("error", () => resolve({ status: 0 }))
  })
}

export default async function () {
  const a = new Assert("90-ws-rate-limit")
  const results = await Promise.all(Array.from({ length: 80 }, upgrade))
  const limited = results.filter((r) => r.status === 429)
  a.ok(limited.length > 0, "burst of 80 upgrades hits 429", { statuses: results.map((r) => r.status) })
  a.ok(JSON.parse(limited[0].body).error.code === "rate_limited", "code is rate_limited", { body: limited[0].body })

  const deadline = Date.now() + 15_000
  let ok = false
  while (!ok && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    ok = (await upgrade()).status === 101
  }
  a.ok(ok, "upgrades accepted again after the window")
}
