// 40-tool-content-type — relay honors handler-supplied content-type on
// tool_reply (and on task_complete → /_as_tasks/<id>). Without this, every
// response was forced to application/json (the channel host's /join.sh had
// to wrap its bash script as `{ "script": "..." }` and the friend's
// one-liner had to pipe through `jq -r .script`).
//
// Behavioral contract (v0):
//  - handler returns { status, body: <string>, headers: { "content-type": X } }
//    → relay serves the string verbatim with Content-Type: X
//  - handler returns { status, body, headers: { "Content-Type": X } } (any case)
//    → same — case-insensitive lookup
//  - handler returns { status, body: <object>, headers: {...} }
//    → falls back to JSON.stringify with application/json (string-body only in v0)
//  - handler returns the legacy `{ status, body: <object> }` (no headers)
//    → unchanged: JSON.stringify with application/json
//
// Covers /agents.md + /tools.json being unaffected (they're served by the
// relay directly, not via tool calls).

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, openRawWs, httpGet } from "../lib/relay.mjs"
import { connect } from "@agent-socket/sdk"

export default async function () {
  const a = new Assert("40-tool-content-type")

  const session = await connect({
    appId: "as_app_anon",
    agentsMd: "# content-type test\n\nSee tools.json.",
    appDescription: "Verifies handler-supplied content-type on tool replies.",
    tools: [
      {
        method: "GET",
        path: "/page.html",
        description: "Returns HTML.",
        handler: async () => ({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<h1>hi</h1>",
        }),
      },
      {
        method: "GET",
        path: "/plain.txt",
        description: "Plain text — case-insensitive Content-Type header.",
        handler: async () => ({
          status: 200,
          headers: { "Content-Type": "text/plain" },
          body: "hello, world\n",
        }),
      },
      {
        method: "GET",
        path: "/legacy",
        description: "Legacy: no headers, object body → JSON-stringified.",
        handler: async () => ({ status: 200, body: { ok: true, count: 7 } }),
      },
      {
        method: "GET",
        path: "/object-with-ct",
        description: "Declares text/html but returns an object — falls back to JSON.",
        handler: async () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: { not_a_string: true },
        }),
      },
      {
        method: "POST",
        path: "/echo_status",
        description: "Returns a string with the supplied status + a custom content-type.",
        handler: async ({ body }) => {
          const { status } = JSON.parse(body || "{}")
          return {
            status: status ?? 200,
            headers: { "content-type": "text/markdown" },
            body: `# echoed at status ${status}\n`,
          }
        },
      },
    ],
    baseUrl: RELAY_HTTP,
    autoReconnect: false,
  })

  const link = await session.mintAgentToken({ label: "ct-test" })
  const tokenBase = `/v1/t/${link.token}`

  // ── A) text/html passthrough ─────────────────────────────────────────
  const rA = await httpGet(`${tokenBase}/page.html`)
  a.equal(rA.status, 200, "html: status 200")
  a.ok((rA.headers.get("content-type") ?? "").startsWith("text/html"), `html: content-type is text/html (got ${rA.headers.get("content-type")})`)
  a.equal(rA.body, "<h1>hi</h1>", "html: body verbatim, NOT JSON-stringified")

  // ── B) text/plain passthrough, case-insensitive header lookup ────────
  const rB = await httpGet(`${tokenBase}/plain.txt`)
  a.equal(rB.status, 200, "plain: status 200")
  a.equal(rB.headers.get("content-type"), "text/plain", "plain: content-type passed through")
  a.equal(rB.body, "hello, world\n", "plain: body verbatim")

  // ── C) legacy (no headers, object body) → JSON, unchanged ───────────
  const rC = await httpGet(`${tokenBase}/legacy`)
  a.equal(rC.status, 200, "legacy: status 200")
  a.equal(rC.headers.get("content-type"), "application/json; charset=utf-8", "legacy: defaults to JSON")
  let cBody
  try { cBody = JSON.parse(rC.body) } catch (e) { a.fail(`legacy: not valid JSON: ${e.message}`) }
  a.equal(cBody, { ok: true, count: 7 }, "legacy: body parsed as JSON object")

  // ── D) content-type declared but object body → fall back to JSON ────
  const rD = await httpGet(`${tokenBase}/object-with-ct`)
  a.equal(rD.status, 200, "object-with-ct: status 200")
  a.equal(rD.headers.get("content-type"), "application/json; charset=utf-8", "object-with-ct: non-string body falls back to JSON (v0 only forwards string bodies)")
  let dBody
  try { dBody = JSON.parse(rD.body) } catch {}
  a.equal(dBody, { not_a_string: true }, "object-with-ct: body still JSON-encoded")

  // ── E) custom status + content-type ──────────────────────────────────
  const rE = await fetch(`${RELAY_HTTP}${tokenBase}/echo_status`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 418 }),
  })
  const rEText = await rE.text()
  a.equal(rE.status, 418, "echo_status: status preserved")
  a.equal(rE.headers.get("content-type"), "text/markdown", "echo_status: content-type honored")
  a.equal(rEText, "# echoed at status 418\n", "echo_status: body verbatim")

  // ── F) meta paths unaffected ─────────────────────────────────────────
  const rF1 = await httpGet(`${tokenBase}/agents.md`)
  a.equal(rF1.headers.get("content-type"), "text/markdown; charset=utf-8", "agents.md still markdown")
  const rF2 = await httpGet(`${tokenBase}/tools.json`)
  a.equal(rF2.headers.get("content-type"), "application/json; charset=utf-8", "tools.json still JSON")

  session.close()
}
