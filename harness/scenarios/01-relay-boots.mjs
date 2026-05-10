// 01-relay-boots — relay process is up and responding.

import { Assert } from "../lib/assert.mjs"
import { httpGet } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("01-relay-boots")
  const r = await httpGet("/_debug/health")
  a.equal(r.status, 200, "GET /_debug/health → 200")
  a.equal(r.body, "ok", "body is 'ok'")
}
