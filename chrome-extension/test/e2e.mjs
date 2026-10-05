// End-to-end test for the Chrome extension.
//
// Pipeline:
//   1. Start agent-socket relay (wrangler dev on :RELAY_PORT, DEBUG=1)
//   2. Start a tiny static HTTP server for the test page on :STATIC_PORT; it
//      also serves a mock tool registry under /registry (same JSON API as
//      registry/: /v1/sites/:host, /v1/search, /v1/submissions, CORS *)
//   3. Launch headed Chromium under Xvfb with our extension loaded
//   4. Discover the extension's ID by listening for the SW target's URL
//   5. Open the test page in a tab, focus it; open the popup as a sibling tab
//      (the popup page is a normal extension context with full chrome.* API
//      access — and crucially, it keeps the SW alive for the duration)
//   6. Drive `chrome.runtime.sendMessage({ type: "connect" })` from the popup
//   7. Hammer the resulting agent token URL with HTTPS tool calls and verify
//      page state changes as expected
//
// Run: xvfb-run -a node chrome-extension/test/e2e.mjs

import { spawn } from "node:child_process"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer-core"
import { EXT_DIR, testExtensionDir } from "./ext-dir.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"
const RELAY_PORT = parseInt(process.env.RELAY_PORT ?? "8794", 10)
const STATIC_PORT = parseInt(process.env.STATIC_PORT ?? "8795", 10)
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`
const REGISTRY_BASE = `http://127.0.0.1:${STATIC_PORT}/registry`
// The registry only knows public-looking hostnames, so the test page is
// opened under these names; Chromium resolves them to 127.0.0.1.
const SITE_HOST = "e2e-site.test"
const GENERIC_SITE_HOST = "no-profile.test"

// ── runner ────────────────────────────────────────────────────────────
let passed = 0, failed = 0
const failures = []
async function step(name, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    passed++
    console.log(`  PASS ${name.padEnd(52)} (${Date.now() - t0}ms)`)
    return r
  } catch (e) {
    failed++
    failures.push({ name, error: e })
    console.log(`  FAIL ${name.padEnd(52)} (${Date.now() - t0}ms)`)
    console.log(`       ${e?.message ?? e}`)
    throw e
  }
}

// ── relay ─────────────────────────────────────────────────────────────
async function waitForRelay(deadline = Date.now() + 30000) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${RELAY_BASE}/_debug/health`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("relay never became ready")
}

function startRelay() {
  const logFile = "/tmp/as-ext-wrangler.log"
  try { fs.unlinkSync(logFile) } catch {}
  const out = fs.openSync(logFile, "w")
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(RELAY_PORT), "--ip", "127.0.0.1", "--var", "DEBUG:1", ...(process.env.INSPECTOR_PORT ? ["--inspector-port", process.env.INSPECTOR_PORT] : [])],
    { cwd: path.join(ROOT, "relay"), stdio: ["ignore", out, out], env: { ...process.env, FORCE_COLOR: "0" }, detached: true },
  )
  return {
    child,
    log: logFile,
    stop: () => new Promise((resolve) => {
      child.__stopped = true
      child.on("exit", () => resolve())
      try { process.kill(-child.pid, "SIGTERM") } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {}; resolve() }, 3000)
    }),
  }
}

// ── mock registry ─────────────────────────────────────────────────────
// Answers like registry/src/api.ts. `mode`: "ok", or "hang" (never answers,
// so the extension's Connect timeout is what ends the wait).
const registry = {
  mode: "ok",
  requests: [],
  submissions: [],
  sites: {
    [SITE_HOST]: {
      host: SITE_HOST, version: 2, updated: "2026-10-01 00:00:00",
      notes: "E2E REGISTRY NOTES: the counter lives in #counter.",
      tools: [
        { method: "POST", path: "/reg_counter", description: "Read the counter (registry version).", input_schema: { type: "object", properties: {} }, code: "return { from: 'registry', value: Number(document.getElementById('counter').textContent) }" },
        { method: "POST", path: "/reg_title", description: "Read the page heading.", code: "return document.getElementById('page-title').textContent" },
      ],
    },
    "*": { host: "*", version: 1, updated: "2026-10-01 00:00:00", notes: "E2E GENERIC NOTES: no site profile.", tools: [] },
  },
}

function registryHandler(req, res, url) {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
    res.end(JSON.stringify(body))
  }
  let raw = ""
  req.on("data", (c) => { raw += c })
  req.on("end", () => {
    const p = url.pathname.replace(/^\/registry/, "")
    registry.requests.push({ method: req.method, path: p, search: url.search, headers: req.headers, body: raw })
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type" })
      return res.end()
    }
    if (registry.mode === "hang") return  // the connection stays open until the server stops
    const site = p.match(/^\/v1\/sites\/([^/]+)$/)
    if (req.method === "GET" && site) {
      const host = decodeURIComponent(site[1])
      const profile = registry.sites[host]
      return profile ? send(200, { ...profile, requested_host: host }) : send(404, { error: { code: "not_found", message: `no approved profile for ${host}` } })
    }
    if (req.method === "GET" && p === "/v1/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase()
      const results = Object.values(registry.sites).filter((s) => s.host !== "*")
        .filter((s) => s.host.includes(q) || s.notes.toLowerCase().includes(q) || s.tools.some((t) => (t.path + t.description).toLowerCase().includes(q)))
        .map((s) => ({ host: s.host, version: s.version, tool_count: s.tools.length, summary: s.notes.split("\n")[0], tools: s.tools.map((t) => t.path), matched_tools: s.tools.filter((t) => (t.path + t.description).toLowerCase().includes(q)).map((t) => t.path) }))
      return send(200, { query: q, results })
    }
    if (req.method === "POST" && p === "/v1/submissions") {
      let body
      try { body = JSON.parse(raw) } catch { return send(400, { error: { code: "invalid_json", message: "body is not valid JSON" } }) }
      if (!/^application\/json/.test(req.headers["content-type"] ?? "")) return send(415, { error: { code: "unsupported_media_type" } })
      if (typeof body.host !== "string" || !Array.isArray(body.tools)) return send(400, { error: { code: "invalid_submission", issues: [] } })
      const id = `sub_${registry.submissions.length + 1}`
      registry.submissions.push({ id, body, userAgent: req.headers["user-agent"] })
      return send(201, { id, status: "pending" })
    }
    send(404, { error: { code: "not_found", message: "no such endpoint" } })
  })
}

// ── static page server ────────────────────────────────────────────────
function startStatic() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    if (url.pathname.startsWith("/registry/")) return registryHandler(req, res, url)
    let fp = path.join(EXT_DIR, "test", url.pathname.replace(/^\/+/, ""))
    if (!fp.startsWith(EXT_DIR)) { res.writeHead(403).end(); return }
    try {
      const s = fs.statSync(fp)
      if (s.isDirectory()) fp = path.join(fp, "index.html")
    } catch { res.writeHead(404).end("not found"); return }
    let body
    try { body = fs.readFileSync(fp) } catch { res.writeHead(404).end(); return }
    const ext = path.extname(fp).toLowerCase()
    const ct = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[ext] ?? "application/octet-stream"
    res.writeHead(200, { "content-type": `${ct}; charset=utf-8` })
    res.end(body)
  })
  return new Promise((resolve) => srv.listen(STATIC_PORT, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${STATIC_PORT}`,
    stop: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections() }),
  })))
}

// ── chrome ────────────────────────────────────────────────────────────
async function launchChrome(extDir) {
  const userDataDir = fs.mkdtempSync("/tmp/as-ext-profile-")
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=Translate,InterestFeedContentSuggestions",
      "--no-first-run",
      "--no-default-browser-check",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
      `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1, MAP ${GENERIC_SITE_HOST} 127.0.0.1`,
    ],
    defaultViewport: null,
  })
  return { browser, userDataDir }
}

async function waitForExtensionId(browser, timeout = 10000) {
  // The SW target appears (briefly) as a `targetcreated` event whose URL is
  // `chrome-extension://<EXTID>/background.js`. We snag the ID from there.
  return new Promise((resolve, reject) => {
    let resolved = false
    const onTarget = (t) => {
      if (resolved) return
      if (t.type() === "service_worker" && t.url().endsWith("/background.js")) {
        resolved = true
        browser.off("targetcreated", onTarget)
        resolve(new URL(t.url()).host)
      }
    }
    browser.on("targetcreated", onTarget)
    setTimeout(() => {
      if (resolved) return
      browser.off("targetcreated", onTarget)
      reject(new Error(`no service_worker target after ${timeout}ms`))
    }, timeout)
  })
}

// ── popup-driven IPC into the SW ──────────────────────────────────────
// The popup page is a normal extension context — full access to chrome.*.
// We send messages to the SW via chrome.runtime.sendMessage and await replies.

function sendToSW(popupPage, msg) {
  return popupPage.evaluate((m) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(m, (response) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve(response)
    })
  }), msg)
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[setup] launching\n        relay  → ${RELAY_BASE}\n        static → http://127.0.0.1:${STATIC_PORT}`)
  const relay = startRelay()
  let staticSrv, browser, userDataDir, userDataDir2, extDir
  try {
    staticSrv = await startStatic()
    await waitForRelay()
    console.log("[setup] relay ready")

    const launch = await launchChrome(extDir = testExtensionDir())
    browser = launch.browser; userDataDir = launch.userDataDir
    const extId = await waitForExtensionId(browser)
    console.log(`[setup] extension id: ${extId}`)

    // Open the test page first.
    const testUrl = `http://${SITE_HOST}:${STATIC_PORT}/test-page.html`
    const testPage = await browser.newPage()
    await testPage.goto(testUrl, { waitUntil: "load" })
    console.log(`[setup] test page loaded`)

    // Open the popup as a sibling tab. The popup is a normal extension context;
    // opening it as a tab keeps it alive and re-wakes the SW reliably.
    const popupPage = await browser.newPage()
    await popupPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" })
    // Bring the test page back to the front so it's the "active tab" for the SW.
    await testPage.bringToFront()
    // Belt and braces: ask chrome.tabs to set the test tab active.
    await sendToSW(popupPage, { type: "set_relay_base", base: RELAY_BASE })
    await sendToSW(popupPage, { type: "set_registry_base", base: REGISTRY_BASE })
    await popupPage.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({})
      const t = tabs.find((t) => (t.url ?? "").startsWith(url))
      if (t) await chrome.tabs.update(t.id, { active: true })
    }, testUrl)

    console.log("\n[test] running…\n")

    // ── 1. Connect ─────────────────────────────────────────────────
    const connectInfo = await step("popup → SW: connect + mint token", async () => {
      const r = await sendToSW(popupPage, { type: "connect" })
      if (!r?.ok) throw new Error(`connect failed: ${JSON.stringify(r)}`)
      if (!r.url || !r.url.startsWith(RELAY_BASE)) throw new Error(`bad url: ${r.url}`)
      return r
    })

    await step("Connect fetched the site's registry profile (hostname only)", async () => {
      const gets = registry.requests.filter((q) => q.method === "GET" && q.path.startsWith("/v1/sites/"))
      if (gets.map((q) => q.path).join(",") !== `/v1/sites/${SITE_HOST}`) throw new Error(`registry requests: ${gets.map((q) => q.path)}`)
      const src = connectInfo.source?.registry
      if (src?.status !== "ok" || src.host !== SITE_HOST || src.version !== 2) throw new Error(JSON.stringify(connectInfo.source))
      if (connectInfo.source.local !== null) throw new Error("unexpected local profile")
    })
    console.log(`       url:        ${connectInfo.url}`)
    console.log(`       host bound: ${connectInfo.host}`)
    console.log(`       tools:      ${connectInfo.tool_count}`)
    const tokenBase = connectInfo.url.replace(/\/agents\.md.*$/, "")

    // Helper that does what an external AI chat would do. Resolves
    // tokenBase lazily so we can swap it after a reconnect.
    let activeTokenBase = tokenBase
    async function callTool(p, body, method = "POST") {
      const r = await fetch(`${activeTokenBase}${p}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body == null ? undefined : JSON.stringify(body),
      })
      const text = await r.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch {}
      return { status: r.status, json, text }
    }

    // ── 2. Meta endpoints ─────────────────────────────────────────
    await step("GET /agents.md returns the briefing", async () => {
      const r = await fetch(`${tokenBase}/agents.md`)
      if (r.status !== 200) throw new Error(`status ${r.status}`)
      const t = await r.text()
      if (!/Agent Socket/.test(t)) throw new Error("missing header")
      if (!/page_info/.test(t)) throw new Error("missing tool list")
      if (!t.includes("E2E REGISTRY NOTES")) throw new Error("missing registry notes")
      if (!t.includes(`registry profile for **${SITE_HOST}** (v2`)) throw new Error("missing profile source")
      if (!/registry_search[\s\S]*save_site_profile[\s\S]*Keep[\s\S]*registry_submit/.test(t)) throw new Error("missing workflow")
    })

    const BASE_PATHS = ["/eval", "/page_info", "/dom_query", "/click", "/fill", "/wait_for", "/navigate", "/scroll",
      "/get_text", "/get_html", "/screenshot", "/save_site_profile", "/registry_search", "/registry_get", "/registry_submit"]
    const toolPaths = async (base) => (await (await fetch(`${base}/tools.json`)).json()).tools.map((t) => t.path)
    const sameSet = (a, b) => [...a].sort().join(",") === [...b].sort().join(",")

    await step("GET /tools.json lists the universal + registry tools", async () => {
      const have = await toolPaths(tokenBase)
      if (!sameSet(have, [...BASE_PATHS, "/reg_counter", "/reg_title"])) throw new Error(`tools: ${have}`)
    })

    await step("registry tool runs in the page", async () => {
      const { status, json } = await callTool("/reg_counter", {})
      if (status !== 200 || json?.value?.from !== "registry" || json.value.value !== 0) throw new Error(`${status} ${JSON.stringify(json)}`)
    })

    // ── 3. Page info / DOM tools ──────────────────────────────────
    await step("POST /page_info reflects the test page", async () => {
      const { status, json } = await callTool("/page_info", {})
      if (status !== 200) throw new Error(`status ${status}`)
      if (!json.url?.includes("test-page.html")) throw new Error(`url=${json.url}`)
      if (!/E2E Test Page/.test(json.title)) throw new Error(`title=${json.title}`)
      if (json.host !== `${SITE_HOST}:${STATIC_PORT}`) throw new Error(`host=${json.host}`)
    })

    await step("POST /eval reads page state", async () => {
      const { json } = await callTool("/eval", { code: "return document.getElementById('counter').textContent" })
      if (json.value !== "0") throw new Error(`got ${JSON.stringify(json)}`)
    })

    await step("POST /eval handles thrown errors", async () => {
      const { json, status } = await callTool("/eval", { code: "throw new Error('boom')" })
      if (status !== 500 || json?.error?.code !== "runtime_error") {
        throw new Error(`expected 500 runtime_error, got ${status} ${JSON.stringify(json)}`)
      }
    })

    await step("POST /eval supports await", async () => {
      const { json } = await callTool("/eval", {
        code: "await new Promise(r=>setTimeout(r,50)); return location.pathname",
      })
      if (!json.value?.endsWith("test-page.html")) throw new Error(`got ${JSON.stringify(json)}`)
    })

    await step("POST /dom_query finds buttons with attrs", async () => {
      const { json } = await callTool("/dom_query", { selector: "button", limit: 20 })
      if (json.total < 5) throw new Error(`buttons=${json.total}`)
      const texts = json.matches.map((m) => m.text)
      if (!texts.includes("Increment")) throw new Error(`missing Increment: ${texts.join("|")}`)
    })

    // ── 4. Interaction tools ───────────────────────────────────────
    await step("POST /click increments counter", async () => {
      const { json } = await callTool("/click", { selector: "#inc-btn" })
      if (!json.clicked) throw new Error(`not clicked: ${JSON.stringify(json)}`)
      const v = await testPage.evaluate(() => document.getElementById("counter").textContent)
      if (v !== "1") throw new Error(`counter=${v}`)
    })

    await step("POST /click chain → counter=4", async () => {
      for (let i = 0; i < 3; i++) await callTool("/click", { selector: "#inc-btn" })
      const v = await testPage.evaluate(() => document.getElementById("counter").textContent)
      if (v !== "4") throw new Error(`counter=${v}`)
    })

    await step("POST /fill name + email + bio", async () => {
      await callTool("/fill", { selector: "#name-input", value: "Ada" })
      await callTool("/fill", { selector: "#email-input", value: "ada@lovelace.dev" })
      await callTool("/fill", { selector: "#bio-input", value: "Inventor of the loop." })
      const got = await testPage.evaluate(() => ({
        name: document.getElementById("name-input").value,
        email: document.getElementById("email-input").value,
        bio: document.getElementById("bio-input").value,
      }))
      if (got.name !== "Ada" || got.email !== "ada@lovelace.dev" || !/loop/.test(got.bio)) {
        throw new Error(`fills: ${JSON.stringify(got)}`)
      }
    })

    await step("POST /click submit + verify submitted data", async () => {
      await callTool("/click", { selector: "#submit-btn" })
      const submitted = await testPage.evaluate(() => document.getElementById("submitted-data").textContent)
      const p = JSON.parse(submitted)
      if (p.name !== "Ada" || p.email !== "ada@lovelace.dev") throw new Error(submitted)
    })

    await step("POST /click reveal + /wait_for delayed reveal", async () => {
      await callTool("/click", { selector: "#reveal-btn" })
      const { json } = await callTool("/wait_for", { selector: "#revealed:not(.hidden)", timeout_ms: 3000 })
      if (!json.found) throw new Error(`wait_for didn't find: ${JSON.stringify(json)}`)
    })

    await step("POST /get_text reads revealed secret", async () => {
      const { json } = await callTool("/get_text", { selector: "#revealed" })
      if (!/swordfish/.test(json.text)) throw new Error(`text=${json.text}`)
    })

    await step("POST /get_html returns outerHTML", async () => {
      const { json } = await callTool("/get_html", { selector: "#counter" })
      if (!/id="counter"/.test(json.html)) throw new Error(`html=${json.html}`)
    })

    await step("dynamic list: delete + add via /click + /dom_query", async () => {
      const before = await testPage.evaluate(() => document.querySelectorAll("#item-list li").length)
      await callTool("/click", { selector: '.delete-btn[data-id="1"]' })
      const after = await testPage.evaluate(() => document.querySelectorAll("#item-list li").length)
      if (after !== before - 1) throw new Error(`expected ${before - 1}, got ${after}`)
      await callTool("/click", { selector: "#add-item-btn" })
      await callTool("/click", { selector: "#add-item-btn" })
      const { json } = await callTool("/dom_query", { selector: "#item-list li", limit: 50 })
      const texts = json.matches.map((m) => m.text)
      if (!texts.some((t) => /Item-4/.test(t))) throw new Error(`Item-4 missing`)
      if (!texts.some((t) => /Item-5/.test(t))) throw new Error(`Item-5 missing`)
    })

    await step("POST /scroll into view", async () => {
      const { json } = await callTool("/scroll", { selector: "#submit-btn" })
      if (!json.scrolled) throw new Error(JSON.stringify(json))
    })

    // ── 6. Screenshot ──────────────────────────────────────────────
    await step("POST /screenshot returns a PNG data URL", async () => {
      const { status, json } = await callTool("/screenshot", {})
      if (status !== 200) throw new Error(`status ${status}`)
      if (!json.data_url?.startsWith("data:image/png;base64,")) {
        throw new Error(`bad data url: ${String(json.data_url).slice(0, 80)}`)
      }
    })

    // ── 7. Registry tools + local profiles ──────────────────────────
    const swSnap = () => sendToSW(popupPage, { type: "snapshot" })
    const until = async (cond, ms = 5000) => {
      const end = Date.now() + ms
      while (!(await cond())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 100)) }
    }
    const localHost = `${SITE_HOST}:${STATIC_PORT}`
    const popupText = (sel) => popupPage.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel)
    // The popup tab sits behind the test page, and puppeteer's mouse click
    // waits for rendering a background tab never does; a DOM click runs the
    // same listener.
    const clickInPopup = async (sel) => {
      await popupPage.waitForSelector(sel, { timeout: 5000 })
      await popupPage.$eval(sel, (n) => n.click())
    }

    await step("/registry_search returns compact hits", async () => {
      const { status, json } = await callTool("/registry_search", { q: "counter" })
      if (status !== 200) throw new Error(`${status} ${JSON.stringify(json)}`)
      const hit = json.results?.[0]
      if (hit?.host !== SITE_HOST || hit.tool_count !== 2 || !hit.matched_tools.includes("/reg_counter")) throw new Error(JSON.stringify(json))
      if ("code" in hit) throw new Error("search leaked code")
      const q = registry.requests.at(-1)
      if (q.path !== "/v1/search" || !q.search.includes("q=counter")) throw new Error(JSON.stringify(q))
      if ((await callTool("/registry_search", { q: "x" })).status !== 400) throw new Error("1-char q accepted")
    })

    await step("/registry_get: tab's host by default, code only on request", async () => {
      const { json } = await callTool("/registry_get", {})
      if (!json.found || json.host !== SITE_HOST || json.loaded !== true || !/E2E REGISTRY NOTES/.test(json.notes)) throw new Error(JSON.stringify(json))
      if (json.tools.length !== 2 || json.tools.some((t) => "code" in t)) throw new Error(JSON.stringify(json.tools))
      const withCode = (await callTool("/registry_get", { host: SITE_HOST, include_code: true })).json
      if (!withCode.tools.every((t) => typeof t.code === "string")) throw new Error("no code with include_code")
      const missing = (await callTool("/registry_get", { host: "nothing-here.test" })).json
      if (missing.found !== false) throw new Error(JSON.stringify(missing))
    })

    await step("/registry_submit validates locally, then creates a pending submission", async () => {
      const bad = await callTool("/registry_submit", { host: SITE_HOST, tools: [{ path: "/eval", description: "x", code: "return 1" }] })
      if (bad.status !== 400 || !/built-in/.test(JSON.stringify(bad.json?.error?.issues))) throw new Error(`${bad.status} ${JSON.stringify(bad.json)}`)
      if (registry.submissions.length !== 0) throw new Error("invalid submission was sent")
      const { status, json } = await callTool("/registry_submit", {
        notes: "Counter page.",
        tools: [{ path: "/read_counter", description: "Read the counter.", code: "return Number(document.getElementById('counter').textContent)" }],
      })
      if (status !== 200 || !json.submitted || json.status !== "pending" || json.id !== "sub_1" || json.host !== SITE_HOST) throw new Error(`${status} ${JSON.stringify(json)}`)
      const sub = registry.submissions[0]
      if (sub.body.host !== SITE_HOST || sub.body.ext_version !== "0.3.0" || sub.body.tools[0].method !== "POST" || sub.body.notes !== "Counter page.") throw new Error(JSON.stringify(sub.body))
      if (!/Chrome/.test(sub.userAgent ?? "")) throw new Error(`user agent: ${sub.userAgent}`)
    })

    const savedTools = [
      { path: "/get_counter", description: "Read the current counter value as a number.", input_schema: { type: "object", properties: {} },
        code: "return Number(document.getElementById('counter').textContent);" },
      { path: "/inc_n", description: "Click increment N times.", input_schema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
        code: "for (let i = 0; i < args.n; i++) document.getElementById('inc-btn').click(); return Number(document.getElementById('counter').textContent);" },
      { path: "/reg_counter", description: "Local override of the registry tool.", code: "return { from: 'local' }" },
    ]

    await step("/save_site_profile stores a PENDING profile that does not load", async () => {
      const bad = await callTool("/save_site_profile", { tools: [{ path: "/click", description: "x", code: "1" }] })
      if (bad.status !== 400) throw new Error(`base-path save accepted: ${bad.status}`)
      const { status, json } = await callTool("/save_site_profile", { tools: savedTools, notes: "LOCAL NOTES for the test page." })
      if (status !== 200 || json.status !== "pending_user_approval" || json.host !== localHost || json.tool_count !== 3) throw new Error(`${status} ${JSON.stringify(json)}`)
      const paths = await toolPaths(activeTokenBase)
      if (paths.includes("/get_counter")) throw new Error("pending tools are live")
      if ((await callTool("/reg_counter", {})).json?.value?.from !== "registry") throw new Error("pending profile overrode a registry tool")
    })

    await step("popup shows the pending save; Keep makes the tools live on the SAME URL", async () => {
      const item = `#pending-list li[data-host="${localHost}"]`
      await popupPage.waitForSelector(item, { timeout: 5000 })
      const text = await popupText(`${item} .profile-head span`)
      if (text !== `AI saved 3 tools for ${localHost}`) throw new Error(`pending text: ${text}`)
      const review = await popupText(`${item} details`)
      if (!review.includes("POST /inc_n") || !review.includes("args.n")) throw new Error("review doesn't show tools + code")
      const urlBefore = (await swSnap()).url
      await clickInPopup(`${item} button[data-action="keep"]`)
      await until(async () => (await toolPaths(activeTokenBase)).includes("/get_counter"))
      if ((await swSnap()).url !== urlBefore) throw new Error("URL changed")
      if (!sameSet(await toolPaths(activeTokenBase), [...BASE_PATHS, "/reg_counter", "/reg_title", "/get_counter", "/inc_n"])) throw new Error(`tools: ${await toolPaths(activeTokenBase)}`)
      const n0 = (await callTool("/get_counter", {})).json?.value
      const n3 = (await callTool("/inc_n", { n: 3 })).json?.value
      if (typeof n0 !== "number" || n3 !== n0 + 3) throw new Error(`/inc_n: ${n0} → ${n3}`)
      if ((await callTool("/reg_counter", {})).json?.value?.from !== "local") throw new Error("local tool didn't override the registry one")
      const md = await (await fetch(`${activeTokenBase}/agents.md`)).text()
      if (!md.includes("LOCAL NOTES for the test page.") || !md.includes("E2E REGISTRY NOTES")) throw new Error("agents.md not updated")
      const snap = await swSnap()
      if (snap.sourceLabel !== `${SITE_HOST} v2 from registry · 3 local`) throw new Error(`label: ${snap.sourceLabel}`)
      await until(async () => (await popupText("#tools-source")) === `Tools: ${SITE_HOST} v2 from registry · 3 local`)
      await until(async () => (await popupText("#pending-card")) !== null && await popupPage.evaluate(() => document.querySelector("#pending-card").hidden))
      await until(async () => /3 tools/.test(await popupText(`#profiles-list li[data-host="${localHost}"]`) ?? ""))
    })

    await step("Discard drops a pending save without loading it", async () => {
      const { json } = await callTool("/save_site_profile", { host: "elsewhere.example", tools: [{ path: "/nope", description: "x", code: "return 1" }] })
      if (json.status !== "pending_user_approval") throw new Error(JSON.stringify(json))
      await clickInPopup(`#pending-list li[data-host="elsewhere.example"] button[data-action="discard"]`)
      await until(async () => !(await sendToSW(popupPage, { type: "list_profiles" })).pending.length)
      const list = await sendToSW(popupPage, { type: "list_profiles" })
      if (list.kept.map((k) => k.host).join() !== localHost) throw new Error(JSON.stringify(list))
      if ((await toolPaths(activeTokenBase)).includes("/nope")) throw new Error("discarded tool is live")
    })

    await step("profiles saved by 0.2 (site_profiles) become pending, not loaded", async () => {
      await popupPage.evaluate(() => chrome.storage.local.set({ site_profiles: { "legacy.example": { host: "legacy.example", tools: [{ path: "/old", description: "old", code: "return 1" }], notes: "", savedAt: 1 } } }))
      const list = await sendToSW(popupPage, { type: "list_profiles" })
      if (list.pending.map((p) => p.host).join() !== "legacy.example") throw new Error(JSON.stringify(list.pending))
      if ((await popupPage.evaluate(() => chrome.storage.local.get("site_profiles"))).site_profiles) throw new Error("legacy key kept")
      await sendToSW(popupPage, { type: "discard_profile", host: "legacy.example" })
    })

    await step("reconnect loads the kept profile at Connect", async () => {
      await sendToSW(popupPage, { type: "disconnect" })
      const r = await sendToSW(popupPage, { type: "connect" })
      if (!r.ok || r.source?.local?.count !== 3 || r.source.registry.status !== "ok") throw new Error(JSON.stringify(r))
      activeTokenBase = r.url.replace(/\/agents\.md.*$/, "")
      const paths = await toolPaths(activeTokenBase)
      if (!paths.includes("/get_counter") || !paths.includes("/inc_n")) throw new Error(`tools: ${paths}`)
      if (typeof (await callTool("/get_counter", {})).json?.value !== "number") throw new Error("/get_counter failed")
    })

    await step("deleting the kept profile removes its tools live", async () => {
      const url = (await swSnap()).url
      await clickInPopup(`#profiles-list li[data-host="${localHost}"] a[data-action="delete"]`)
      await until(async () => !(await toolPaths(activeTokenBase)).includes("/get_counter"))
      if (!sameSet(await toolPaths(activeTokenBase), [...BASE_PATHS, "/reg_counter", "/reg_title"])) throw new Error("tools not back to registry set")
      if ((await callTool("/reg_counter", {})).json?.value?.from !== "registry") throw new Error("registry tool not restored")
      if ((await swSnap()).url !== url) throw new Error("URL changed")
    })

    await step("a site without a profile gets the generic one", async () => {
      const page = await browser.newPage()
      await page.goto(`http://${GENERIC_SITE_HOST}:${STATIC_PORT}/test-page.html?generic`, { waitUntil: "load" })
      const tabId = await popupPage.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.endsWith("?generic"))?.id)
      registry.requests.length = 0
      const r = await sendToSW(popupPage, { type: "connect", tabId })
      if (!r.ok || r.source?.registry?.status !== "generic") throw new Error(JSON.stringify(r))
      if (registry.requests.map((q) => q.path).join() !== `/v1/sites/${GENERIC_SITE_HOST},/v1/sites/*`) throw new Error(registry.requests.map((q) => q.path).join())
      const base = r.url.replace(/\/agents\.md.*$/, "")
      const md = await (await fetch(`${base}/agents.md`)).text()
      if (!md.includes("E2E GENERIC NOTES") || !md.includes("generic profile")) throw new Error("generic notes missing")
      if (!sameSet(await toolPaths(base), BASE_PATHS)) throw new Error(`tools: ${await toolPaths(base)}`)
      await sendToSW(popupPage, { type: "disconnect" })
      await page.close()
    })

    await step("registry down: Connect still works with base tools, popup says so", async () => {
      await testPage.bringToFront()
      registry.mode = "hang"
      try {
        const t0 = Date.now()
        const r = await sendToSW(popupPage, { type: "connect" })
        const took = Date.now() - t0
        if (!r.ok || r.source?.registry?.status !== "unreachable") throw new Error(JSON.stringify(r))
        if (took > 8000) throw new Error(`connect took ${took} ms`)
        const base = r.url.replace(/\/agents\.md.*$/, "")
        if (!sameSet(await toolPaths(base), BASE_PATHS)) throw new Error(`tools: ${await toolPaths(base)}`)
        if (!/registry was unreachable/.test(await (await fetch(`${base}/agents.md`)).text())) throw new Error("agents.md doesn't say so")
        await until(async () => (await popupText("#tools-source")) === "Tools: base only (registry unreachable)")
        console.log(`       connect with registry hanging took ${took} ms`)
      } finally {
        registry.mode = "ok"
      }
      const r = await sendToSW(popupPage, { type: "connect" })
      if (r.status !== "already_connected") {
        throw new Error(`expected already_connected: ${JSON.stringify(r)}`)
      }
      // Fresh session with the registry back, for the steps below.
      await sendToSW(popupPage, { type: "disconnect" })
      const fresh = await sendToSW(popupPage, { type: "connect" })
      if (fresh.source?.registry?.status !== "ok") throw new Error(JSON.stringify(fresh))
      activeTokenBase = fresh.url.replace(/\/agents\.md.*$/, "")
    })

    // ── 8. Negative paths ──────────────────────────────────────────
    await step("unknown selector returns clicked:false", async () => {
      const { json } = await callTool("/click", { selector: "#does-not-exist" })
      if (json.clicked !== false) throw new Error(JSON.stringify(json))
    })

    await step("bad input rejected with 400", async () => {
      const { status, json } = await callTool("/dom_query", { /* missing selector */ })
      if (status !== 400 || json?.error?.code !== "bad_input") throw new Error(`got ${status} ${JSON.stringify(json)}`)
    })

    await step("unknown path → 404 from relay", async () => {
      const r = await fetch(`${activeTokenBase}/no_such_tool`, { method: "POST" })
      if (r.status !== 404) throw new Error(`status ${r.status}`)
    })

    // ── 9. Indicator, screenshot/navigate guards, session end ──────
    const swState = () => sendToSW(popupPage, { type: "snapshot" })
    const badge = (tabId) => popupPage.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)
    const hasPill = (page) => page.evaluate(() => !!document.querySelector("agent-socket-indicator"))
    const agentStatus = async (base) => (await fetch(`${base}/page_info`, { method: "POST", body: "{}" })).status
    const waitFor = async (cond, ms = 5000) => {
      const end = Date.now() + ms
      while (!(await cond())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 100)) }
    }
    // The pill lives in a closed shadow root; CDP can still see inside it.
    async function pillNodes(page) {
      const cdp = await page.createCDPSession()
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true })
      const find = (n, pred) => pred(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map((c) => find(c, pred)).find(Boolean)
      const attr = (n, k) => { const a = n.attributes ?? []; const i = a.findIndex((v, j) => j % 2 === 0 && v === k); return i === -1 ? null : a[i + 1] }
      const host = find(root, (n) => n.nodeName === "AGENT-SOCKET-INDICATOR")
      const pill = host && find(host, (n) => /^pill\b/.test(attr(n, "class") ?? ""))
      const button = host && find(host, (n) => attr(n, "data-action") === "stop")
      const copy = host && find(host, (n) => attr(n, "data-action") === "copy")
      return { cdp, pill, button, copy, copyShown: !!copy && attr(copy, "hidden") === null }
    }
    const center = async (cdp, node) => {
      const [x1, y1, , , x3, y3] = (await cdp.send("DOM.getBoxModel", { nodeId: node.nodeId })).model.content
      return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 }
    }
    const pillHtml = async (page) => {
      const { cdp, pill } = await pillNodes(page)
      return pill ? (await cdp.send("DOM.getOuterHTML", { nodeId: pill.nodeId })).outerHTML : ""
    }
    let other
    const snap0 = await swState()
    const boundTabId = snap0.boundTab?.id

    await step("badge + pill on the bound tab only", async () => {
      if (await badge(boundTabId) !== "AI") throw new Error(`badge=${await badge(boundTabId)}`)
      other = await browser.newPage()
      await other.goto(`${staticSrv.url}/test-page.html?other`, { waitUntil: "load" })
      const otherId = await popupPage.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.endsWith("?other"))?.id)
      if (await badge(otherId) !== "") throw new Error("badge on unbound tab")
      if (!(await hasPill(testPage))) throw new Error("no pill on bound tab")
      if (await hasPill(other)) throw new Error("pill on unbound tab")
      await waitFor(async () => {
        const { cdp, pill } = await pillNodes(testPage)
        const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId: pill.nodeId })
        return /AI has access to this tab · last action \d+s ago/.test(outerHTML)
      })
    })

    await step("/screenshot refuses while another tab is in front", async () => {
      await other.bringToFront()
      const { status, json } = await callTool("/screenshot", {})
      if (status !== 409 || json?.error?.code !== "tab_not_visible") throw new Error(`${status} ${JSON.stringify(json)}`)
      await testPage.bringToFront()
      if ((await callTool("/screenshot", {})).status !== 200) throw new Error("screenshot failed once bound tab is back in front")
    })

    await step("/navigate refuses local/private and non-http URLs", async () => {
      for (const url of ["http://localhost/", "http://[::ffff:127.0.0.1]/", "http://100.64.0.1/", "http://intranet/", "file:///etc/passwd"]) {
        const { status } = await callTool("/navigate", { url })
        if (status !== 400) throw new Error(`${url} → ${status}`)
      }
    })

    await step("popup shows the bound tab, AI activity and Stop", async () => {
      const s = await swState()
      if (s.boundTab?.id !== boundTabId || !/E2E Test Page/.test(s.boundTab.title)) throw new Error(JSON.stringify(s.boundTab))
      if (!s.lastToolCallAt || Date.now() - s.lastToolCallAt > 10000) throw new Error(`lastToolCallAt=${s.lastToolCallAt}`)
      await popupPage.reload({ waitUntil: "domcontentloaded" })
      await waitFor(() => popupPage.evaluate(() => /AI active/.test(document.querySelector("#status-text").textContent)))
      const ui = await popupPage.evaluate(() => ({
        title: document.querySelector("#tab-title").textContent,
        stop: !document.querySelector("#disconnect-btn").hidden,
        link: document.querySelector("#link-input").value,
      }))
      if (!/E2E Test Page/.test(ui.title) || !ui.stop || ui.link !== s.url) throw new Error(JSON.stringify(ui))
    })

    await step("pill can be dragged and keeps its place across reloads", async () => {
      await testPage.bringToFront()
      const box = async () => {
        const { cdp, pill } = await pillNodes(testPage)
        const [x1, y1] = (await cdp.send("DOM.getBoxModel", { nodeId: pill.nodeId })).model.border
        return { x: x1, y: y1 }
      }
      const a = await box()
      await testPage.mouse.move(a.x + 8, a.y + 8)
      await testPage.mouse.down()
      await testPage.mouse.move(a.x + 8 + 200, a.y + 8 - 150, { steps: 8 })  // grabbed 8 px in
      await testPage.mouse.up()
      const b = await box()
      if (Math.abs(b.x - (a.x + 200)) > 3 || Math.abs(b.y - (a.y - 150)) > 3) throw new Error(`drag ${JSON.stringify({ a, b })}`)
      if ((await swState()).status.status !== "connected") throw new Error("drag ended the session")
      await testPage.reload({ waitUntil: "load" })
      await waitFor(() => hasPill(testPage))
      await waitFor(async () => { const c = await box(); return Math.abs(c.x - b.x) < 3 && Math.abs(c.y - b.y) < 3 })
    })

    await step("pill comes back after the bound tab reloads", async () => {
      await testPage.reload({ waitUntil: "load" })
      await waitFor(() => hasPill(testPage))
      if (await badge(boundTabId) !== "AI") throw new Error("badge lost on reload")
    })

    // ── 10. Link changed: a refused resume puts the tab on a new link ──
    // The test page is http://e2e-site.test (not a secure context), so the
    // pill's Copy takes the copy-command fallback here.
    const extOrigin = `chrome-extension://${extId}`
    await browser.defaultBrowserContext().overridePermissions(extOrigin, ["clipboard-read", "clipboard-write"])
    const readClipboard = async () => {
      await popupPage.bringToFront()  // readText needs a focused document
      try { return await popupPage.evaluate(() => navigator.clipboard.readText()) } finally { await testPage.bringToFront() }
    }
    const endSession = async (url) => {
      const sid = url.match(/\/v1\/t\/as_([0-9A-Z]{8})_/)[1]
      const r = await fetch(`${RELAY_BASE}/_debug/kill-ws/${sid}?end=1`, { method: "POST" })
      if (!r.ok) throw new Error(`kill-ws ${r.status}`)
      let next
      await waitFor(async () => { const s = await swState(); next = s.url; return s.linkChanged && s.url && s.url !== url }, 15000)
      return next
    }
    const assertChangedUi = async (url) => {
      await waitFor(async () => /Link changed — paste the new link into your AI chat/.test(await pillHtml(testPage)) && (await pillNodes(testPage)).copyShown)
      if ((await pillHtml(testPage)).includes(url)) throw new Error("link in the page DOM")
      if (await badge(boundTabId) !== "NEW") throw new Error(`badge=${await badge(boundTabId)}`)
      await waitFor(() => popupPage.evaluate((u) => !document.querySelector("#changed-card").hidden
        && document.querySelector("#changed-input").value === u
        && /new link was created/.test(document.querySelector("#changed-reason").textContent)
        && document.querySelector("#link-card").hidden, url))
    }
    const assertNormalUi = async () => {
      await waitFor(async () => !(await swState()).linkChanged)
      await waitFor(async () => (await badge(boundTabId)) === "AI")
      await waitFor(async () => !(await pillNodes(testPage)).copyShown && /AI has access to this tab/.test(await pillHtml(testPage)))
      await waitFor(() => popupPage.evaluate(() => document.querySelector("#changed-card").hidden && !document.querySelector("#link-card").hidden))
    }
    let changedUrl
    await step("refused resume: pill, NEW badge and popup banner show the new link", async () => {
      await testPage.bringToFront()
      const before = (await swState()).url
      changedUrl = await endSession(before)
      await assertChangedUi(changedUrl)
      const r = await fetch(`${before.replace(/\/agents\.md.*$/, "")}/page_info`, { method: "POST", body: "{}" })
      const j = await r.json()
      if (r.status !== 503 || j.error?.code !== "app_offline" || !/ask the user to reconnect/.test(j.error.message)) throw new Error(`old link: ${r.status} ${JSON.stringify(j)}`)
    })

    await step("Copy link in the pill (http page) copies it and clears the state", async () => {
      await testPage.bringToFront()
      const { cdp, copy } = await pillNodes(testPage)
      const at = await center(cdp, copy)
      await testPage.mouse.click(at.x, at.y)
      await assertNormalUi()
      if (await readClipboard() !== changedUrl) throw new Error("clipboard doesn't hold the new link")
    })

    await step("a tool call on a changed link clears the state", async () => {
      changedUrl = await endSession(changedUrl)
      await assertChangedUi(changedUrl)
      if (await agentStatus(changedUrl.replace(/\/agents\.md.*$/, "")) !== 200) throw new Error("new link doesn't work")
      await assertNormalUi()
    })

    await step("Copy in the popup banner clears the state", async () => {
      changedUrl = await endSession(changedUrl)
      await assertChangedUi(changedUrl)
      await popupPage.bringToFront()
      await popupPage.click("#changed-copy")
      await testPage.bringToFront()
      await assertNormalUi()
      if (await readClipboard() !== changedUrl) throw new Error("clipboard doesn't hold the new link")
    })

    await step("closing the bound tab ends the session", async () => {
      await other.bringToFront()
      const r = await sendToSW(popupPage, { type: "connect" })
      if (!r.ok || !r.url) throw new Error(JSON.stringify(r))
      if (await hasPill(testPage)) throw new Error("old tab kept its pill")
      await waitFor(() => hasPill(other))
      const base = r.url.replace(/\/agents\.md.*$/, "")
      if (await agentStatus(base) !== 200) throw new Error("new session not working")
      await other.close()
      await waitFor(async () => (await swState()).status.status === "idle")
      if (await agentStatus(base) === 200) throw new Error("agent URL still works after tab close")
    })

    await step("Stop in the pill ends the session", async () => {
      await testPage.bringToFront()
      const r = await sendToSW(popupPage, { type: "connect" })
      const base = r.url.replace(/\/agents\.md.*$/, "")
      await waitFor(() => hasPill(testPage))
      const { cdp, button } = await pillNodes(testPage)
      const { model } = await cdp.send("DOM.getBoxModel", { nodeId: button.nodeId })
      const [x1, y1, , , x3, y3] = model.content
      await testPage.mouse.click((x1 + x3) / 2, (y1 + y3) / 2)
      await waitFor(async () => (await swState()).status.status === "idle")
      await waitFor(async () => !(await hasPill(testPage)))
      if (await badge(boundTabId) !== "") throw new Error("badge still set")
      if (await agentStatus(base) === 200) throw new Error("agent URL still works after Stop")
    })

    await browser.close()
    browser = null
    await step("without site access, connect is refused", async () => {
      ;({ browser, userDataDir: userDataDir2 } = await launchChrome(EXT_DIR))
      const id = await waitForExtensionId(browser)
      const page = await browser.newPage()
      await page.goto(testUrl, { waitUntil: "load" })
      const popup = await browser.newPage()
      await popup.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "domcontentloaded" })
      await page.bringToFront()
      const r = await sendToSW(popup, { type: "connect" })
      if (r.ok || !/site access/.test(r.error)) throw new Error(JSON.stringify(r))
    })

    console.log(`\n${passed} passed, ${failed} failed`)
  } catch (e) {
    console.log("\n[fatal]", e?.message ?? e)
    if (e?.stack) console.log(e.stack.split("\n").slice(0, 8).join("\n"))
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (staticSrv) await staticSrv.stop()
    await relay.stop()
    for (const d of [userDataDir, userDataDir2, extDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
