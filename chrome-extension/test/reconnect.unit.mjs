// Unit test for the SDK WS reconnect path as used by the chrome extension.
//
// Drives @agent-socket/sdk (vendored at chrome-extension/lib/sdk/) with a
// mocked WebSocket so we don't need chromium, xvfb, or a real relay.
// Verifies the behavior originally landed for chrome-ext-ws-drops-no-reconnect.md
// and preserved after the consolidation (as-client.js → SDK).
//
// Run: node chrome-extension/test/reconnect.unit.mjs

import { connect } from "../lib/sdk/index.js"

// ── mock WebSocket ────────────────────────────────────────────────
// In-memory WS that we drive from test code. Each instance is tracked
// so the test can call `instance.simulateClose(code)` to fake a drop.

let mockSessionCounter = 0
const allMocks = []

class MockWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0  // CONNECTING
    this.listeners = { open: [], close: [], message: [], error: [] }
    this._mockSessionId = `MOCK${String(++mockSessionCounter).padStart(4, "0")}`
    this._mintCounter = 0
    allMocks.push(this)
    // Open async (mimics real WS handshake).
    setTimeout(() => {
      this.readyState = 1
      this._fire("open", {})
    }, 5)
  }
  addEventListener(ev, fn, _opts) { this.listeners[ev]?.push(fn) }
  removeEventListener(ev, fn) {
    const arr = this.listeners[ev]
    if (!arr) return
    const i = arr.indexOf(fn)
    if (i !== -1) arr.splice(i, 1)
  }
  send(payload) {
    if (this.readyState !== 1) return
    const msg = JSON.parse(payload)
    // Auto-reply to register and mint_agent_token to drive the client through
    // its happy path.
    if (msg.type === "register") {
      setTimeout(() => this._deliver({ type: "register_reply", ok: true, sessionId: this._mockSessionId }), 1)
    } else if (msg.type === "mint_agent_token") {
      const token = `as_${this._mockSessionId}_${this._mintCounter++}xxxxxxxxxxxxxxxxxxxxxx`
      setTimeout(() => this._deliver({ type: "mint_agent_token_reply", id: msg.id, ok: true, token, url: `__BASE__/v1/t/${token}/agents.md`, label: msg.label }), 1)
    } else if (msg.type === "ping") {
      setTimeout(() => this._deliver({ type: "pong", id: msg.id }), 1)
    }
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return
    this.readyState = 3
    // Native WebSocket dispatches CloseEvent with .code / .reason.
    this._fire("close", { code, reason })
  }
  // Test-only: pretend the server dropped us.
  simulateClose(code = 1006, reason = "server gone") {
    this.close(code, reason)
  }
  _deliver(obj) {
    this._fire("message", { data: JSON.stringify(obj) })
  }
  _fire(event, payload) {
    for (const fn of (this.listeners[event] ?? []).slice()) {
      try { fn(payload) } catch (e) { console.error(`listener err:`, e) }
    }
  }
}

globalThis.WebSocket = MockWebSocket

// ── assertions ───────────────────────────────────────────────────
let passed = 0, failed = 0
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else      { failed++; console.log(`  FAIL ${label}`) }
}
function equal(a, b, label) { ok(a === b, `${label}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── tests ────────────────────────────────────────────────────────
async function run() {
  console.log("── SDK reconnect unit tests (vendored into chrome-extension/lib/sdk/) ──")

  const sessionChanges = []
  const disconnects = []
  // 1. Initial connect + mint.
  const session = await connect({
    baseUrl: "http://localhost:9999",
    appId: "as_app_anon",
    agentsMd: "# test",
    tools: [{ path: "/noop", description: "noop", handler: () => ({ ok: true }) }],
    onDisconnect: (info) => {
      disconnects.push({ reason: info.reason, attempt: info.attempt })
      // Mimic the default exp-backoff so reconnect actually fires (we override
      // onDisconnect, which means we're responsible for calling reconnect()).
      setTimeout(info.reconnect, 50 + Math.random() * 50)
    },
    onSessionChanged: (info) => sessionChanges.push(info),
  })
  ok(session.connected, "connected after initial register")
  ok(session.sessionId.startsWith("MOCK"), `sessionId mock-shaped: ${session.sessionId}`)
  const initialSessionId = session.sessionId
  const initialMock = allMocks[allMocks.length - 1]

  const link1 = await session.mintAgentToken({ label: "user-1" })
  ok(link1.url.includes(initialSessionId), `minted URL embeds initial sessionId`)
  ok(link1.token.startsWith(`as_${initialSessionId}_`), `token has initial sessionId`)
  equal(session.myTokens.size, 1, "myTokens tracked after mint")

  // 2. Force the server-side close (simulates relay 1006 / SW idle-kill).
  initialMock.simulateClose(1006, "fake idle-kill")
  ok(disconnects.length === 1, "onDisconnect fired on simulated drop")
  ok(disconnects[0].attempt === 1, "first disconnect has attempt=1")
  ok(!session.connected, "session knows it's disconnected")

  // 3. Wait for the reconnect (50-100ms delay scheduled in onDisconnect).
  //    Then register_reply (~1ms) + remint (~1ms). 500ms is plenty.
  await sleep(500)
  ok(session.connected, "reconnected after WS close")
  ok(session.sessionId !== initialSessionId, `sessionId changed after reconnect (${initialSessionId} → ${session.sessionId})`)

  // 4. The previously-minted token was re-minted under the new session-id.
  equal(sessionChanges.length, 1, "onSessionChanged fired exactly once")
  const change = sessionChanges[0]
  equal(change.priorSessionId, initialSessionId, "priorSessionId reported correctly")
  equal(change.sessionId, session.sessionId, "new sessionId reported correctly")
  ok(change.tokensRemapped instanceof Map, "tokensRemapped is a Map")
  equal(change.tokensRemapped.size, 1, "exactly one token remapped")
  const [oldUrl, newUrl] = [...change.tokensRemapped.entries()][0]
  equal(oldUrl, link1.url, "old URL key matches the previously-minted one")
  ok(newUrl.includes(session.sessionId), "new URL embeds the new sessionId")
  ok(!newUrl.includes(initialSessionId), "new URL does NOT embed the old sessionId")
  equal(session.myTokens.size, 1, "myTokens still has exactly one entry after remint")

  // 5. session.ping() actually sends a ping (the MV3 keepalive helper).
  const m = allMocks[allMocks.length - 1]
  let pingSent = false
  const origSend = m.send.bind(m)
  m.send = (p) => { if (JSON.parse(p).type === "ping") pingSent = true; origSend(p) }
  session.ping()
  await sleep(50)
  ok(pingSent, "session.ping() emits a ping frame on the WS")

  // 6. close() suppresses reconnect. No "closed" callback — the SDK is silent
  //    on user-initiated close, which is the right primitive. The chrome-ext
  //    background.js emits its own "closed" status when stopConnect runs.
  session.close()
  ok(!session.connected, "session.connected false immediately after close()")
  const disconnectCountAfterClose = disconnects.length
  // Wait long enough that any stray reconnect would have surfaced.
  await sleep(500)
  ok(disconnects.length === disconnectCountAfterClose, "no further onDisconnect fires after close()")
  ok(!session.connected, "stays closed after close()")

  console.log("")
  console.log(`──  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((e) => { console.error(e); process.exit(2) })
