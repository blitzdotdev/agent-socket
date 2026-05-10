// 02-bad-url-404 — random unknown path returns 404 with the standard error envelope.

import { Assert } from "../lib/assert.mjs"
import { httpGet } from "../lib/relay.mjs"

export default async function () {
  const a = new Assert("02-bad-url-404")
  const r = await httpGet("/v1/t/garbage/agents.md")
  a.equal(r.status, 404, "garbage URL → 404")
  let body
  try { body = JSON.parse(r.body) } catch { /* ignore */ }
  a.ok(body?.error?.code === "not_found", "body is { error: { code: 'not_found', ... } }", { body })
}
