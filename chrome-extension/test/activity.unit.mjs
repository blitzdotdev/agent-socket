// Unit tests for lib/activity.js: what each detail level keeps, masking,
// truncation, and the store (prune, cap, delete) on a fake storage area.
//   node --test chrome-extension/test/activity.unit.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ENTRY_MAX_BYTES, MAX_ENTRIES, RETENTION_MS, createActivityStore, describeCall, entryKey, groupBySession,
  keyTime, keysToPrune, levelOf, matchesFilter, parseArgs, replyOf, sessionEntryIds,
} from "../lib/activity.js"

const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length

test("levelOf falls back to summary", () => {
  assert.equal(levelOf("full"), "full")
  assert.equal(levelOf("minimal"), "minimal")
  assert.equal(levelOf(undefined), "summary")
  assert.equal(levelOf("bogus"), "summary")
})

test("parseArgs / replyOf", () => {
  assert.deepEqual(parseArgs(""), {})
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 })
  assert.deepEqual(parseArgs("not json"), { _body: "not json" })
  assert.deepEqual(parseArgs("[1]"), { _body: [1] })
  assert.deepEqual(replyOf({ status: 403, body: { x: 1 } }), { status: 403, body: { x: 1 } })
  assert.deepEqual(replyOf({ clicked: true }), { status: 200, body: { clicked: true } })
  assert.deepEqual(replyOf(undefined), { status: 200, body: undefined })
})

test("summary: click uses the clicked element's text", () => {
  const d = describeCall({ path: "/click", args: { selector: "button.primary" }, result: { clicked: true, tag: "button", text: "Create repository" } })
  assert.equal(d.summary, 'click "Create repository"')
  assert.equal(d.status, 200)
  assert.equal(d.tool, "click")
  assert.deepEqual(d.detail.args, { selector: "button.primary" })
  assert.equal(d.detail.reply, undefined)
  const miss = describeCall({ path: "/click", args: { selector: "#nope" }, result: { clicked: false, reason: "only 0 matches for selector" } })
  assert.equal(miss.summary, "click #nope (only 0 matches for selector)")
})

test("summary: typed text is hidden, locators kept", () => {
  const d = describeCall({ path: "/fill", args: { selector: "#bio", value: "my secret bio", submit: true }, result: { filled: true, input_type: null, value_now: "my secret bio" } })
  assert.equal(d.summary, "fill #bio (13 chars) and submit")
  assert.deepEqual(d.detail.args, { selector: "#bio", value: "<13 chars>", submit: true })
  assert.ok(!JSON.stringify(d).includes("secret bio"))
})

test("summary: /eval code truncated to 200 chars; other string args become lengths", () => {
  const code = "return " + "x".repeat(400)
  const d = describeCall({ path: "/eval", args: { code, timeout_ms: 3000 }, result: { ok: 1 } })
  assert.ok(d.detail.args.code.startsWith("return xxx"))
  assert.ok(d.detail.args.code.length < 230 && /\(\+\d+ chars\)$/.test(d.detail.args.code))
  assert.equal(d.detail.args.timeout_ms, 3000)
  assert.ok(d.summary.startsWith("eval: return xxx") && d.summary.length < 120)
  const site = describeCall({ path: "/x_post_now", args: { text: "hello world", count: 3, tags: ["a"] }, result: { ok: true } })
  assert.deepEqual(site.detail.args, { text: "<11 chars>", count: "<number>", tags: "<1 items>" })
  assert.equal(site.summary, "x_post_now text: 11 chars")
})

test("summary: secret-looking locator keys are still hidden", () => {
  const d = describeCall({ path: "/login_tool", args: { url: "https://a.test", password: "hunter2" } })
  assert.deepEqual(d.detail.args, { url: "https://a.test", password: "<7 chars>" })
})

test("full: args and reply kept, password fields always masked", () => {
  const d = describeCall({ level: "full", path: "/fill", args: { selector: "#email", value: "a@b.test" }, result: { filled: true, input_type: "email", value_now: "a@b.test" } })
  assert.equal(d.summary, 'fill #email "a@b.test"')
  assert.deepEqual(d.detail.args, { selector: "#email", value: "a@b.test" })
  assert.equal(d.detail.reply.value_now, "a@b.test")

  const pw = describeCall({ level: "full", path: "/fill", args: { selector: "#pw", value: "hunter22" }, result: { filled: true, input_type: "password", value_now: "hunter22" } })
  assert.equal(pw.summary, "fill #pw (8 chars, password)")
  assert.equal(pw.detail.args.value, "<hidden: 8 chars>")
  assert.equal(pw.detail.reply.value_now, "<hidden: 8 chars>")
  assert.ok(!JSON.stringify(pw).includes("hunter22"))

  const tok = describeCall({ level: "full", path: "/api", args: { api_token: "abc123", note: "hi" } })
  assert.equal(tok.detail.args.api_token, "<hidden: 6 chars>")
  assert.equal(tok.detail.args.note, "hi")
})

test("full: /fill shows the value only once its reply names a non-password field", () => {
  const area = describeCall({ level: "full", path: "/fill", args: { selector: "#bio", value: "my bio" }, result: { filled: true, tag: "textarea", input_type: null, value_now: "my bio" } })
  assert.equal(area.summary, 'fill #bio "my bio"')
  assert.equal(area.detail.args.value, "my bio")
  const unknown = [
    { result: { filled: false, reason: "no match" } },
    { result: { filled: false, reason: "element is not editable: DIV" } },
    { result: { status: 403, body: { error: { code: "origin_not_allowed", message: "paused" } } } },
    { result: { status: 400, body: { error: { code: "bad_input", message: "m" } } } },
    { result: { error: { code: "runtime_error", message: "Cannot access a chrome:// URL" } } },
    { result: undefined },
    { error: new Error("boom") },
  ]
  for (const c of unknown) {
    const d = describeCall({ level: "full", path: "/fill", args: { selector: "#pw", value: "hunter22" }, ...c })
    assert.equal(d.summary, "fill #pw (8 chars)", JSON.stringify(c))
    assert.equal(d.detail.args.value, "<hidden: 8 chars>")
    assert.ok(!JSON.stringify(d).includes("hunter22"), JSON.stringify(d))
  }
})

test("full: screenshots become [image N KB], long replies truncated, entry capped", () => {
  const png = "data:image/png;base64," + "A".repeat(400_000)
  const shot = describeCall({ level: "full", path: "/screenshot", args: {}, result: { data_url: png, width: 10 } })
  assert.equal(shot.detail.reply.data_url, "[image 293 KB]")
  const big = describeCall({ level: "full", path: "/get_html", args: { selector: "body" }, result: { html: "<p>".repeat(5000) } })
  assert.ok(bytes(big) < ENTRY_MAX_BYTES, `entry ${bytes(big)} bytes`)
  const hugeArgs = describeCall({ level: "full", path: "/eval", args: { code: "y".repeat(50_000) }, result: "z".repeat(50_000) })
  assert.ok(bytes(hugeArgs) < ENTRY_MAX_BYTES, `entry ${bytes(hugeArgs)} bytes`)
})

test("minimal: tool and status only", () => {
  const d = describeCall({ level: "minimal", path: "/fill", args: { selector: "#a", value: "typed" }, result: { status: 400, body: { error: { code: "bad_input", message: "m" } } } })
  assert.equal(d.summary, "fill")
  assert.equal(d.status, 400)
  assert.equal(d.error, "bad_input")
  assert.equal(d.detail, undefined)
  assert.equal(d.message, undefined)
  assert.ok(!JSON.stringify(d).includes("#a"))
})

test("refusals and thrown errors", () => {
  const r = describeCall({ path: "/page_info", result: { status: 403, body: { error: { code: "origin_not_allowed", message: "The tab is now on x.test" } } } })
  assert.equal(r.status, 403)
  assert.equal(r.error, "origin_not_allowed")
  assert.equal(r.message, "The tab is now on x.test")
  const t = describeCall({ path: "/eval", args: { code: "1" }, error: new Error("boom") })
  assert.equal(t.status, 500)
  assert.equal(t.error, "handler_error")
  assert.equal(t.message, "boom")
})

test("keys sort by time and prune by age and count", () => {
  const now = 10 * RETENTION_MS
  assert.equal(keyTime(entryKey(1234, "r")), 1234)
  assert.ok(entryKey(9, "a") < entryKey(10, "a"))
  const old = entryKey(now - RETENTION_MS - 1, "old")
  const fresh = Array.from({ length: 5 }, (_, i) => entryKey(now - i, `f${i}`))
  assert.deepEqual(keysToPrune([...fresh, old, "kept_profiles"], now), [old])
  const over = keysToPrune(fresh, now, { max: 3 })
  assert.deepEqual(over, [entryKey(now - 4, "f4"), entryKey(now - 3, "f3")])
})

test("groupBySession: newest first, host and ending from session events", () => {
  const es = [
    { id: "a1", at: 1, kind: "session", event: "connected", session: "S1", host: "a.test" },
    { id: "a2", at: 2, kind: "call", session: "S1", host: "a.test", tool: "click" },
    { id: "a3", at: 3, kind: "session", event: "stopped", session: "S1", host: "a.test" },
    { id: "b1", at: 4, kind: "call", session: "S2", host: "b.test", tool: "eval" },
  ]
  const g = groupBySession(es)
  assert.deepEqual(g.map((x) => x.session), ["S2", "S1"])
  assert.equal(g[1].host, "a.test")
  assert.equal(g[1].ending, "stopped")
  assert.equal(g[1].start, 1)
  assert.deepEqual(g[1].entries.map((e) => e.id), ["a3", "a2", "a1"])
  assert.equal(g[0].ending, null)
  assert.ok(matchesFilter(es[1], "CLICK"))
  assert.ok(!matchesFilter(es[1], "eval"))
})

test("sessionEntryIds: every entry of the session, whatever the filter shows", () => {
  const es = [
    { id: "a1", at: 1, kind: "session", event: "connected", session: "S1", host: "a.test" },
    { id: "a2", at: 2, kind: "call", session: "S1", host: "a.test", tool: "click", summary: "click #go" },
    { id: "a3", at: 3, kind: "call", session: "S1", host: "a.test", tool: "eval", summary: "eval: 1" },
    { id: "b1", at: 4, kind: "call", session: "S2", host: "b.test", tool: "click", summary: "click #x" },
    { id: "n1", at: 5, kind: "call", session: null, host: "c.test", tool: "click" },
    { id: "n2", at: 6, kind: "call", host: "c.test", tool: "click" },
  ]
  const [g] = groupBySession(es.filter((e) => matchesFilter(e, "eval")))
  assert.deepEqual(g.entries.map((e) => e.id), ["a3"])
  assert.deepEqual(sessionEntryIds(es, g.session).sort(), ["a1", "a2", "a3"])
  const none = groupBySession(es).find((x) => x.session === null)
  assert.deepEqual(sessionEntryIds(es, none.session).sort(), ["n1", "n2"])
})

function fakeArea() {
  const data = new Map()
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.fromEntries(data)
      return Object.fromEntries([keys].flat().filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]))
    },
    async set(o) { for (const [k, v] of Object.entries(o)) data.set(k, structuredClone(v)) },
    async remove(ks) { for (const k of [ks].flat()) data.delete(k) },
    async getKeys() { return [...data.keys()] },
  }
}

test("store: add, list newest first, remove, clear; other keys untouched", async () => {
  const area = fakeArea()
  await area.set({ kept_profiles: { x: 1 } })
  let t = 1000
  const store = createActivityStore(area, { now: () => t++ })
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(await store.add({ kind: "call", tool: `t${i}` }))
  assert.deepEqual((await store.list()).map((e) => e.tool), ["t4", "t3", "t2", "t1", "t0"])
  assert.deepEqual((await store.list(2)).map((e) => e.tool), ["t4", "t3"])
  await store.remove(ids[2])
  assert.deepEqual((await store.list()).map((e) => e.tool), ["t4", "t3", "t1", "t0"])
  await store.remove(["kept_profiles"])  // not an entry key: ignored
  await store.clear()
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await area.get("kept_profiles"), { kept_profiles: { x: 1 } })
})

test("store: prune drops >7-day entries; the cap drops the oldest", async () => {
  const area = fakeArea()
  let t = 100 * RETENTION_MS
  const store = createActivityStore(area, { now: () => t })
  await store.add({ kind: "call", tool: "old", at: t - RETENTION_MS - 5 })
  await store.add({ kind: "call", tool: "new" })
  assert.equal(await store.prune(), 1)
  assert.deepEqual((await store.list()).map((e) => e.tool), ["new"])
  for (let i = 0; i < MAX_ENTRIES + 5; i++) { t++; await store.add({ kind: "call", tool: `n${i}` }) }
  const keys = await store.keys()
  assert.ok(keys.length <= MAX_ENTRIES, `${keys.length} entries`)
  assert.equal((await store.list(1))[0].tool, `n${MAX_ENTRIES + 4}`)
})

test("store: find searches back past the newest entries, newest first, reading only as far as it needs", async () => {
  const area = fakeArea()
  let t = 1000
  const store = createActivityStore(area, { now: () => t++ })
  for (let i = 0; i < 3; i++) await store.add({ kind: "call", session: "MINE", tool: `m${i}` })
  for (let i = 0; i < 450; i++) await store.add({ kind: "call", session: "OTHER", tool: `o${i}` })
  await store.add({ kind: "session", session: "MINE", event: "timer_set" })
  const mine = (e) => e.kind === "call" && e.session === "MINE"
  assert.deepEqual((await store.list(200)).filter(mine), [])  // what the popup used to search
  let reads = 0
  const get = area.get
  area.get = (ks) => { reads++; return get(ks) }
  assert.deepEqual((await store.find(mine, 3)).map((e) => e.tool), ["m2", "m1", "m0"])
  assert.equal(reads, 3)
  reads = 0
  assert.deepEqual((await store.find(mine, 2)).map((e) => e.tool), ["m2", "m1"])
  assert.equal(reads, 3)
  reads = 0
  assert.deepEqual((await store.find((e) => e.kind === "call", 3)).map((e) => e.tool), ["o449", "o448", "o447"])
  assert.equal(reads, 1)
  assert.deepEqual(await store.find(() => false, 3), [])
  await store.clear()
  assert.deepEqual(await store.find(mine, 3), [])
})

test("store: works without getKeys (older Chrome)", async () => {
  const area = fakeArea()
  delete area.getKeys
  const store = createActivityStore(area)
  await store.add({ kind: "call", tool: "a" })
  assert.equal((await store.list()).length, 1)
})
