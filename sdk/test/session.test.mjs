// SDK session regression tests against an in-memory mock relay (no network).
// Run: npm test -w sdk   (builds first; imports ../dist)

import { test } from "node:test"
import assert from "node:assert/strict"
import { connect, exponentialBackoff } from "../dist/index.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Mock relay. `plan(n)` decides how connection n (1-based) behaves:
//   "ok"     — accept register/resume, mint/revoke/list tokens
//   "reject" — reply register_reply { ok:false } then close (like unknown_app_id)
//   "drop"   — close right after open, before any reply
//   "drop-after-mint" — accept, close right after the first mint reply
//   "down"   — the relay is unreachable: the socket errors and closes (1006)
//              without ever opening
// Like the relay, a session (secret + tokens) outlives a dropped socket until
// `expireSessions()` (the grace window running out) or a client close(1000).
// A resume of an unknown session or with a bad secret gets resume_failed + 4401.
let plan = () => "ok"
let sockets = []
let sessions = new Map()  // sessionId → { secret, tokens: Set, ws }
let nextSession = 0

class MockWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.listeners = { open: [], close: [], message: [], error: [] }
    this.n = sockets.push(this)
    this.mode = plan(this.n)
    this.resumeId = new URL(url).searchParams.get("session")
    this.session = null
    this.frames = []
    setTimeout(() => {
      if (this.mode === "down") {
        this.readyState = 3
        this._fire("error", {})
        this._fire("close", { code: 1006, reason: "" })
        return
      }
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
    this.frames.push(m)
    const reply = (o) => setTimeout(() => this.readyState === 1 && this._fire("message", { data: JSON.stringify(o) }), 1)
    if (m.type === "end") {
      // Like the relay: the secret ends the held session at once.
      const sess = sessions.get(m.sessionId)
      const ok = !!this.resumeId && !!sess && sess.secret === m.secret
      if (ok) sessions.delete(m.sessionId)
      reply({ type: "end_reply", ok })
      setTimeout(() => this.serverClose(ok ? 1000 : 4401, ok ? "session ended" : "end rejected"), 2)
      return
    }
    if (m.type === "register" || m.type === "resume") {
      if (this.mode === "reject") {
        reply({ type: "register_reply", ok: false, error: { code: "unknown_app_id" } })
        setTimeout(() => this.serverClose(4001, "unknown app_id"), 2)
        return
      }
      if (m.type === "resume") {
        const sess = sessions.get(m.sessionId)
        if (!this.resumeId || !sess || sess.secret !== m.secret) {
          reply({ type: "register_reply", ok: false, error: { code: "resume_failed" } })
          setTimeout(() => this.serverClose(4401, "resume rejected"), 2)
          return
        }
        for (const t of m.revokeTokens ?? []) sess.tokens.delete(t)
        if (sess.ws && sess.ws !== this) sess.ws.serverClose(4410, "replaced")
        sess.ws = this
        this.session = sess
        reply({ type: "register_reply", ok: true, sessionId: m.sessionId, resumeSecret: sess.secret, resumed: true })
      } else {
        const id = `S${++nextSession}`
        this.session = { id, secret: `secret_${id}`, tokens: new Set(), ws: this }
        sessions.set(id, this.session)
        reply({ type: "register_reply", ok: true, sessionId: id, resumeSecret: this.session.secret })
      }
    } else if (!this.session) {
      // not registered: drop
    } else if (m.type === "mint_agent_token") {
      const token = `as_${this.session.id}_${this.session.tokens.size}_${Math.random().toString(36).slice(2, 6)}`
      this.session.tokens.add(token)
      reply({ type: "mint_agent_token_reply", id: m.id, ok: true, token, url: `__BASE__/v1/t/${token}/agents.md`, label: m.label })
      if (this.mode === "drop-after-mint") setTimeout(() => this.serverClose(1011, "blip"), 1)
    } else if (m.type === "revoke_agent_token") {
      reply({ type: "revoke_agent_token_reply", id: m.id, ok: this.session.tokens.delete(m.token) })
    } else if (m.type === "list_agent_tokens") {
      reply({ type: "list_agent_tokens_reply", id: m.id, tokens: [...this.session.tokens].map((token) => ({ token, url: `__BASE__/v1/t/${token}/agents.md`, label: "", mintedAt: 1 })) })
    } else if (m.type === "ping") {
      reply({ type: "pong", id: m.id })
    } else if (m.type === "update_tools") {
      // Like the relay: a reserved or duplicate path refuses the whole update.
      const keys = m.tools.map((t) => `${t.method} ${t.path}`)
      if (m.tools.some((t) => t.path === "/agents.md")) {
        reply({ type: "update_tools_reply", id: m.id, ok: false, error: { code: "reserved_path", message: "path is reserved: /agents.md" } })
      } else if (new Set(keys).size !== keys.length) {
        reply({ type: "update_tools_reply", id: m.id, ok: false, error: { code: "protocol_error" } })
      } else if (this.mode === "drop-on-update") {
        this.mode = "ok"
        setTimeout(() => this.serverClose(1011, "blip"), 1)
      } else {
        reply({ type: "update_tools_reply", id: m.id, ok: true })
      }
    }
  }
  close(code = 1000, reason = "") {
    if (code === 1000 && this.session) sessions.delete(this.session.id)
    this.serverClose(code, reason)
  }
  serverClose(code, reason) {
    if (this.readyState === 3) return
    this.readyState = 3
    if (this.session?.ws === this) this.session.ws = null
    setTimeout(() => this._fire("close", { code, reason }), 1)
  }
  _fire(ev, payload) { for (const fn of this.listeners[ev].slice()) fn(payload) }
}
globalThis.WebSocket = MockWebSocket

const expireSessions = () => sessions.clear()
const tokensOf = (id) => sessions.get(id)?.tokens
const open = () => sockets.filter((s) => s.readyState === 1)
const base = { baseUrl: "http://mock", appId: "as_app_anon", agentsMd: "# t", tools: [] }
const quickRetry = ({ reconnect }) => setTimeout(reconnect, 10)

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error("waitFor timeout"); await sleep(5) }
}

function reset(p) { plan = p; sockets = []; sessions = new Map(); nextSession = 0 }

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

test("a drop resumes the same session: same URLs, no onSessionChanged", async () => {
  reset(() => "ok")
  const changes = [], reconnects = []
  const s = await connect({ ...base, onDisconnect: quickRetry, onSessionChanged: (i) => changes.push(i), onReconnect: (i) => reconnects.push(i) })
  const link = await s.mintAgentToken({ label: "L" })
  assert.equal(s.resumeSecret, "secret_S1")
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => reconnects.length === 1)
  assert.deepEqual(reconnects[0], { sessionId: "S1", resumed: true })
  assert.equal(sockets[1].resumeId, "S1")
  assert.equal(sockets[1].frames[0].type, "resume")
  assert.equal(sockets[1].frames[0].secret, "secret_S1")
  assert.ok(!sockets[1].url.includes("secret"), "secret is not in the URL")
  assert.equal(s.sessionId, "S1")
  assert.equal(changes.length, 0)
  assert.ok(tokensOf("S1").has(link.token))
  assert.equal(s.connected, true)
  s.close()
})

test("resume re-sends the current tools and agentsMd", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, onDisconnect: quickRetry, tools: [{ path: "/a", description: "a", handler: () => 1 }] })
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => s.connected && sockets.length === 2)
  const f = sockets[1].frames[0]
  assert.equal(f.type, "resume")
  assert.equal(f.agentsMd, "# t")
  assert.deepEqual(f.tools.map((t) => `${t.method} ${t.path}`), ["POST /a"])
  s.close()
})

test("a refused resume falls back to a fresh session at once and re-mints", async () => {
  reset(() => "ok")
  const changes = [], reconnects = [], attempts = []
  const s = await connect({
    ...base,
    onDisconnect: (i) => { attempts.push(i.attempt); quickRetry(i) },
    onSessionChanged: (i) => changes.push(i),
    onReconnect: (i) => reconnects.push(i),
  })
  const link = await s.mintAgentToken({ label: "L" })
  sockets[0].serverClose(1011, "blip")
  expireSessions()
  await waitFor(() => reconnects.length === 1)
  assert.deepEqual(attempts, [1], "fallback happens inside the same attempt")
  assert.equal(sockets.length, 3)
  assert.equal(sockets[1].resumeId, "S1")
  assert.equal(sockets[2].resumeId, null)
  assert.deepEqual(reconnects[0], { sessionId: "S2", resumed: false })
  assert.equal(changes.length, 1)
  assert.equal(changes[0].priorSessionId, "S1")
  assert.equal(changes[0].sessionId, "S2")
  assert.match(changes[0].tokensRemapped.get(link.url), /as_S2_/)
  assert.equal(changes[0].reason, "resume_refused")
  assert.equal(changes[0].closeCode, 4401)
  assert.equal(typeof changes[0].offlineMs, "number")
  assert.equal(s.resumeSecret, "secret_S2")
  s.close()
})

test("onSessionChanged reports how long the app was offline; onDisconnect gets the close code", async () => {
  reset(() => "ok")
  const changes = [], drops = []
  let retry
  const s = await connect({ ...base, onDisconnect: (i) => { drops.push(i); retry = i.reconnect }, onSessionChanged: (i) => changes.push(i) })
  await s.mintAgentToken({ label: "L" })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => retry)
  assert.equal(drops[0].code, 1006)
  assert.equal(drops[0].reason, "blip")
  expireSessions()
  await sleep(150)  // the app stays away past the (mock) grace window
  retry()
  await waitFor(() => changes.length === 1)
  assert.equal(changes[0].reason, "resume_refused")
  assert.ok(changes[0].offlineMs >= 150 && changes[0].offlineMs < 1000, `offlineMs=${changes[0].offlineMs}`)
  s.close()
})

test("a refused resume of a failed attempt reports its close code to onDisconnect", async () => {
  reset((n) => (n === 2 ? "reject" : "ok"))
  const drops = []
  const s = await connect({ ...base, onDisconnect: (i) => { drops.push(i); quickRetry(i) } })
  sockets[0].serverClose(1011, "down")
  await waitFor(() => s.connected && sockets.length === 3)
  assert.deepEqual(drops.map((d) => [d.attempt, d.code]), [[1, 1011], [2, undefined]])
  s.close()
})

test("failed reconnects back off one attempt at a time, then resume with tokens intact", async () => {
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
  await waitFor(() => s.connected && sockets.length === 5)
  await sleep(100)
  assert.equal(sockets.length, 5)
  assert.deepEqual(attempts, [1, 2, 3, 4])
  assert.ok(sockets.slice(1).every((w) => w.resumeId === "S1"), "every attempt tries the resume")
  assert.equal(s.sessionId, "S1")
  assert.equal(changes.length, 0)
  assert.ok(tokensOf("S1").has(link.token))
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

test("autoReconnect:false still lets onDisconnect reconnect manually: resumes, or a fresh session without remint", async () => {
  reset(() => "ok")
  const changes = [], reconnects = []
  const s = await connect({ ...base, autoReconnect: false, onDisconnect: quickRetry, onSessionChanged: (i) => changes.push(i), onReconnect: (i) => reconnects.push(i) })
  const link = await s.mintAgentToken({ label: "L" })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => reconnects.length === 1)
  assert.equal(reconnects[0].resumed, true)
  assert.equal(changes.length, 0)
  assert.ok(tokensOf("S1").has(link.token))
  sockets[1].serverClose(1006, "blip")
  expireSessions()
  await waitFor(() => changes.length === 1)
  assert.equal(changes[0].sessionId, "S2")
  assert.equal(changes[0].tokensRemapped.size, 0)
  s.close()
})

test("revoke while disconnected resolves at once; the resume revokes it on the relay", async () => {
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
  await waitFor(() => s.connected)
  assert.deepEqual(sockets[1].frames[0].revokeTokens, [a.token])
  assert.deepEqual([...tokensOf("S1")], [b.token])
  assert.equal(changes.length, 0)
  assert.equal(s.pendingRevokes.size, 0)
  s.close()
})

test("revoke while disconnected is not re-minted when the session ended", async () => {
  reset(() => "ok")
  const changes = []
  let retry
  const s = await connect({ ...base, onDisconnect: (i) => { retry = i.reconnect }, onSessionChanged: (i) => changes.push(i) })
  const a = await s.mintAgentToken({ label: "a" })
  const b = await s.mintAgentToken({ label: "b" })
  sockets[0].serverClose(1006, "blip")
  expireSessions()
  await waitFor(() => retry)
  await s.revokeAgentToken(a.token)
  retry()
  await waitFor(() => changes.length === 1)
  assert.deepEqual([...changes[0].tokensRemapped.keys()], [b.url])
  assert.equal(tokensOf("S2").size, 1)
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

test("close() ends the session on the relay (clean 1000 close)", async () => {
  reset(() => "ok")
  const s = await connect({ ...base })
  s.close()
  assert.equal(sessions.has("S1"), false)
})

test("close() while disconnected ends the held session with an `end` frame", async () => {
  reset(() => "ok")
  let retry
  const s = await connect({ ...base, onDisconnect: (i) => { retry = i.reconnect } })
  sockets[0].serverClose(1006, "blip")
  await waitFor(() => retry)
  assert.ok(sessions.has("S1"), "the relay holds the session while the app is away")
  s.close()
  await waitFor(() => !sessions.has("S1"))
  const endSock = sockets[sockets.length - 1]
  assert.equal(endSock.resumeId, "S1")
  assert.deepEqual(endSock.frames, [{ type: "end", sessionId: "S1", secret: "secret_S1" }])
  await waitFor(() => open().length === 0)
  assert.equal(s.resumeSecret, null)
  retry()  // a backoff timer firing after close() must not reconnect
  await sleep(20)
  assert.equal(open().length, 0)
})

test("close() after a 4410 replace doesn't end the session it no longer owns", async () => {
  reset(() => "ok")
  let retry
  const s = await connect({ ...base, onDisconnect: (i) => { retry = i.reconnect } })
  sockets[0].serverClose(4410, "replaced")
  await waitFor(() => retry)
  s.close()
  await sleep(20)
  assert.equal(sockets.length, 1, "no end socket")
  assert.ok(sessions.has("S1"))
})

test("heartbeat sends the fixed frame the relay auto-answers", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, heartbeatIntervalMs: 10, heartbeatTimeoutMs: 1000 })
  const raw = []
  const send = sockets[0].send.bind(sockets[0])
  sockets[0].send = (p) => { raw.push(p); send(p) }
  await waitFor(() => raw.length >= 2)
  assert.equal(raw[0], '{"type":"ping","id":"as_hb"}')
  assert.equal(raw[1], raw[0], "same bytes every time")
  await sleep(30)
  assert.equal(s.connected, true, "the pong (same id) keeps the session alive")
  s.close()
})

test("default backoff: capped interval, never gives up", () => {
  const delays = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return 0 }
  try {
    const backoff = exponentialBackoff()
    let gaveUp = false
    for (let attempt = 1; attempt <= 5000; attempt++) backoff({ attempt, reason: "x", reconnect: () => {}, giveUp: () => { gaveUp = true } })
    assert.equal(gaveUp, false)
    assert.equal(delays.length, 5000, "every attempt schedules a reconnect")
    assert.ok(delays.every((d) => Number.isFinite(d) && d >= 0 && d <= 30_000 * 1.25), "interval ≤ 37.5 s")
    assert.ok(delays.slice(20).every((d) => d >= 30_000 * 0.75), "settles at ~30 s")
    // 24 h of retries at the cap: about 2,900 attempts, each one a resume.
    assert.ok(delays.reduce((a, b) => a + b, 0) > 24 * 3600_000, "5,000 attempts span more than a day")
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test("a long outage: keeps retrying, then resumes the same session", async () => {
  let down = true
  reset((n) => (n > 1 && down ? "down" : "ok"))
  const changes = [], reconnects = [], attempts = []
  const backoff = exponentialBackoff({ baseMs: 1, maxMs: 4 })
  const s = await connect({
    ...base,
    onDisconnect: (i) => { attempts.push(i.attempt); backoff(i) },
    onSessionChanged: (i) => changes.push(i),
    onReconnect: (i) => reconnects.push(i),
  })
  const link = await s.mintAgentToken({ label: "L" })
  sockets[0].serverClose(1006, "laptop asleep")
  await waitFor(() => attempts.length >= 200, 5000)
  assert.equal(reconnects.length, 0)
  down = false
  await waitFor(() => reconnects.length === 1, 1000)
  assert.deepEqual(reconnects[0], { sessionId: "S1", resumed: true })
  assert.equal(changes.length, 0, "same links")
  assert.ok(tokensOf("S1").has(link.token))
  assert.equal(sockets[sockets.length - 1].frames[0].type, "resume")
  s.close()
})

test("a drop mid-remint re-mints the rest on the next reconnect", async () => {
  reset((n) => (n === 3 ? "drop-after-mint" : "ok"))
  const changes = []
  const s = await connect({ ...base, onDisconnect: quickRetry, onSessionChanged: (i) => changes.push(i) })
  const a = await s.mintAgentToken({ label: "a" })
  const b = await s.mintAgentToken({ label: "b" })
  sockets[0].serverClose(1006, "blip")
  expireSessions()
  // socket 2: resume refused → socket 3: fresh S2, drops after re-minting a →
  // socket 4: resumes S2 and re-mints b, which S2 never had.
  await waitFor(() => changes.length === 2)
  const a2 = changes[0].tokensRemapped.get(a.url)
  assert.match(a2, /as_S2_/)
  assert.equal(changes[0].tokensRemapped.size, 1)
  assert.equal(changes[0].reason, "resume_refused")
  assert.equal(changes[1].priorSessionId, "S2")
  assert.equal(changes[1].sessionId, "S2")
  assert.equal(changes[1].reason, "remint", "same session, missed links minted")
  assert.equal(changes[1].closeCode, undefined)
  assert.deepEqual([...changes[1].tokensRemapped.keys()], [b.url])
  assert.match(changes[1].tokensRemapped.get(b.url), /as_S2_/)
  assert.equal(sockets[3].resumeId, "S2")
  // b may also have been minted on socket 3 with the reply lost in the drop;
  // that orphan was never handed out.
  assert.ok(tokensOf("S2").has(new URL(changes[1].tokensRemapped.get(b.url).replace("__BASE__", "http://mock")).pathname.split("/")[3]))
  s.close()
})

test("connect({ resume }) reattaches to a saved session and adopts its tokens", async () => {
  reset(() => "ok")
  const first = await connect({ ...base })
  const link = await first.mintAgentToken({ label: "L" })
  const saved = { sessionId: first.sessionId, secret: first.resumeSecret }
  sockets[0].serverClose(1006, "process restart")  // the old instance dies without close()
  first.giveUpReconnect = true
  const s = await connect({ ...base, resume: saved, onDisconnect: quickRetry })
  assert.equal(s.sessionId, "S1")
  assert.ok(s.myTokens.has(link.token), "adopted the live token")
  // If that session later ends, the adopted token is re-minted.
  const changes = []
  s.onSessionChanged = (i) => changes.push(i)
  sockets[sockets.length - 1].serverClose(1006, "blip")
  expireSessions()
  await waitFor(() => changes.length === 1)
  assert.equal(changes[0].tokensRemapped.size, 1)
  s.close()
})

test("connect({ resume }) with a dead session opens a fresh one", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, resume: { sessionId: "GONE", secret: "x" } })
  assert.equal(s.sessionId, "S1")
  assert.equal(s.resumeSecret, "secret_S1")
  s.close()
})

test("replaced by another resume (4410): next reconnect starts a fresh session", async () => {
  reset(() => "ok")
  const changes = []
  const s = await connect({ ...base, onDisconnect: quickRetry, onSessionChanged: (i) => changes.push(i) })
  sockets[0].serverClose(4410, "replaced")
  await waitFor(() => changes.length === 1)
  assert.equal(sockets[1].resumeId, null, "did not try to take the session back")
  assert.equal(changes[0].sessionId, "S2")
  assert.equal(changes[0].reason, "replaced")
  assert.equal(changes[0].closeCode, 4410)
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

// ── updateTools ────────────────────────────────────────────────────────

// Delivers a tool_call on `ws` and resolves with the app's tool_reply.
async function callTool(ws, path) {
  const id = `call_${Math.random().toString(36).slice(2, 8)}`
  ws._fire("message", { data: JSON.stringify({ type: "tool_call", id, method: "POST", path, body: "{}", headers: {} }) })
  await waitFor(() => ws.frames.some((f) => f.type === "tool_reply" && f.id === id))
  return ws.frames.find((f) => f.type === "tool_reply" && f.id === id)
}

const tool = (path, value) => ({ path, description: path, handler: () => ({ value }) })

test("updateTools replaces tools and agentsMd on the same session", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, tools: [tool("/a", "a")] })
  await s.updateTools([tool("/b", "b"), { ...tool("/c", "c"), method: "get", input_schema: { type: "object" } }], "# v2")
  const f = sockets[0].frames.find((x) => x.type === "update_tools")
  assert.deepEqual(f.tools, [
    { method: "POST", path: "/b", description: "/b" },
    { method: "GET", path: "/c", description: "/c", input_schema: { type: "object" } },
  ])
  assert.equal(f.agentsMd, "# v2")
  assert.equal(s.sessionId, "S1")
  assert.equal(sockets.length, 1, "no new socket")
  assert.deepEqual((await callTool(sockets[0], "/b")).body, { value: "b" })
  assert.equal((await callTool(sockets[0], "/a")).status, 404, "removed tool no longer routed")
  s.close()
})

test("updateTools without agentsMd leaves it out of the frame and keeps the current one", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, onDisconnect: quickRetry, tools: [] })
  await s.updateTools([tool("/b", "b")])
  assert.equal("agentsMd" in sockets[0].frames.find((x) => x.type === "update_tools"), false)
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => s.connected && sockets.length === 2)
  assert.equal(sockets[1].frames[0].agentsMd, "# t")
  s.close()
})

test("a resume after updateTools re-sends the updated tools and agentsMd", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, onDisconnect: quickRetry, tools: [tool("/a", "a")] })
  await s.updateTools([tool("/b", "b")], "# v2")
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => s.connected && sockets.length === 2)
  const r = sockets[1].frames[0]
  assert.equal(r.type, "resume")
  assert.equal(r.agentsMd, "# v2")
  assert.deepEqual(r.tools.map((t) => t.path), ["/b"])
  assert.deepEqual((await callTool(sockets[1], "/b")).body, { value: "b" })
  s.close()
})

test("a fresh session after updateTools registers the updated tools", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, onDisconnect: quickRetry, tools: [tool("/a", "a")] })
  await s.updateTools([tool("/b", "b")])
  expireSessions()
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => s.connected && s.sessionId === "S2")
  const reg = sockets.at(-1).frames[0]
  assert.equal(reg.type, "register")
  assert.deepEqual(reg.tools.map((t) => t.path), ["/b"])
  s.close()
})

test("a refused update rejects with the relay's code and keeps the old tools", async () => {
  reset(() => "ok")
  const s = await connect({ ...base, onDisconnect: quickRetry, tools: [tool("/a", "a")] })
  await assert.rejects(s.updateTools([tool("/b", "b"), tool("/agents.md", "x")], "# bad"), (e) => e.code === "reserved_path" && /reserved/.test(e.message))
  assert.deepEqual((await callTool(sockets[0], "/a")).body, { value: "a" })
  assert.equal((await callTool(sockets[0], "/b")).status, 404, "new tool not routed after a refused update")
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => s.connected && sockets.length === 2)
  assert.deepEqual(sockets[1].frames[0].tools.map((t) => t.path), ["/a"], "resume sends the old set")
  assert.equal(sockets[1].frames[0].agentsMd, "# t")
  s.close()
})

test("updateTools rejects a tool without a handler before sending anything", async () => {
  reset(() => "ok")
  const s = await connect({ ...base })
  await assert.rejects(s.updateTools([{ path: "/x", description: "x" }]), /has no handler/)
  assert.equal(sockets[0].frames.some((f) => f.type === "update_tools"), false)
  s.close()
})

test("updateTools while disconnected applies after the resume", async () => {
  reset(() => "ok")
  let retry
  const s = await connect({ ...base, onDisconnect: (i) => { retry = i.reconnect }, tools: [tool("/a", "a")] })
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => !s.connected && retry)
  let done = false
  const p = s.updateTools([tool("/b", "b")], "# v2").then(() => { done = true })
  await sleep(30)
  assert.equal(done, false, "waits for the reconnect")
  retry()
  await p
  assert.equal(sockets[1].frames[0].type, "resume")
  assert.deepEqual(sockets[1].frames[0].tools.map((t) => t.path), ["/a"], "resume carries the committed set")
  assert.deepEqual(sockets[1].frames.find((f) => f.type === "update_tools").tools.map((t) => t.path), ["/b"])
  assert.deepEqual((await callTool(sockets[1], "/b")).body, { value: "b" })
  s.close()
})

test("a drop mid-update re-sends it on the resumed socket", async () => {
  reset((n) => (n === 1 ? "drop-on-update" : "ok"))
  const s = await connect({ ...base, onDisconnect: quickRetry, tools: [tool("/a", "a")] })
  await s.updateTools([tool("/b", "b")])
  assert.equal(sockets.length, 2)
  assert.deepEqual(sockets[1].frames[0].tools.map((t) => t.path), ["/a"])
  assert.deepEqual(sockets[1].frames.find((f) => f.type === "update_tools").tools.map((t) => t.path), ["/b"])
  assert.deepEqual((await callTool(sockets[1], "/b")).body, { value: "b" })
  s.close()
})

test("updateTools calls apply in order", async () => {
  reset(() => "ok")
  const s = await connect({ ...base })
  await Promise.all([s.updateTools([tool("/one", 1)]), s.updateTools([tool("/two", 2)]), s.updateTools([tool("/three", 3)])])
  assert.deepEqual(sockets[0].frames.filter((f) => f.type === "update_tools").map((f) => f.tools[0].path), ["/one", "/two", "/three"])
  assert.deepEqual((await callTool(sockets[0], "/three")).body, { value: 3 })
  assert.equal((await callTool(sockets[0], "/one")).status, 404)
  s.close()
})

test("updateTools rejects once the session is closed, including while waiting", async () => {
  reset(() => "ok")
  let retry
  const s = await connect({ ...base, onDisconnect: (i) => { retry = i.reconnect } })
  sockets[0].serverClose(1011, "blip")
  await waitFor(() => !s.connected && retry)
  const waiting = s.updateTools([tool("/b", "b")])
  s.close()
  await assert.rejects(waiting, /session closed/)
  await assert.rejects(s.updateTools([tool("/c", "c")]), /session closed/)
})
