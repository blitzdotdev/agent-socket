// SDK session regression tests against an in-memory mock relay (no network).
// Run: npm test -w sdk   (builds first; imports ../dist)

import { test } from "node:test"
import assert from "node:assert/strict"
import { connect } from "../dist/index.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Mock relay. `plan(n)` decides how connection n (1-based) behaves:
//   "ok"     — accept register, mint/revoke/list tokens
//   "reject" — reply register_reply { ok:false } then close (like unknown_app_id)
//   "drop"   — close right after open, before any reply
//   "drop-after-mint" — accept register, close right after the first mint reply
let plan = () => "ok"
let sockets = []

class MockWebSocket {
  constructor() {
    this.readyState = 0
    this.listeners = { open: [], close: [], message: [], error: [] }
    this.n = sockets.push(this)
    this.mode = plan(this.n)
    this.sessionId = `S${this.n}`
    this.tokens = new Set()
    setTimeout(() => {
      this.readyState = 1
      this._fire("open", {})
      if (this.mode === "drop") this.serverClose(1011, "down")
    }, 1)
  }
  addEventListener(ev, fn) { this.listeners[ev].push(fn) }
  removeEventListener(ev, fn) { const a = this.listeners[ev]; const i = a.indexOf(fn); if (i !== -1) a.splice(i, 1) }
  send(raw) {
    if (this.readyState !== 1) return
    const m = JSON.parse(raw)
    const reply = (o) => setTimeout(() => this.readyState === 1 && this._fire("message", { data: JSON.stringify(o) }), 1)
    if (m.type === "register") {
      if (this.mode === "reject") {
        reply({ type: "register_reply", ok: false, error: { code: "unknown_app_id" } })
        setTimeout(() => this.serverClose(4001, "unknown app_id"), 2)
      } else reply({ type: "register_reply", ok: true, sessionId: this.sessionId })
    } else if (m.type === "mint_agent_token") {
      const token = `tok_${this.sessionId}_${this.tokens.size}`
      this.tokens.add(token)
      reply({ type: "mint_agent_token_reply", id: m.id, ok: true, token, url: `__BASE__/v1/t/${token}/agents.md`, label: m.label })
      if (this.mode === "drop-after-mint") setTimeout(() => this.serverClose(1011, "blip"), 1)
    } else if (m.type === "revoke_agent_token") {
      reply({ type: "revoke_agent_token_reply", id: m.id, ok: this.tokens.delete(m.token) })
    } else if (m.type === "ping") {
      reply({ type: "pong", id: m.id })
    }
  }
  close(code = 1000, reason = "") { this.serverClose(code, reason) }
  serverClose(code, reason) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.tokens.clear()
    setTimeout(() => this._fire("close", { code, reason }), 1)
  }
  _fire(ev, payload) { for (const fn of this.listeners[ev].slice()) fn(payload) }
}
globalThis.WebSocket = MockWebSocket

const open = () => sockets.filter((s) => s.readyState === 1)
const base = { baseUrl: "http://mock", appId: "as_app_anon", agentsMd: "# t", tools: [] }
const quickRetry = ({ reconnect }) => setTimeout(reconnect, 10)

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error("waitFor timeout"); await sleep(5) }
}

function reset(p) { plan = p; sockets = [] }

test("failed connect() rejects without reconnecting", async () => {
  reset(() => "reject")
  let disconnects = 0
  await assert.rejects(connect({ ...base, onDisconnect: (i) => { disconnects++; quickRetry(i) } }), /register failed: unknown_app_id/)
  await sleep(200)
  assert.equal(sockets.length, 1)
  assert.equal(disconnects, 0)
  assert.equal(open().length, 0)
})

test("a socket dropped mid-register rejects connect() promptly", async () => {
  reset(() => "drop")
  const t0 = Date.now()
  await assert.rejects(connect({ ...base, onDisconnect: quickRetry }))
  assert.ok(Date.now() - t0 < 1000)
  await sleep(100)
  assert.equal(sockets.length, 1)
})

test("failed reconnects back off one attempt at a time and keep tokens", async () => {
  reset((n) => (n === 1 || n === 5 ? "ok" : "reject"))
  const attempts = []
  const changes = []
  const s = await connect({
    ...base,
    onDisconnect: (i) => { attempts.push(i.attempt); quickRetry(i) },
    onSessionChanged: (i) => changes.push(i),
  })
  const link = await s.mintAgentToken({ label: "L" })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => changes.length === 1)
  await sleep(100)
  assert.equal(sockets.length, 5)
  assert.deepEqual(attempts, [1, 2, 3, 4])
  assert.equal(changes[0].priorSessionId, "S1")
  assert.equal(changes[0].sessionId, "S5")
  assert.equal(changes[0].tokensRemapped.size, 1)
  assert.match(changes[0].tokensRemapped.get(link.url), /tok_S5_/)
  assert.equal(open().length, 1)
  s.close()
})

test("autoReconnect:false does not reconnect", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, autoReconnect: false })
  sockets[0].serverClose(1006, "blip")
  await sleep(1500)  // past the default backoff's first retry (~1s)
  assert.equal(sockets.length, 1)
  assert.equal(s.connected, false)
})

test("autoReconnect:false still lets onDisconnect reconnect manually, without remint", async () => {
  reset(() => "ok")
  const changes = []
  const s = await connect({ ...base, autoReconnect: false, onDisconnect: quickRetry, onSessionChanged: (i) => changes.push(i) })
  await s.mintAgentToken({ label: "L" })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => changes.length === 1)
  assert.equal(changes[0].tokensRemapped.size, 0)
  s.close()
})

test("revoke while disconnected resolves at once and the token is not re-minted", async () => {
  reset(() => "ok")
  const changes = []
  let retry
  const s = await connect({ ...base, onDisconnect: (i) => { retry = i.reconnect }, onSessionChanged: (i) => changes.push(i) })
  const a = await s.mintAgentToken({ label: "a" })
  const b = await s.mintAgentToken({ label: "b" })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => retry)
  const t0 = Date.now()
  assert.deepEqual(await s.revokeAgentToken(a.token), { ok: true })
  assert.ok(Date.now() - t0 < 100)
  retry()
  await waitFor(() => changes.length === 1)
  assert.deepEqual([...changes[0].tokensRemapped.keys()], [b.url])
  assert.equal(sockets[1].tokens.size, 1)
  s.close()
})

test("close() during a reconnect leaves no live socket or timers", async () => {
  reset(() => "ok")
  let retry
  const s = await connect({ ...base, heartbeatIntervalMs: 20, onDisconnect: (i) => { retry = i.reconnect } })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => retry)
  retry()          // reconnect starts opening socket 2…
  s.close()        // …and the app closes before it registers
  await sleep(100)
  assert.equal(open().length, 0)
  assert.equal(s.connected, false)
  assert.equal(s.heartbeatPingTimer, null)
})

test("a drop mid-remint re-mints the rest on the next reconnect", async () => {
  reset((n) => (n === 2 ? "drop-after-mint" : "ok"))
  const changes = []
  const s = await connect({ ...base, onDisconnect: quickRetry, onSessionChanged: (i) => changes.push(i) })
  const a = await s.mintAgentToken({ label: "a" })
  const b = await s.mintAgentToken({ label: "b" })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => changes.length === 2)
  const a2 = changes[0].tokensRemapped.get(a.url)
  assert.match(a2, /tok_S2_/)
  assert.match(changes[1].tokensRemapped.get(a2), /tok_S3_/)
  assert.match(changes[1].tokensRemapped.get(b.url), /tok_S3_/)
  assert.equal(sockets[2].tokens.size, 2)
  s.close()
})

test("a frame arriving after close() doesn't re-arm the heartbeat", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, heartbeatIntervalMs: 20 })
  const ws = sockets[0]
  s.close()
  ws._fire("message", { data: JSON.stringify({ type: "pong", id: "x" }) })
  assert.equal(s.heartbeatPingTimer, null)
})
