// 03-bad-token-format — well-formed prefix but wrong session-id length → 404.

import { Assert } from "../lib/assert.mjs"
import { httpGet } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("03-bad-token-format")
  // Prefix matches "as_" but session-id is too short
  const r = await httpGet("/v1/t/as_AB_CDEFGHIJKLMNOPQRSTUVWX/agents.md")
  a.equal(r.status, 404, "malformed token → 404")
  let body
  try { body = JSON.parse(r.body) } catch {}
  a.ok(body?.error?.code === "not_found", "code is not_found", { body })
}
