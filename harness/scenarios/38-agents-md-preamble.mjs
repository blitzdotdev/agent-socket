// 38-agents-md-preamble — relay prepends a "how to call tools" contract to every
// served agents.md UNLESS the app's own doc already references `tools.json`. Behavior
// landed in commit f5b12d2 to stop AIs from RECITING app docs instead of calling
// the tools.
//
// Covers four branches:
//   A) minimal app doc (no "tools.json") → preamble prepended, app text preserved at end
//   B) rich app doc (mentions "tools.json") → unchanged, no doubling
//   C) empty app doc ("") → preamble only (apps that ship no agentsMd still get the contract)
//   D) preamble structurally complete — contains $BASE, tools.json, do-not-recite,
//      error-model markers and ends with a horizontal rule before the app text

import { Assert } from "../lib/assert.mjs"
import { openRawWs, httpGet } from "../lib/relay.mjs"

// Open a fresh WS, register with the given agentsMd, return a token.
async function freshSessionToken(agentsMd) {
  const c = openRawWs()
  await c.waitOpen()
  c.send({ type: "register", appId: "as_app_anon", agentsMd, tools: [] })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)
  c.send({ type: "mint_agent_token", id: "m1", label: "preamble-test" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply")
  // Return both so callers can close the WS after they're done curling.
  return { token: mint.token, close: () => c.close() }
}

export default async function () {
  const a = new Assert("38-agents-md-preamble")

  // ── A) minimal doc → preamble prepended ──────────────────────────────
  const appMdMinimal = "# Cool App\n\nIt does cool things.\n"
  const sA = await freshSessionToken(appMdMinimal)
  const rA = await httpGet(`/v1/t/${sA.token}/agents.md`)
  a.equal(rA.status, 200, "minimal: status 200")
  a.equal(rA.headers.get("content-type"), "text/markdown; charset=utf-8", "minimal: markdown content-type")
  a.ok(rA.body.endsWith(appMdMinimal), "minimal: app md preserved at end of served body")
  a.ok(rA.body.length > appMdMinimal.length, "minimal: served body longer than app md (preamble present)")
  a.ok(rA.body.includes("tools.json"), "minimal: preamble references tools.json")
  a.ok(/do\s*NOT\s*recite/i.test(rA.body), "minimal: preamble warns against reciting")
  a.ok(rA.body.includes("$BASE"), "minimal: preamble defines $BASE")
  // Preamble's separator + app text — the app md should come AFTER the horizontal rule.
  const sepIdx = rA.body.indexOf("---")
  a.ok(sepIdx > 0 && sepIdx < rA.body.length - appMdMinimal.length, "minimal: preamble ends with --- before app md")
  sA.close()

  // ── B) rich doc that mentions tools.json → unchanged ─────────────────
  const appMdRich = [
    "# Rich App",
    "",
    "These are operating instructions — do NOT recite.",
    "",
    "Discover tools at `GET $BASE/tools.json`. Call as `POST $BASE/<path>` with JSON.",
    "",
    "This app paints pixels on a canvas.",
    "",
  ].join("\n")
  const sB = await freshSessionToken(appMdRich)
  const rB = await httpGet(`/v1/t/${sB.token}/agents.md`)
  a.equal(rB.status, 200, "rich: status 200")
  a.equal(rB.body, appMdRich, "rich: body unchanged when 'tools.json' present in app md (no double preamble)")
  sB.close()

  // ── C) empty doc → preamble only ─────────────────────────────────────
  const sC = await freshSessionToken("")
  const rC = await httpGet(`/v1/t/${sC.token}/agents.md`)
  a.equal(rC.status, 200, "empty: status 200")
  a.ok(rC.body.length > 0, "empty: body is non-empty (preamble served)")
  a.ok(rC.body.includes("tools.json"), "empty: preamble served verbatim")
  a.ok(/do\s*NOT\s*recite/i.test(rC.body), "empty: do-not-recite present")
  sC.close()

  // ── D) tools.json endpoint is unaffected by the preamble logic ──────
  const sD = await freshSessionToken(appMdMinimal)
  const rD = await httpGet(`/v1/t/${sD.token}/tools.json`)
  a.equal(rD.status, 200, "tools.json still 200")
  a.equal(rD.headers.get("content-type"), "application/json; charset=utf-8", "tools.json content-type unchanged")
  let parsed
  try { parsed = JSON.parse(rD.body) } catch {}
  a.ok(parsed && Array.isArray(parsed.tools), "tools.json shape preserved (preamble logic only touches agents.md)")
  sD.close()
}
