// 37-csrf-sec-fetch-site — Sec-Fetch-Site CSRF defense on the user-tool surface.
//
// The /v1/t/<token>/<tool> endpoints run user-defined handlers and may have
// side effects, so a browser-initiated cross-site request is a CSRF attempt.
// Browsers attach Sec-Fetch-Site on every fetch (Forbidden Header — JS can't
// spoof it); non-browser HTTP clients don't send it. Block any value other
// than "none" (user-initiated navigation: address-bar paste, bookmark).
//
// The relay-implemented meta paths (/agents.md, /tools.json, /_as_tasks/<id>)
// are READ-ONLY with no side effects and bypass the gate — they're the
// "preview this URL" surface that should work even when the user clicks the
// link from Gmail / web chat (which sends Sec-Fetch-Site: cross-site).
//
// Covers: all four Sec-Fetch-Site values + absent + meta-path carve-out
// + WS path unaffected + landing page unaffected + async-task poll carve-out.

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, openRawWs } from "../lib/relay.mjs"

async function fetchWith(headers, path, method = "POST") {
  const r = await fetch(`${RELAY_HTTP}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? "{}" : undefined,
  })
  const text = await r.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}

export default async function () {
  const a = new Assert("37-csrf-sec-fetch-site")
  const c = openRawWs()
  await c.waitOpen()

  c.send({
    type: "register",
    appId: "as_app_anon",
    agentsMd: "# csrf test",
    tools: [
      { method: "POST", path: "/echo", description: "echoes input" },
      { method: "POST", path: "/slow", description: "returns 202+taskId" },
    ],
  })
  await c.waitFor((m) => m.type === "register_reply" && m.ok)

  c.send({ type: "mint_agent_token", id: "m1", label: "csrf" })
  const mint = await c.waitFor((m) => m.type === "mint_agent_token_reply" && m.id === "m1")
  const token = mint.token

  // Auto-reply tool_calls. /slow → 202+taskId; /echo → 200 ok.
  const replied = new Set()
  let lastTaskId = null
  ;(async () => {
    for (;;) {
      try {
        const call = await c.waitFor((m) => m.type === "tool_call" && !replied.has(m.id), 10_000)
        replied.add(call.id)
        if (call.path === "/slow") {
          lastTaskId = "task-" + call.id.slice(0, 6)
          c.send({ type: "tool_reply", id: call.id, status: 202, taskId: lastTaskId })
        } else {
          c.send({ type: "tool_reply", id: call.id, status: 200, body: { ok: true } })
        }
      } catch { return }
    }
  })()

  const toolPath = `/v1/t/${token}/echo`
  const agentsPath = `/v1/t/${token}/agents.md`
  const toolsJsonPath = `/v1/t/${token}/tools.json`
  const slowPath = `/v1/t/${token}/slow`

  // ── User-tool surface: gate applies ──────────────────────────────

  // 1. No Sec-Fetch-Site header (non-browser HTTP client) → allowed.
  const r1 = await fetchWith({}, toolPath)
  a.equal(r1.status, 200, "tool: no Sec-Fetch-Site → 200")
  a.equal(r1.json?.ok, true, "tool ran")

  // 2. Sec-Fetch-Site: none (address-bar paste / bookmark) → allowed.
  const r2 = await fetchWith({ "sec-fetch-site": "none" }, toolPath)
  a.equal(r2.status, 200, "tool: Sec-Fetch-Site: none → 200")

  // 3. Sec-Fetch-Site: cross-site (evil.com fetch from JS) → 403.
  const r3 = await fetchWith({ "sec-fetch-site": "cross-site" }, toolPath)
  a.equal(r3.status, 403, "tool: cross-site → 403")
  a.equal(r3.json?.error?.code, "csrf_denied", "code is csrf_denied")

  // 4. Sec-Fetch-Site: same-site → 403.
  const r4 = await fetchWith({ "sec-fetch-site": "same-site" }, toolPath)
  a.equal(r4.status, 403, "tool: same-site → 403")

  // 5. Sec-Fetch-Site: same-origin → 403.
  const r5 = await fetchWith({ "sec-fetch-site": "same-origin" }, toolPath)
  a.equal(r5.status, 403, "tool: same-origin → 403")

  // ── Meta-path carve-out: gate skipped, all values allowed ─────────

  // 6. /agents.md must work from cross-site click (Gmail link).
  const r6a = await fetchWith({ "sec-fetch-site": "cross-site" }, agentsPath, "GET")
  a.equal(r6a.status, 200, "agents.md from cross-site browser → 200 (carve-out)")
  a.ok(r6a.text.includes("csrf test"), "agents.md content served")

  const r6b = await fetchWith({ "sec-fetch-site": "none" }, agentsPath, "GET")
  a.equal(r6b.status, 200, "agents.md address-bar paste → 200")

  // 7. /tools.json must also work cross-site.
  const r7 = await fetchWith({ "sec-fetch-site": "cross-site" }, toolsJsonPath, "GET")
  a.equal(r7.status, 200, "tools.json from cross-site → 200 (carve-out)")
  a.ok(r7.json?.tools?.length >= 1, "tools.json body returned")

  // 8. /_as_tasks/<id> must work cross-site (agent's status poll).
  // First create a task by hitting /slow (allowed: no SFS header).
  const r8a = await fetchWith({}, slowPath)
  a.equal(r8a.status, 202, "slow → 202")
  a.ok(lastTaskId, "task id captured")
  const r8b = await fetchWith({ "sec-fetch-site": "cross-site" },
    `/v1/t/${token}/_as_tasks/${lastTaskId}`, "GET")
  a.equal(r8b.status, 202, "_as_tasks poll from cross-site → 202 (carve-out)")

  // ── Unaffected surfaces ──────────────────────────────────────────

  // 9. WebSocket upgrade path is NOT gated (apps may be browsers).
  const r9 = await fetchWith({ "sec-fetch-site": "cross-site" }, "/v1/_ws", "GET")
  a.equal(r9.status, 400, "/v1/_ws cross-site without upgrade → 400 (not 403)")
  a.equal(r9.json?.error?.code, "protocol_error", "code is protocol_error")

  // 10. Landing page is NOT gated (humans visit it).
  const r10 = await fetchWith({ "sec-fetch-site": "cross-site" }, "/", "GET")
  a.equal(r10.status, 200, "landing page cross-site → 200")

  c.close()
}
