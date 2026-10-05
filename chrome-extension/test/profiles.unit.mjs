// Unit tests for site-profile handling: validation, merging, agents.md
// (lib/profiles.js) and the registry client + AI tools (lib/registry.js),
// with fetch mocked. Also checks the built-in tool paths stay in sync with
// registry/src/rules.ts and that the registry's seed profiles stay valid.
// Run: node --test chrome-extension/test/profiles.unit.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildAgentsMd, findLocalProfile, isRegistryLookupHost, mergeSiteTools, normalizeLocalHost,
  normalizeRegistryHost, sourceLabel, validateProfile,
} from "../lib/profiles.js"
import { BASE_TOOL_PATHS, buildBaseTools } from "../lib/tools-base.js"
import { buildRegistryTools, fetchSiteProfile } from "../lib/registry.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const tool = (p, extra) => ({ path: p, description: `tool ${p}`, code: "return 1", ...extra })

test("registry host rules", () => {
  for (const [input, want] of [
    ["GitHub.com", "github.com"], ["github.com.", "github.com"], ["*", "*"], ["e2e-site.test", "e2e-site.test"],
    ["localhost", null], ["127.0.0.1", null], ["github.com:443", null], ["https://github.com", null], ["", null], [5, null], ["a..b.com", null],
  ]) assert.equal(normalizeRegistryHost(input), want, String(input))
  assert.equal(isRegistryLookupHost("github.com"), true)
  for (const h of ["*", "127.0.0.1", "localhost", "printer.local", "nas.lan", "x.internal", "r.home.arpa", "app.localhost", ""]) {
    assert.equal(isRegistryLookupHost(h), false, h)
  }
})

test("local host keys allow ports but nothing else", () => {
  assert.equal(normalizeLocalHost("LocalHost:3000"), "localhost:3000")
  assert.equal(normalizeLocalHost("github.com"), "github.com")
  assert.equal(normalizeLocalHost("[::1]:8080"), "[::1]:8080")
  for (const h of ["http://x.com", "x.com/path", "a b", "", null, "x.com:abc"]) assert.equal(normalizeLocalHost(h), null, String(h))
})

test("validateProfile mirrors the registry's submission rules", () => {
  const ok = validateProfile({ notes: "n\r\nx", tools: [tool("/a", { method: "get", input_schema: { type: "object" } })] }, BASE_TOOL_PATHS)
  assert.equal(ok.ok, true)
  assert.equal(ok.notes, "n\nx")
  assert.deepEqual(ok.tools, [{ method: "GET", path: "/a", description: "tool /a", input_schema: { type: "object" }, code: "return 1" }])

  const issues = (p) => { const v = validateProfile(p, BASE_TOOL_PATHS); assert.equal(v.ok, false); return v.issues.map((i) => `${i.path}: ${i.message}`).join("\n") }
  assert.match(issues({ tools: [tool("/eval")] }), /built-in/)
  assert.match(issues({ tools: [tool("/registry_submit")] }), /built-in/)
  assert.match(issues({ tools: [tool("/agents.md/x")] }), /reserved/)
  assert.match(issues({ tools: [tool("/_as_tasks")] }), /reserved/)
  assert.match(issues({ tools: [tool("nope")] }), /must match/)
  assert.match(issues({ tools: [tool("/a"), tool("/a", { method: "post" })] }), /duplicate tool POST \/a/)
  assert.match(issues({ tools: [{ path: "/a", description: "x" }] }), /code: required/)
  assert.match(issues({ tools: [tool("/a", { description: " " })] }), /description: required/)
  assert.match(issues({ tools: [tool("/a", { inputSchema: {} })] }), /inputSchema: unknown field/)
  assert.match(issues({ tools: [tool("/a", { method: "TRACE" })] }), /method: must be one of/)
  assert.match(issues({ tools: [tool("/a", { input_schema: [] })] }), /JSON Schema object/)
  assert.match(issues({ tools: Array.from({ length: 51 }, (_, i) => tool(`/t${i}`)) }), /at most 50/)
  assert.match(issues({ notes: "x".repeat(16 * 1024 + 1), tools: [] }), /notes: longer/)
  assert.match(issues({ tools: [tool("/a", { code: "x".repeat(32 * 1024 + 1) })] }), /code: longer/)
  assert.match(issues({ tools: "x" }), /tools: must be an array/)
})

test("mergeSiteTools: local wins on METHOD+path, unusable tools dropped", () => {
  const reg = [tool("/a", { code: "return 'reg-a'" }), tool("/b"), tool("/a", { code: "dup" }), tool("/eval"), { path: "/nocode", description: "x" }]
  const local = [tool("/a", { code: "return 'local-a'" }), tool("/c", { method: "get" }), tool("/tools.json")]
  const m = mergeSiteTools(reg, local, BASE_TOOL_PATHS)
  assert.deepEqual(m.tools.map((t) => `${t.method} ${t.path} ${t.source}`), ["POST /a local", "POST /b registry", "GET /c local"])
  assert.equal(m.tools[0].code, "return 'local-a'")
  assert.deepEqual(m.overridden, ["POST /a"])
  assert.deepEqual(m.dropped.sort(), ["POST /eval", "POST /nocode", "POST /tools.json"])
  assert.deepEqual(mergeSiteTools(null, undefined, BASE_TOOL_PATHS).tools, [])
})

test("findLocalProfile prefers host:port, then hostname", () => {
  const kept = { "localhost:3000": { host: "localhost:3000" }, "github.com": { host: "github.com" } }
  assert.equal(findLocalProfile(kept, "localhost:3000", "localhost").host, "localhost:3000")
  assert.equal(findLocalProfile(kept, "localhost:5173", "localhost"), null)
  assert.equal(findLocalProfile(kept, "github.com", "github.com").host, "github.com")
  assert.equal(findLocalProfile(kept, "github.com:8443", "github.com").host, "github.com")
  assert.equal(findLocalProfile(undefined, "a", "a"), null)
})

test("sourceLabel", () => {
  assert.equal(sourceLabel({ registry: { status: "ok", host: "github.com", version: 3 }, local: { count: 2 } }), "github.com v3 from registry · 2 local")
  assert.equal(sourceLabel({ registry: { status: "generic" }, local: null }), "generic profile (none for this site)")
  assert.equal(sourceLabel({ registry: { status: "unreachable" }, local: { count: 1 } }), "base only (registry unreachable) · 1 local")
  assert.equal(sourceLabel({ registry: { status: "none" } }), "base only")
  assert.equal(sourceLabel(null), "")
})

test("buildAgentsMd: notes, sources, workflow, and the 64 KB cap", () => {
  const tools = [{ method: "POST", path: "/page_info", description: "info\nmore" }]
  const md = buildAgentsMd({
    host: "github.com",
    registry: { status: "ok", profile: { host: "github.com", version: 3, notes: "REG NOTES" } },
    local: { host: "github.com", notes: "LOCAL NOTES", tools: [{}] },
    tools,
  })
  for (const s of ["REG NOTES", "LOCAL NOTES", "registry v3", "`POST /page_info` — info", "/registry_search", "/save_site_profile", "Keep", "/registry_submit"]) {
    assert.ok(md.includes(s), s)
  }
  assert.ok(!md.includes("more"), "only the first description line")
  assert.match(buildAgentsMd({ host: "x.com", registry: { status: "unreachable" }, local: null, tools }), /registry was unreachable/)
  assert.match(buildAgentsMd({ host: "x.com", registry: { status: "generic", profile: { host: "*", version: 1, notes: "GEN" } }, local: null, tools }), /generic profile[\s\S]*## Site notes \(generic\)\n\nGEN/)
  const big = buildAgentsMd({
    host: "x.com",
    registry: { status: "ok", profile: { host: "x.com", version: 1, notes: "r".repeat(16000) } },
    local: { host: "x.com", notes: "l".repeat(16000), tools: [] },
    tools: Array.from({ length: 120 }, (_, i) => ({ path: `/t${i}`, description: "d".repeat(4000) })),
  })
  assert.ok(new TextEncoder().encode(big).length < 64 * 1024, `agents.md ${big.length} bytes`)
})

test("BASE_TOOL_PATHS is exactly the registered built-ins, and the registry blocks all of them", () => {
  const deps = { getBase: () => "", getHostname: () => "", loadedHost: () => null, basePaths: BASE_TOOL_PATHS, extVersion: "0" }
  const actual = [...buildBaseTools({ getTabId: async () => null, savePendingProfile: async () => {} }), ...buildRegistryTools(deps)].map((t) => t.path)
  assert.deepEqual([...actual].sort(), [...BASE_TOOL_PATHS].sort())
  const rules = fs.readFileSync(path.join(ROOT, "registry/src/rules.ts"), "utf8")
  const block = rules.match(/BASE_TOOL_PATHS = new Set\(\[([\s\S]*?)\]\)/)[1]
  const registryPaths = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]))
  for (const p of BASE_TOOL_PATHS) assert.ok(registryPaths.has(p), `registry/src/rules.ts BASE_TOOL_PATHS is missing ${p}`)
})

test("the registry's seed profiles pass validation", () => {
  const dir = path.join(ROOT, "registry/seed")
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_index.json")
  assert.ok(files.length >= 5)
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
    const v = validateProfile(p, BASE_TOOL_PATHS)
    assert.ok(v.ok, `${f}: ${JSON.stringify(v.issues)}`)
  }
})

// ── registry client (fetch mocked) ─────────────────────────────────────

let requests = []
function mockFetch(handler) {
  requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const r = await handler(String(url), init)
    if (r instanceof Error) throw r
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } })
  }
}
const profile = (host, tools = [tool("/x")]) => ({ host, requested_host: host, version: 2, updated: "t", notes: `${host} notes`, tools: tools.map((t) => ({ method: "POST", ...t })) })

test("fetchSiteProfile: site, generic fallback, none, unreachable, timeout", async () => {
  mockFetch((url) => url.endsWith("/v1/sites/github.com") ? { body: profile("github.com") } : { status: 404, body: { error: { code: "not_found" } } })
  let r = await fetchSiteProfile("https://reg.example/", "GitHub.com")
  assert.equal(r.status, "ok")
  assert.equal(r.profile.host, "github.com")
  assert.equal(requests[0].url, "https://reg.example/v1/sites/github.com")
  assert.equal(requests[0].init.credentials, "omit")

  mockFetch((url) => url.endsWith("/v1/sites/*") ? { body: profile("*", []) } : { status: 404, body: {} })
  r = await fetchSiteProfile("https://reg.example", "example.org")
  assert.equal(r.status, "generic")
  assert.deepEqual(requests.map((q) => q.url), ["https://reg.example/v1/sites/example.org", "https://reg.example/v1/sites/*"])

  requests = []
  r = await fetchSiteProfile("https://reg.example", "127.0.0.1")
  assert.equal(r.status, "generic")
  assert.deepEqual(requests.map((q) => q.url), ["https://reg.example/v1/sites/*"], "a non-public hostname is never sent")

  mockFetch(() => ({ status: 404, body: {} }))
  assert.equal((await fetchSiteProfile("https://reg.example", "example.org")).status, "none")

  mockFetch(() => new TypeError("Failed to fetch"))
  r = await fetchSiteProfile("https://reg.example", "example.org")
  assert.equal(r.status, "unreachable")
  assert.match(r.error, /Failed to fetch/)

  mockFetch(() => ({ status: 503, body: {} }))
  assert.equal((await fetchSiteProfile("https://reg.example", "example.org")).status, "unreachable")

  mockFetch((_url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))))
  const t0 = Date.now()
  // AbortSignal.timeout's timer doesn't hold Node's event loop open; without
  // this the runner can exit before the abort fires (seen on Node 22).
  const keepAlive = setInterval(() => {}, 50)
  r = await fetchSiteProfile("https://reg.example", "example.org", 150)
  clearInterval(keepAlive)
  assert.equal(r.status, "unreachable")
  assert.match(r.error, /no answer in 150 ms/)
  assert.ok(Date.now() - t0 < 1000)
})

const regTools = (over) => Object.fromEntries(buildRegistryTools({
  getBase: async () => "https://reg.example/",
  getHostname: async () => "github.com",
  loadedHost: () => "github.com",
  basePaths: BASE_TOOL_PATHS,
  extVersion: "0.3.0",
  ...over,
}).map((t) => [t.path, t.handler]))
const call = (h, body) => h({ body: JSON.stringify(body) })

test("/registry_search: compact results, input checked", async () => {
  mockFetch(() => ({ body: { query: "issues", results: [{ host: "github.com", version: 2, tool_count: 3, summary: "s", tools: ["/a"], matched_tools: ["/a"] }] } }))
  const r = await call(regTools()["/registry_search"], { q: " issues ", limit: 99 })
  assert.deepEqual(r.results, [{ host: "github.com", version: 2, tool_count: 3, summary: "s", matched_tools: ["/a"], tools: ["/a"] }])
  assert.equal(requests[0].url, "https://reg.example/v1/search?q=issues&limit=50")
  assert.equal((await call(regTools()["/registry_search"], { q: "x" })).status, 400)
  mockFetch(() => new TypeError("Failed to fetch"))
  assert.equal((await call(regTools()["/registry_search"], { q: "abc" })).body.error.code, "registry_unreachable")
})

test("/registry_get: notes + tools without code by default; 404 → found:false", async () => {
  mockFetch(() => ({ body: profile("github.com", [tool("/a", { input_schema: { type: "object" } })]) }))
  let r = await call(regTools()["/registry_get"], {})
  assert.equal(requests[0].url, "https://reg.example/v1/sites/github.com", "defaults to the tab's hostname")
  assert.equal(r.loaded, true)
  assert.equal(r.notes, "github.com notes")
  assert.deepEqual(r.tools, [{ method: "POST", path: "/a", description: "tool /a", input_schema: { type: "object" } }])
  r = await call(regTools()["/registry_get"], { host: "github.com", include_code: true })
  assert.equal(r.tools[0].code, "return 1")
  mockFetch(() => ({ status: 404, body: { error: { code: "not_found" } } }))
  r = await call(regTools()["/registry_get"], { host: "nothing.example" })
  assert.equal(r.found, false)
  assert.equal((await call(regTools()["/registry_get"], { host: "http://x" })).status, 400)
})

test("/registry_submit: validates locally, then POSTs with ext_version", async () => {
  mockFetch(() => ({ status: 201, body: { id: "sub123", status: "pending" } }))
  const submit = regTools()["/registry_submit"]
  let r = await call(submit, { host: "github.com", tools: [tool("/eval")] })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body.error.issues), /built-in/)
  r = await call(submit, { host: "localhost", tools: [tool("/a")] })
  assert.equal(r.status, 400)
  r = await call(submit, { host: "github.com", tools: [tool("/a")], extra: 1 })
  assert.match(r.body.error.message, /unknown field/)
  r = await call(submit, { host: "github.com", tools: [] })
  assert.match(r.body.error.message, /empty profile/)
  assert.equal(requests.length, 0, "nothing sent for invalid input")

  r = await call(submit, { notes: "N", tools: [tool("/a", { method: "get" })] })
  assert.deepEqual({ submitted: r.submitted, id: r.id, status: r.status, host: r.host }, { submitted: true, id: "sub123", status: "pending", host: "github.com" })
  assert.equal(requests[0].url, "https://reg.example/v1/submissions")
  assert.equal(requests[0].init.headers["content-type"], "application/json")
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    host: "github.com", notes: "N", ext_version: "0.3.0",
    tools: [{ method: "GET", path: "/a", description: "tool /a", code: "return 1" }],
  })

  mockFetch(() => ({ status: 429, body: { error: { code: "rate_limited", message: "too many submissions, slow down" } } }))
  r = await call(submit, { host: "github.com", tools: [tool("/a")] })
  assert.equal(r.status, 429)
  assert.equal(r.body.error.code, "rate_limited")
  mockFetch(() => ({ status: 400, body: { error: { code: "invalid_submission", message: "m", issues: [{ path: "x", message: "y" }] } } }))
  r = await call(submit, { host: "github.com", tools: [tool("/a")] })
  assert.deepEqual(r.body.error.issues, [{ path: "x", message: "y" }])
})
