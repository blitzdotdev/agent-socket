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
// A second site for the site lock and tool swap.
const OTHER_HOST = "e2e-other.test"
const SHOT_DIR = process.env.SHOT_DIR ?? ""
const EXT_VERSION = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")).version

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
    [OTHER_HOST]: {
      host: OTHER_HOST, version: 1, updated: "2026-10-01 00:00:00",
      notes: "E2E OTHER NOTES: the second site.",
      tools: [{ method: "POST", path: "/other_heading", description: "Read the heading (other site).", code: "return { from: 'other', title: document.getElementById('page-title').textContent }" }],
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
    // ?csp: a page whose CSP forbids eval (new Function), like x.com or GitHub.
    const csp = url.searchParams.has("csp") ? { "content-security-policy": "script-src 'self' 'unsafe-inline'" } : {}
    // ?spin=<ms>: the page's main thread is busy for that long right after load.
    const spin = parseInt(url.searchParams.get("spin") ?? "", 10)
    if (spin > 0 && ext === ".html") {
      body = String(body).replace("</body>", `<script>addEventListener("load", () => setTimeout(() => { const t = Date.now(); while (Date.now() - t < ${spin}) {} }, 0))</script></body>`)
    }
    res.writeHead(200, { "content-type": `${ct}; charset=utf-8`, ...csp })
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
      `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1, MAP ${GENERIC_SITE_HOST} 127.0.0.1, MAP ${OTHER_HOST} 127.0.0.1`,
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
      if (sub.body.host !== SITE_HOST || sub.body.ext_version !== EXT_VERSION || sub.body.tools[0].method !== "POST" || sub.body.notes !== "Counter page.") throw new Error(JSON.stringify(sub.body))
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
      // Only for the sites this session may act on.
      const far = await callTool("/save_site_profile", { host: "elsewhere.example", tools: [{ path: "/nope", description: "x", code: "return 1" }] })
      if (far.status !== 403 || far.json?.error?.code !== "host_not_allowed") throw new Error(`other host: ${far.status} ${JSON.stringify(far.json)}`)
      const { json } = await callTool("/save_site_profile", { tools: [{ path: "/nope", description: "x", code: "return 1" }] })
      if (json.status !== "pending_user_approval") throw new Error(JSON.stringify(json))
      await clickInPopup(`#pending-list li[data-host="${localHost}"] button[data-action="discard"]`)
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
      // The first tab stays connected meanwhile: each tab has its own session.
      if ((await callTool("/page_info", {})).status !== 200) throw new Error("connecting a second tab ended the first")
      await sendToSW(popupPage, { type: "disconnect", tabId })
      await page.close()
    })

    await step("registry down: Connect still works with base tools, popup says so", async () => {
      await testPage.bringToFront()
      await sendToSW(popupPage, { type: "disconnect" })
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
      const allow = host && find(host, (n) => attr(n, "data-action") === "allow")
      return { cdp, pill, button, copy, copyShown: !!copy && attr(copy, "hidden") === null, allow, allowShown: !!allow && attr(allow, "hidden") === null }
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
        return /AI has access to this tab · last: \w+ \d+s ago/.test(outerHTML)
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

    // ── 11. Session timer + site lock ──────────────────────────────
    const firstOrigin = `http://${SITE_HOST}:${STATIC_PORT}`
    const otherOrigin = `http://${OTHER_HOST}:${STATIC_PORT}`
    const otherHost = `${OTHER_HOST}:${STATIC_PORT}`
    const otherUrl = `${otherOrigin}/test-page.html`
    const popupState = () => popupPage.evaluate(() => ({
      timer: document.querySelector("#timer-text").textContent,
      soon: document.querySelector("#timer-card").classList.contains("soon"),
      removeShown: !document.querySelector("#timer-remove").hidden,
      paused: !document.querySelector("#paused-card").hidden,
      pausedTitle: document.querySelector("#paused-title").textContent,
      allow: document.querySelector("#paused-card").hidden || document.querySelector("#allow-btn").hidden ? null : document.querySelector("#allow-btn").textContent,
      sites: [...document.querySelectorAll("#sites-list li[data-origin]")].map((li) => li.dataset.origin),
      any: document.querySelector("#any-site").checked,
    }))
    const near = (a, b, ms = 15000) => a != null && Math.abs(a - b) < ms
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const refused = async (p, body, host) => {
      const { status, json } = await callTool(p, body)
      if (status !== 403 || json?.error?.code !== "origin_not_allowed" || (host && json.error.host !== host)) throw new Error(`${p}: ${status} ${JSON.stringify(json)}`)
      return json.error
    }
    const toolsAre = (want, notWant) => waitFor(async () => {
      const have = await toolPaths(activeTokenBase)
      return have.includes(want) && !have.includes(notWant)
    }, 10000)
    if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })
    const shotPill = async (name) => {
      if (!SHOT_DIR) return
      await testPage.bringToFront()
      await testPage.evaluate(() => scrollTo(0, 0))  // screenshot clips are in page coordinates
      await sleep(400)
      const { cdp, pill } = await pillNodes(testPage)
      const [x1, y1, , , x3, y3] = (await cdp.send("DOM.getBoxModel", { nodeId: pill.nodeId })).model.border
      await testPage.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), clip: { x: Math.max(0, x1 - 16), y: Math.max(0, y1 - 16), width: x3 - x1 + 32, height: y3 - y1 + 32 } })
    }
    const shotPopup = async (name) => {
      if (!SHOT_DIR) return
      await popupPage.bringToFront()
      await popupPage.setViewport({ width: 384, height: 900 })
      await sleep(1200)
      const h = await popupPage.evaluate(() => document.body.scrollHeight)
      await popupPage.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), clip: { x: 0, y: 0, width: 384, height: h } })
      await testPage.bringToFront()
    }

    await step("timer: a new session stops after 60 min; pill, popup, /page_info show it", async () => {
      await sendToSW(popupPage, { type: "disconnect" })
      await testPage.bringToFront()
      if (!testPage.url().startsWith(firstOrigin)) await testPage.goto(testUrl, { waitUntil: "load" })
      const t0 = Date.now()
      const r = await sendToSW(popupPage, { type: "connect" })
      if (!r.ok) throw new Error(JSON.stringify(r))
      activeTokenBase = r.url.replace(/\/agents\.md.*$/, "")
      const snap = await swState()
      if (!near(snap.endsAt, t0 + 3_600_000)) throw new Error(`endsAt ${snap.endsAt - t0} ms after connect`)
      if (JSON.stringify(snap.siteLock) !== JSON.stringify({ origins: [firstOrigin], any: false })) throw new Error(JSON.stringify(snap.siteLock))
      await waitFor(async () => /<span class="left">· 60 min left<\/span>/.test(await pillHtml(testPage)))
      await waitFor(async () => { const u = await popupState(); return /^Auto-stop in (1:00:00|59:\d\d)$/.test(u.timer) && u.removeShown && !u.soon })
      const { status, json } = await callTool("/page_info", {})
      if (status !== 200 || json.session_ends_at !== new Date(snap.endsAt).toISOString()) throw new Error(`${status} ${json?.session_ends_at}`)
      if (JSON.stringify(json.allowed_origins) !== JSON.stringify([firstOrigin])) throw new Error(JSON.stringify(json.allowed_origins))
      if (!/origin_not_allowed[\s\S]*session_ends_at/.test(await (await fetch(`${activeTokenBase}/agents.md`)).text())) throw new Error("agents.md doesn't explain the limits")
    })

    await step("timer: Change picks a new length from now; Remove timer clears it", async () => {
      await clickInPopup("#timer-change")
      await clickInPopup('#timer-choices [data-minutes="30"]')
      await waitFor(async () => near((await swState()).endsAt, Date.now() + 30 * 60_000))
      await waitFor(async () => /^Auto-stop in (30:00|29:\d\d)$/.test((await popupState()).timer))
      await waitFor(async () => /AI has access to this tab · last: \w+ \d+s ago<\/span><span class="left">· 30 min left/.test(await pillHtml(testPage)))
      await shotPill("pill-time-left")
      await shotPopup("popup-timer")
      await clickInPopup("#timer-change")
      await shotPopup("popup-timer-change")
      await clickInPopup("#timer-change")
      if (SHOT_DIR) {
        await popupPage.evaluate(() => { document.querySelector("#advanced").open = true; scrollTo(0, 0) })
        await shotPopup("popup-settings")
        await popupPage.evaluate(() => { document.querySelector("#advanced").open = false })
      }
      await clickInPopup("#timer-remove")
      await waitFor(async () => (await swState()).endsAt === null)
      await waitFor(async () => { const u = await popupState(); return u.timer === "No auto-stop for this session" && !u.removeShown })
      await waitFor(async () => !/min left/.test(await pillHtml(testPage)))
      if ((await callTool("/page_info", {})).json.session_ends_at !== null) throw new Error("session_ends_at not null")
      if ((await popupText("#timer-change")) !== "Set timer") throw new Error("no Set timer")
      await clickInPopup("#timer-change")
      await clickInPopup('#timer-choices [data-minutes="120"]')
      await waitFor(async () => /· 2 h left/.test(await pillHtml(testPage)))
    })

    await step("site lock: /navigate to another origin is refused", async () => {
      const e = await refused("/navigate", { url: otherUrl }, otherHost)
      if (!/Allow/.test(e.message) || !/Let the AI use other sites/.test(e.message)) throw new Error(e.message)
      if (!testPage.url().startsWith(firstOrigin)) throw new Error(`tab moved to ${testPage.url()}`)
      if ((await callTool("/navigate", { url: `${testUrl}?same-origin` })).status !== 200) throw new Error("same-origin navigate refused")
    })

    let urlBeforeSwap
    await step("site lock: tab sent away by /eval → next calls refused, page untouched, pill paused", async () => {
      urlBeforeSwap = (await swState()).url
      const { status } = await callTool("/eval", { code: `setTimeout(() => { location.href = ${JSON.stringify(`${otherUrl}?away`)} }, 50); return 1` })
      if (status !== 200) throw new Error(`eval ${status}`)
      await waitFor(() => testPage.url().includes("?away"))
      await testPage.waitForFunction(() => document.readyState === "complete")
      await refused("/page_info", {}, otherHost)
      for (const [p, body] of [["/eval", { code: "return document.title" }], ["/click", { selector: "#inc-btn" }], ["/get_text", {}], ["/reg_counter", {}], ["/screenshot", {}]]) await refused(p, body)
      if (await testPage.evaluate(() => document.getElementById("counter").textContent) !== "0") throw new Error("a refused /click touched the page")
      if ((await callTool("/registry_search", { q: "counter" })).status !== 200) throw new Error("registry tools refused while paused")
      await waitFor(async () => {
        const { allowShown } = await pillNodes(testPage)
        const html = await pillHtml(testPage)
        return allowShown && /class="pill paused"/.test(html) && html.includes(`AI paused: tab left ${SITE_HOST}:${STATIC_PORT}`) && html.includes(`Allow ${otherHost}`)
      })
      await waitFor(async () => { const u = await popupState(); return u.paused && u.allow === `Allow ${otherHost}` && u.pausedTitle === `AI paused: the tab left ${SITE_HOST}:${STATIC_PORT}` && u.sites.join() === firstOrigin })
      await sleep(1500)  // past the tool-swap debounce: a paused tab keeps the loaded tools
      await toolsAre("/reg_counter", "/other_heading")
      await shotPill("pill-paused")
      await shotPopup("popup-paused")
    })

    await step("site lock: Allow in the pill lets calls through; tools swap on the same link", async () => {
      await testPage.bringToFront()
      await sleep(300)
      const { cdp, allow } = await pillNodes(testPage)
      const at = await center(cdp, allow)
      await testPage.mouse.click(at.x, at.y)
      await waitFor(async () => (await swState()).siteLock.origins.includes(otherOrigin))
      const { status, json } = await callTool("/page_info", {})
      if (status !== 200 || json.host !== otherHost || json.allowed_origins.join() !== `${firstOrigin},${otherOrigin}`) throw new Error(`${status} ${JSON.stringify(json)}`)
      await toolsAre("/other_heading", "/reg_counter")
      const h = await callTool("/other_heading", {})
      if (h.json?.value?.from !== "other") throw new Error(JSON.stringify(h.json))
      if (!(await (await fetch(`${activeTokenBase}/agents.md`)).text()).includes("E2E OTHER NOTES")) throw new Error("agents.md not swapped")
      if ((await swState()).url !== urlBeforeSwap) throw new Error("the link changed")
      await waitFor(async () => !/paused/.test(await pillHtml(testPage)) && /AI has access to this tab/.test(await pillHtml(testPage)))
    })

    await step("site lock: back on the first site, its tools come back", async () => {
      const { status, json } = await callTool("/navigate", { url: testUrl })
      if (status !== 200 || !json.loaded) throw new Error(`${status} ${JSON.stringify(json)}`)
      await toolsAre("/reg_counter", "/other_heading")
      if ((await callTool("/reg_counter", {})).json?.value?.from !== "registry") throw new Error("registry tool not back")
    })

    await step("site lock: popup removes an allowed site; Allow in the popup takes a trusted click", async () => {
      await clickInPopup(`#sites-list li[data-origin="${otherOrigin}"] a[data-action="remove"]`)
      await waitFor(async () => (await swState()).siteLock.origins.join() === firstOrigin)
      await refused("/navigate", { url: otherUrl })
      await testPage.goto(`${otherUrl}?user`, { waitUntil: "load" })  // the user browses there
      await refused("/get_text", {}, otherHost)
      await waitFor(async () => (await popupState()).allow === `Allow ${otherHost}`)
      await popupPage.$eval("#allow-btn", (n) => n.click())  // synthetic: ignored
      await sleep(500)
      if ((await swState()).siteLock.origins.includes(otherOrigin)) throw new Error("an untrusted click allowed the site")
      await popupPage.bringToFront()
      await popupPage.click("#allow-btn")
      await testPage.bringToFront()
      await waitFor(async () => (await swState()).siteLock.origins.includes(otherOrigin))
      if ((await callTool("/get_text", {})).status !== 200) throw new Error("still refused after Allow")
      await clickInPopup(`#sites-list li[data-origin="${otherOrigin}"] a[data-action="remove"]`)
      await waitFor(async () => (await swState()).siteLock.origins.join() === firstOrigin)
      await refused("/get_text", {})
      await testPage.goto(testUrl, { waitUntil: "load" })
      await toolsAre("/reg_counter", "/other_heading")
    })

    await step("site lock: \"Let the AI use other sites\" lets calls through anywhere", async () => {
      await testPage.goto(`http://${GENERIC_SITE_HOST}:${STATIC_PORT}/test-page.html?lock`, { waitUntil: "load" })
      await refused("/page_info", {})
      await clickInPopup("#any-site")
      await waitFor(async () => (await swState()).siteLock.any === true)
      const { status, json } = await callTool("/page_info", {})
      if (status !== 200 || json.allowed_origins !== "any") throw new Error(`${status} ${JSON.stringify(json)}`)
      const nav = await callTool("/navigate", { url: otherUrl })
      if (nav.status !== 200) throw new Error(`navigate ${nav.status}`)
      await toolsAre("/other_heading", "/reg_counter")
      if ((await popupState()).any !== true) throw new Error("toggle not shown on")
      await clickInPopup("#any-site")
      await waitFor(async () => (await swState()).siteLock.any === false)
      await refused("/page_info", {}, otherHost)
      await testPage.goto(testUrl, { waitUntil: "load" })
      await toolsAre("/reg_counter", "/other_heading")
      if ((await callTool("/page_info", {})).status !== 200) throw new Error("first site refused")
    })

    // ── 12. Activity log ───────────────────────────────────────────
    const actEntries = () => popupPage.evaluate(async () => {
      const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith("act:")).sort()
      const got = keys.length ? await chrome.storage.local.get(keys) : {}
      return keys.map((k) => got[k])
    })
    const sid = (url) => url.match(/\/v1\/t\/as_([0-9A-Z]{8})_/)[1]
    const callsOf = (es, tool) => es.filter((e) => e.kind === "call" && (!tool || e.tool === tool))
    const eventsOf = (es, event) => es.filter((e) => e.kind === "session" && e.event === event)
    const setLevel = async (level) => {
      await popupPage.select("#activity-level", level)
      await waitFor(async () => (await popupPage.evaluate(() => chrome.storage.local.get("activity_level"))).activity_level === level)
    }
    let actPage

    await step("activity: every call and session event is logged; typed text hidden by default", async () => {
      const es = await actEntries()
      const site = `${SITE_HOST}:${STATIC_PORT}`
      const click = callsOf(es, "click").find((e) => e.summary === 'click "Increment"' && e.status === 200)
      if (!click || click.host !== site || !/^[0-9A-Z]{8}$/.test(click.session) || typeof click.ms !== "number" || click.level !== "summary") throw new Error(`click: ${JSON.stringify(click)}`)
      const fill = callsOf(es, "fill").find((e) => e.summary === "fill #email-input (16 chars)")
      if (fill?.detail?.args?.value !== "<16 chars>" || fill.detail.args.selector !== "#email-input") throw new Error(`fill: ${JSON.stringify(fill)}`)
      const all = JSON.stringify(es)
      if (all.includes("ada@lovelace.dev") || all.includes("Inventor of the loop")) throw new Error("typed text was stored")
      const secret = activeTokenBase.match(/as_[0-9A-Z]{8}_([\w-]+)/)[1]
      if (all.includes(secret) || all.includes("/v1/t/")) throw new Error("a link or token was stored")
      const refusal = (tool, status, code) => callsOf(es, tool).some((e) => e.status === status && e.error === code && e.message)
      if (!refusal("screenshot", 409, "tab_not_visible")) throw new Error("screenshot refusal not logged")
      if (!refusal("page_info", 403, "origin_not_allowed") || !refusal("navigate", 403, "origin_not_allowed")) throw new Error("site-lock refusal not logged")
      if (!es.some((e) => e.kind === "call" && e.status === 400 && e.error === "bad_input")) throw new Error("bad input not logged")
      const ev = (name, n = 1) => { if (eventsOf(es, name).length < n) throw new Error(`${name}: ${eventsOf(es, name).length} events`) }
      ev("connected", 2); ev("stopped"); ev("link_changed", 3); ev("origin_allowed", 2); ev("origin_removed", 2); ev("any_origin", 2)
      if (eventsOf(es, "timer_set").map((e) => e.minutes).join() !== "30,0,120") throw new Error(JSON.stringify(eventsOf(es, "timer_set")))
      if (eventsOf(es, "connected")[0].host !== site || !/^Connected on /.test(eventsOf(es, "connected")[0].summary)) throw new Error(JSON.stringify(eventsOf(es, "connected")[0]))
    })

    await step("activity: popup card shows the last actions; Open activity log opens the page", async () => {
      await callTool("/get_text", { selector: "#counter" })
      await waitFor(() => popupPage.evaluate(() => /^get_text #counter/.test(document.querySelector("#activity-list li .what")?.textContent ?? "")))
      if (await popupPage.evaluate(() => document.querySelectorAll("#activity-list li").length) !== 3) throw new Error("not 3 rows")
      await waitFor(async () => /AI has access to this tab · last: get_text \d+s ago/.test(await pillHtml(testPage)))
      await shotPill("pill-last-tool")
      await shotPopup("popup-activity")
      const opened = browser.waitForTarget((t) => t.url().endsWith("/activity.html"), { timeout: 5000 })
      await clickInPopup("#open-activity")
      actPage = await (await opened).page()
      await actPage.setViewport({ width: 1200, height: 900 })
      await actPage.waitForSelector(".group .entry")
    })

    await step("activity page: grouped by session, rows expand, filter narrows", async () => {
      const info = await actPage.evaluate(() => ({
        groups: document.querySelectorAll(".group").length,
        first: document.querySelector(".group .entry .summary")?.textContent,
        note: document.querySelector("#note").textContent,
      }))
      if (info.groups < 4 || !/^get_text #counter/.test(info.first)) throw new Error(JSON.stringify(info))
      if (!/only on this computer for 7 days/.test(info.note) || !/Detail level: Summary \(typed text hidden\);/.test(info.note)) throw new Error(info.note)
      await actPage.type("#filter", "fill #email")
      await waitFor(() => actPage.evaluate(() => {
        const rows = [...document.querySelectorAll(".entry .summary")].map((n) => n.textContent)
        return rows.length >= 1 && rows.every((t) => t.startsWith("fill #email"))
      }))
      await actPage.click(".entry.call .row")
      const detail = await actPage.$eval(".entry.call pre.detail", (n) => JSON.parse(n.textContent))
      if (detail.detail?.args?.value !== "<16 chars>" || detail.status !== 200) throw new Error(JSON.stringify(detail))
      if (SHOT_DIR) await actPage.screenshot({ path: path.join(SHOT_DIR, "activity-filtered.png") })
      await actPage.$eval("#filter", (n) => { n.value = ""; n.dispatchEvent(new Event("input")) })
      if (SHOT_DIR) await actPage.screenshot({ path: path.join(SHOT_DIR, "activity-summary.png") })
    })

    await step("activity: Full detail keeps typed text but hides passwords; minimal keeps tool + status", async () => {
      await setLevel("full")
      await callTool("/eval", { code: "document.body.insertAdjacentHTML('beforeend', '<input type=password id=pw-input>'); return 1" })
      await callTool("/fill", { selector: "#pw-input", value: "hunter22" })
      await callTool("/fill", { selector: "#name-input", value: "Grace" })
      const es = await actEntries()
      const pw = callsOf(es, "fill").find((e) => e.summary === "fill #pw-input (8 chars, password)")
      if (pw?.detail?.args?.value !== "<hidden: 8 chars>" || pw.detail.reply?.value_now !== "<hidden: 8 chars>") throw new Error(`pw: ${JSON.stringify(pw)}`)
      if (JSON.stringify(es).includes("hunter22")) throw new Error("password stored")
      const name = callsOf(es, "fill").find((e) => e.summary === 'fill #name-input "Grace"')
      if (name?.level !== "full" || name.detail.args.value !== "Grace" || name.detail.reply?.value_now !== "Grace") throw new Error(`name: ${JSON.stringify(name)}`)
      if (SHOT_DIR) {
        await actPage.bringToFront()
        await waitFor(() => actPage.evaluate(() => [...document.querySelectorAll(".entry .summary")].some((n) => n.textContent.includes("Grace"))))
        await actPage.evaluate(() => [...document.querySelectorAll(".entry .summary")].find((n) => n.textContent.includes("Grace")).closest(".row").click())
        await actPage.screenshot({ path: path.join(SHOT_DIR, "activity-full.png") })
        await testPage.bringToFront()
      }
      await setLevel("minimal")
      await callTool("/click", { selector: "#inc-btn" })
      const last = callsOf(await actEntries()).at(-1)
      if (last.summary !== "click" || last.level !== "minimal" || last.detail !== undefined || last.status !== 200) throw new Error(JSON.stringify(last))
      await setLevel("summary")
    })

    await step("activity page: delete one entry, a session, then everything", async () => {
      await actPage.bringToFront()
      await actPage.reload({ waitUntil: "domcontentloaded" })
      await actPage.waitForSelector(".entry")
      const before = (await actEntries()).length
      const firstId = await actPage.$eval(".entry", (n) => n.dataset.id)
      await actPage.click(`.entry[data-id="${firstId}"] .del`)
      await waitFor(async () => !(await actEntries()).some((e) => e.id === firstId))
      await waitFor(() => actPage.evaluate((id) => !document.querySelector(`.entry[data-id="${id}"]`), firstId))
      if ((await actEntries()).length !== before - 1) throw new Error("deleted more than one entry")
      const sessionId = await actPage.$$eval(".group", (gs) => gs.at(-1).dataset.session)
      // With a filter on, Delete session still deletes all of its entries.
      const tool = await actPage.$$eval(".group", (gs) => gs.at(-1).querySelector(".entry.call .tool").textContent)
      await actPage.type("#filter", tool)
      const group = `.group[data-session="${sessionId}"]`
      await actPage.waitForSelector(group)
      const shown = await actPage.$$eval(`${group} .entry`, (es) => es.length)
      if (shown >= (await actEntries()).filter((e) => (e.session ?? "") === sessionId).length) throw new Error(`the filter "${tool}" hides none of the session's entries`)
      await actPage.click(`${group} [data-action="delete-session"]`)
      await waitFor(async () => !(await actEntries()).some((e) => (e.session ?? "") === sessionId))
      await actPage.$eval("#filter", (n) => { n.value = ""; n.dispatchEvent(new Event("input")) })
      if (!(await actEntries()).length) throw new Error("deleting a session deleted everything")
      actPage.once("dialog", (d) => d.accept())
      await actPage.click("#delete-all")
      await waitFor(async () => (await actEntries()).length === 0)
      await waitFor(() => actPage.evaluate(() => /No activity yet/.test(document.querySelector("#groups").textContent)))
      if (!(await popupPage.evaluate(() => chrome.storage.local.get("kept_profiles"))).kept_profiles) throw new Error("delete all touched other storage")
      await testPage.bringToFront()
    })

    await step("activity: kept across a service-worker restart; entries older than 7 days are pruned", async () => {
      if ((await callTool("/page_info", {})).status !== 200) throw new Error("page_info failed")
      await waitFor(async () => callsOf(await actEntries(), "page_info").length === 1)
      const oldKey = await popupPage.evaluate(async () => {
        const at = Date.now() - 8 * 24 * 3_600_000
        const key = `act:${String(at).padStart(15, "0")}-old`
        await chrome.storage.local.set({ [key]: { id: key, at, kind: "call", tool: "old", summary: "old", status: 200 } })
        return key
      })
      const sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))
      if (!sw) throw new Error("service worker target not found")
      await (await sw.worker()).close()
      await waitFor(async () => !browser.targets().includes(sw), 10000)
      await waitFor(async () => (await sendToSW(popupPage, { type: "snapshot" }).catch(() => null))?.ok === true, 10000)
      await waitFor(async () => { const es = await actEntries(); return !es.some((e) => e.id === oldKey) && callsOf(es, "page_info").length === 1 }, 10000)
      await waitFor(async () => (await callTool("/page_info", {})).status === 200, 20000)
      // Logging goes on after the restart.
      await waitFor(async () => { const p = callsOf(await actEntries(), "page_info"); return p.length >= 2 && p.at(-1).status === 200 })
      await actPage.close()
    })

    await step("timer: expiry ends the session like Stop", async () => {
      await popupPage.evaluate(() => chrome.storage.local.set({ test_session_ms: 10000 }))
      try {
        await sendToSW(popupPage, { type: "disconnect" })
        const r = await sendToSW(popupPage, { type: "connect" })
        const base = r.url.replace(/\/agents\.md.*$/, "")
        if (await agentStatus(base) !== 200) throw new Error("new session not working")
        await waitFor(async () => /<span class="left soon">· \d+ s left/.test(await pillHtml(testPage)))
        await waitFor(async () => (await popupState()).soon)
        await shotPill("pill-last-minute")
        await shotPopup("popup-last-minute")
        await waitFor(async () => (await swState()).status.status === "closed", 20000)
        const snap = await swState()
        if (!/timer/.test(snap.status.reason) || snap.boundTab || snap.endsAt !== null) throw new Error(JSON.stringify(snap.status))
        if (!snap.events.some((e) => e.type === "expired")) throw new Error("no expired event")
        await waitFor(async () => eventsOf(await actEntries(), "expired").some((e) => e.session === sid(r.url)))
        await waitFor(async () => !(await hasPill(testPage)))
        if (await badge(boundTabId) !== "") throw new Error("badge still set")
        if (await agentStatus(base) === 200) throw new Error("agent URL still works after expiry")
        // Ended, not held: a held session still serves its agents.md.
        await waitFor(async () => (await fetch(`${base}/agents.md`)).status === 503)
        await waitFor(() => popupPage.evaluate(() => /session timer ran out/.test(document.querySelector("#status-text").textContent)))
      } finally {
        await popupPage.evaluate(() => chrome.storage.local.remove("test_session_ms"))
      }
    })

    // ── 13. Several tabs: one session (link, pill, timer, site lock) each ──
    const callAt = async (base, p, body = {}) => {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      let json = null
      try { json = await r.json() } catch {}
      return { status: r.status, json }
    }
    const tabIdOf = (page) => popupPage.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, page.url())
    const counter = (page) => page.evaluate(() => document.getElementById("counter").textContent)
    const popupOthers = () => popupPage.evaluate(() => ({
      shown: !document.querySelector("#others-card").hidden,
      label: document.querySelector("#others-label").textContent,
      tabs: [...document.querySelectorAll("#others-list li")].map((li) => Number(li.dataset.tab)),
      connect: !document.querySelector("#connect-btn").hidden,
      stop: !document.querySelector("#disconnect-btn").hidden,
      linkShown: !document.querySelector("#link-card").hidden,
      link: document.querySelector("#link-input").value,
    }))
    let tabA, tabB, rA, rB, baseA, baseB, third

    await step("two tabs at once: each gets its own link, and each link only touches its tab", async () => {
      await testPage.bringToFront()
      if (!testPage.url().startsWith(firstOrigin)) await testPage.goto(testUrl, { waitUntil: "load" })
      await testPage.reload({ waitUntil: "load" })
      await other.reload({ waitUntil: "load" })
      tabA = await tabIdOf(testPage)
      tabB = await tabIdOf(other)
      rA = await sendToSW(popupPage, { type: "connect", tabId: tabA })
      rB = await sendToSW(popupPage, { type: "connect", tabId: tabB })
      if (!rA.ok || !rB.ok || rA.status !== "connected" || rB.status !== "connected") throw new Error(JSON.stringify({ rA, rB }))
      if (rA.url === rB.url || sid(rA.url) === sid(rB.url)) throw new Error("both tabs got the same link")
      baseA = rA.url.replace(/\/agents\.md.*$/, "")
      baseB = rB.url.replace(/\/agents\.md.*$/, "")
      const [a, b] = [await callAt(baseA, "/page_info"), await callAt(baseB, "/page_info")]
      if (a.status !== 200 || b.status !== 200 || a.json.url !== testPage.url() || b.json.url !== other.url()) throw new Error(JSON.stringify({ a: a.json?.url, b: b.json?.url }))
      if ((await callAt(baseA, "/click", { selector: "#inc-btn" })).json?.clicked !== true) throw new Error("click on A failed")
      if (await counter(testPage) !== "1" || await counter(other) !== "0") throw new Error(`after A: ${await counter(testPage)} / ${await counter(other)}`)
      await callAt(baseB, "/click", { selector: "#inc-btn" })
      await callAt(baseB, "/click", { selector: "#inc-btn" })
      if (await counter(testPage) !== "1" || await counter(other) !== "2") throw new Error(`after B: ${await counter(testPage)} / ${await counter(other)}`)
    })

    await step("two tabs: badge, pill, timer and site lock are per tab", async () => {
      if (await badge(tabA) !== "AI" || await badge(tabB) !== "AI") throw new Error(`badges ${await badge(tabA)} / ${await badge(tabB)}`)
      await waitFor(async () => (await hasPill(testPage)) && (await hasPill(other)))
      if (!(await sendToSW(popupPage, { type: "set_timer", tabId: tabA, minutes: 30 })).ok) throw new Error("set_timer failed")
      await waitFor(async () => /· 30 min left/.test(await pillHtml(testPage)) && /· 60 min left/.test(await pillHtml(other)))
      await waitFor(async () => /last: click \d+s ago/.test(await pillHtml(testPage)) && /last: click \d+s ago/.test(await pillHtml(other)))
      // One saved position for both pills; each stays fully on screen.
      await callAt(baseB, "/page_info")
      await sleep(1500)
      for (const pg of [testPage, other]) {
        const { cdp, pill } = await pillNodes(pg)
        const [x1, , , , x3] = (await cdp.send("DOM.getBoxModel", { nodeId: pill.nodeId })).model.border
        const vw = await pg.evaluate(() => innerWidth)
        if (x1 < 0 || x3 > vw + 1) throw new Error(`pill off screen: ${x1}..${x3} of ${vw}`)
      }
      const [sa, sb] = [await sendToSW(popupPage, { type: "snapshot", tabId: tabA }), await sendToSW(popupPage, { type: "snapshot", tabId: tabB })]
      if (!near(sa.endsAt, Date.now() + 30 * 60_000) || !near(sb.endsAt, Date.now() + 60 * 60_000)) throw new Error("timers not independent")
      if (sa.siteLock.origins.join() !== firstOrigin || sb.siteLock.origins.join() !== new URL(other.url()).origin) throw new Error(JSON.stringify([sa.siteLock, sb.siteLock]))
      // "other sites" on B leaves A locked.
      await sendToSW(popupPage, { type: "set_any_origin", tabId: tabB, any: true })
      const nav = await callAt(baseA, "/navigate", { url: otherUrl })
      if (nav.status !== 403 || nav.json?.error?.code !== "origin_not_allowed") throw new Error(`A navigate: ${nav.status}`)
      if ((await callAt(baseB, "/page_info")).json?.allowed_origins !== "any") throw new Error("B not open")
      if (JSON.stringify((await callAt(baseA, "/page_info")).json?.allowed_origins) !== JSON.stringify([firstOrigin])) throw new Error("A not locked")
      await sendToSW(popupPage, { type: "set_any_origin", tabId: tabB, any: false })
      await shotPill("pill-tab-a")
      if (SHOT_DIR) {
        await other.bringToFront()
        await sleep(400)
        const { cdp, pill } = await pillNodes(other)
        const [x1, y1, , , x3, y3] = (await cdp.send("DOM.getBoxModel", { nodeId: pill.nodeId })).model.border
        await other.screenshot({ path: path.join(SHOT_DIR, "pill-tab-b.png"), clip: { x: Math.max(0, x1 - 16), y: Math.max(0, y1 - 16), width: x3 - x1 + 32, height: y3 - y1 + 32 } })
        await testPage.bringToFront()
      }
    })

    await step("popup on a third tab: Connect, plus both connected tabs with Show and Stop", async () => {
      third = await browser.newPage()
      await third.goto(`http://${GENERIC_SITE_HOST}:${STATIC_PORT}/test-page.html?third`, { waitUntil: "load" })
      await third.bringToFront()
      await popupPage.reload({ waitUntil: "domcontentloaded" })
      await waitFor(async () => { const u = await popupOthers(); return u.shown && u.tabs.length === 2 })
      const u = await popupOthers()
      if (!u.connect || u.stop || u.linkShown || u.link !== "" || u.label !== "AI is connected to 2 other tabs:") throw new Error(JSON.stringify(u))
      if (!u.tabs.includes(tabA) || !u.tabs.includes(tabB)) throw new Error(JSON.stringify(u.tabs))
      if (SHOT_DIR) {
        await popupPage.bringToFront()
        await popupPage.setViewport({ width: 384, height: 900 })
        await sleep(1200)
        const h = await popupPage.evaluate(() => document.body.scrollHeight)
        await popupPage.screenshot({ path: path.join(SHOT_DIR, "popup-unconnected-2.png"), clip: { x: 0, y: 0, width: 384, height: h } })
        await third.bringToFront()
      }
      await popupPage.$eval(`#others-list li[data-tab="${tabB}"] [data-action="show"]`, (n) => n.click())
      await waitFor(() => popupPage.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabB))
    })

    await step("popup on tab B shows B's link, not A's; A under \"Also connected\"", async () => {
      await other.bringToFront()
      await waitFor(async () => { const u = await popupOthers(); return u.link === rB.url && u.stop && !u.connect })
      const u = await popupOthers()
      if (u.label !== "Also connected:" || u.tabs.join() !== String(tabA)) throw new Error(JSON.stringify(u))
      if ((await sendToSW(popupPage, { type: "snapshot", tabId: tabA })).url !== rA.url) throw new Error("A's snapshot lost its link")
      await shotPopup("popup-connected")
    })

    await step("Stop on A (from the popup's list) leaves B working", async () => {
      await clickInPopup(`#others-list li[data-tab="${tabA}"] [data-action="stop"]`)
      await waitFor(async () => (await agentStatus(baseA)) !== 200)
      await waitFor(async () => !(await hasPill(testPage)))
      if (await badge(tabA) !== "") throw new Error("badge left on A")
      if ((await callAt(baseB, "/page_info")).status !== 200 || !(await hasPill(other)) || await badge(tabB) !== "AI") throw new Error("B affected by stopping A")
      await third.bringToFront()
      await waitFor(async () => { const u = await popupOthers(); return u.label === "AI is connected to another tab:" && u.tabs.join() === String(tabB) })
      if (SHOT_DIR) {
        await popupPage.bringToFront()
        await sleep(1200)
        const h = await popupPage.evaluate(() => document.body.scrollHeight)
        await popupPage.screenshot({ path: path.join(SHOT_DIR, "popup-unconnected-1.png"), clip: { x: 0, y: 0, width: 384, height: h } })
      }
      await third.close()
      await testPage.bringToFront()
    })

    await step("timer expiry on A ends only A", async () => {
      await popupPage.evaluate(() => chrome.storage.local.set({ test_session_ms: 6000 }))
      try {
        const r = await sendToSW(popupPage, { type: "connect", tabId: tabA })
        const base = r.url.replace(/\/agents\.md.*$/, "")
        if (await agentStatus(base) !== 200) throw new Error("A not working")
        await waitFor(async () => (await sendToSW(popupPage, { type: "snapshot", tabId: tabA })).status.status === "closed", 20000)
        await waitFor(async () => (await agentStatus(base)) !== 200)
        if ((await callAt(baseB, "/page_info")).status !== 200 || !(await hasPill(other))) throw new Error("B ended with A's timer")
      } finally {
        await popupPage.evaluate(() => chrome.storage.local.remove("test_session_ms"))
      }
    })

    await step("activity log keeps the two tabs' sessions apart", async () => {
      const es = await actEntries()
      const hostA = new URL(testUrl).host, hostB = new URL(other.url()).host
      const clicks = (id) => callsOf(es, "click").filter((e) => e.session === id)
      if (!clicks(sid(rA.url)).length || clicks(sid(rA.url)).some((e) => e.host !== hostA)) throw new Error(`A: ${JSON.stringify(clicks(sid(rA.url)))}`)
      if (clicks(sid(rB.url)).length !== 2 || clicks(sid(rB.url)).some((e) => e.host !== hostB)) throw new Error(`B: ${JSON.stringify(clicks(sid(rB.url)))}`)
      const conn = (id) => eventsOf(es, "connected").find((e) => e.session === id)
      if (conn(sid(rA.url))?.host !== hostA || conn(sid(rB.url))?.host !== hostB) throw new Error("connected events")
      if (!eventsOf(es, "stopped").some((e) => e.session === sid(rA.url))) throw new Error("A's stop not logged")
    })

    await step("closing a connected tab ends its session", async () => {
      await other.close()
      await waitFor(async () => !(await sendToSW(popupPage, { type: "snapshot", tabId: tabA })).others.length)
      await waitFor(async () => eventsOf(await actEntries(), "tab_closed").some((e) => e.session === sid(rB.url)))
      if (await agentStatus(baseB) === 200) throw new Error("agent URL still works after tab close")
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
      await waitFor(async () => await badge(boundTabId) === "")  // cleared after the revoke
      await waitFor(async () => eventsOf(await actEntries(), "stopped").some((e) => e.session === sid(r.url)))
      if (await agentStatus(base) === 200) throw new Error("agent URL still works after Stop")
    })

    // ── 14. Multi-tab edge cases ───────────────────────────────────
    const baseOf = (url) => url.replace(/\/agents\.md.*$/, "")
    const swTarget = () => browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))
    const restartWorker = async () => {
      const sw = swTarget()
      if (!sw) throw new Error("service worker target not found")
      await (await sw.worker()).close()
      await waitFor(async () => !browser.targets().includes(sw), 10000)
      await waitFor(async () => (await sendToSW(popupPage, { type: "snapshot" }).catch(() => null))?.ok === true, 10000)
    }
    const snapOf = (id) => sendToSW(popupPage, { type: "snapshot", tabId: id })
    const shotPopupFor = async (page, name) => {
      if (!SHOT_DIR) return
      await page.bringToFront()
      await popupPage.reload({ waitUntil: "domcontentloaded" })
      await sleep(1500)
      await shotPopup(name)
    }
    const toolsHave = (base, p) => waitFor(async () => (await toolPaths(base)).includes(p), 10000)
    const toolsLack = (base, p) => waitFor(async () => !(await toolPaths(base)).includes(p), 10000)
    let twin, twinId, baseT, ra

    await step("edge: Connect twice at once on one tab → one session", async () => {
      await testPage.bringToFront()
      await testPage.goto(testUrl, { waitUntil: "load" })
      const [x, y] = await Promise.all([sendToSW(popupPage, { type: "connect", tabId: tabA }), sendToSW(popupPage, { type: "connect", tabId: tabA })])
      if (!x.ok || !y.ok || x.url !== y.url) throw new Error(JSON.stringify({ x, y }))
      const z = await sendToSW(popupPage, { type: "connect", tabId: tabA })
      if (z.status !== "already_connected" || z.url !== x.url) throw new Error(JSON.stringify(z))
      if ((await snapOf(tabA)).others.length) throw new Error("a second session appeared")
      ra = x
      baseA = baseOf(x.url)
    })

    await step("edge: two tabs on the same site — Keep/delete reach both; a save from the other tab says it replaces", async () => {
      twin = await browser.newPage()
      await twin.goto(`${testUrl}?twin`, { waitUntil: "load" })
      twinId = await tabIdOf(twin)
      const rt = await sendToSW(popupPage, { type: "connect", tabId: twinId })
      baseT = baseOf(rt.url)
      const one = await callAt(baseA, "/save_site_profile", { tools: [{ path: "/twin_a", description: "a", code: "return 'a'" }] })
      if (one.status !== 200 || one.json?.host !== localHost) throw new Error(JSON.stringify(one))
      await callAt(baseT, "/save_site_profile", { tools: [{ path: "/twin_b", description: "b", code: "return 'b'" }, { path: "/twin_c", description: "c", code: "return 'c'" }] })
      const p = (await sendToSW(popupPage, { type: "list_profiles" })).pending.find((x) => x.host === localHost)
      if (p?.tool_count !== 2 || p.replaced?.tool_count !== 1) throw new Error(JSON.stringify(p))
      await testPage.bringToFront()
      await popupPage.reload({ waitUntil: "domcontentloaded" })
      await waitFor(() => popupPage.evaluate((h) => /Replaces an earlier save from another tab \(on e2e-site\.test:\d+\) with 1 tool that you hadn't reviewed/.test(document.querySelector(`#pending-list li[data-host="${h}"]`)?.textContent ?? ""), localHost))
      await shotPopup("popup-pending-replaced")
      await sendToSW(popupPage, { type: "keep_profile", host: localHost })
      await toolsHave(baseA, "/twin_b"); await toolsHave(baseT, "/twin_b")
      if ((await callAt(baseT, "/twin_c")).json?.value !== "c") throw new Error("kept tool doesn't run on the twin")
      await sendToSW(popupPage, { type: "delete_profile", host: localHost })
      await toolsLack(baseA, "/twin_b"); await toolsLack(baseT, "/twin_b")
    })

    await step("edge: the popup shows the AI's pending saves for its own tab's site (with where they came from); others in Settings", async () => {
      // A session can't save for a site it may not act on.
      const bank = await callAt(baseA, "/save_site_profile", { host: "bank.example", tools: [{ path: "/x", description: "x", code: "return 1" }] })
      if (bank.status !== 403 || bank.json?.error?.code !== "host_not_allowed") throw new Error(`bank: ${bank.status} ${JSON.stringify(bank.json)}`)
      if ((await sendToSW(popupPage, { type: "list_profiles" })).pending.some((p) => p.host === "bank.example")) throw new Error("refused save stored")
      const far = await browser.newPage()
      await far.goto(`${otherUrl}?far`, { waitUntil: "load" })
      const farId = await tabIdOf(far)
      const rf = await sendToSW(popupPage, { type: "connect", tabId: farId })
      if ((await callAt(baseOf(rf.url), "/save_site_profile", { tools: [{ path: "/far", description: "far", code: "return 1" }] })).status !== 200) throw new Error("far save")
      await testPage.bringToFront()
      await waitFor(() => popupPage.evaluate((h) => document.querySelector("#pending-card").hidden
        && /Saved by the AI on e2e-other\.test/.test(document.querySelector(`#pending-other-list li[data-host="${h}"]`)?.textContent ?? ""), otherHost))
      await callAt(baseA, "/save_site_profile", { tools: [{ path: "/near", description: "near", code: "return 1" }] })
      await waitFor(() => popupPage.evaluate((h) => !document.querySelector("#pending-card").hidden
        && [...document.querySelectorAll("#pending-list li")].map((li) => li.dataset.host).join() === h
        && /Saved by the AI on e2e-site\.test/.test(document.querySelector("#pending-list li").textContent)
        && /1 more for other sites/.test(document.querySelector("#pending-elsewhere").textContent), localHost))
      await sendToSW(popupPage, { type: "discard_profile", host: localHost })
      await sendToSW(popupPage, { type: "discard_profile", host: otherHost })
      await far.close()
    })

    await step("edge: two connected tabs in one window — /screenshot of the one behind is refused", async () => {
      await twin.bringToFront()
      const a = await callAt(baseA, "/screenshot")
      if (a.status !== 409 || a.json?.error?.code !== "tab_not_visible") throw new Error(`A: ${a.status} ${JSON.stringify(a.json)}`)
      if ((await callAt(baseT, "/screenshot")).status !== 200) throw new Error("twin screenshot failed")
    })

    let newWin
    await step("edge: a tab dragged to another window keeps working there; Show focuses that window", async () => {
      newWin = await popupPage.evaluate(async (id) => (await chrome.windows.create({ tabId: id, focused: true })).id, twinId)
      await waitFor(async () => (await snapOf(tabA)).others.find((o) => o.id === twinId)?.windowId === newWin).catch(() => { throw new Error("snapshot kept the old windowId") })
      const shot = await callAt(baseT, "/screenshot")
      if (shot.status !== 200) throw new Error(`twin screenshot in its new window: ${shot.status} ${JSON.stringify(shot.json)}`)
      if ((await callAt(baseT, "/page_info")).json?.url !== twin.url()) throw new Error("twin page_info")
      // The popup's Show for the twin targets its current window.
      await testPage.bringToFront()
      await waitFor(() => popupPage.evaluate(({ id, w }) => document.querySelector(`#others-list li[data-tab="${id}"]`)?.dataset.window === String(w), { id: twinId, w: newWin }))
        .catch(() => { throw new Error("popup's Show has the old window") })
      await popupPage.$eval(`#others-list li[data-tab="${twinId}"] [data-action="show"]`, (n) => n.click())
      await waitFor(() => popupPage.evaluate(async (id) => (await chrome.tabs.get(id)).active, twinId))
    })

    await step("edge: Stop all ends every session", async () => {
      await testPage.bringToFront()
      await waitFor(() => popupPage.evaluate(() => !document.querySelector("#stop-all").hidden && document.querySelector("#stop-all").textContent === "Stop all 2 tabs"))
      await clickInPopup("#stop-all")
      await waitFor(async () => (await agentStatus(baseA)) !== 200 && (await agentStatus(baseT)) !== 200)
      await waitFor(async () => !(await hasPill(testPage)) && !(await hasPill(twin)))
      if ((await snapOf(tabA)).others.length) throw new Error("sessions left")
    })

    await step("edge: closing a window with two connected tabs ends both, each logged", async () => {
      const t3 = await popupPage.evaluate(async ({ w, u }) => (await chrome.tabs.create({ windowId: w, url: u })).id, { w: newWin, u: `${testUrl}?third-in-win` })
      await waitFor(() => popupPage.evaluate(async (id) => (await chrome.tabs.get(id)).status === "complete", t3))
      const [r1, r2] = [await sendToSW(popupPage, { type: "connect", tabId: twinId }), await sendToSW(popupPage, { type: "connect", tabId: t3 })]
      if (!r1.ok || !r2.ok) throw new Error(JSON.stringify({ r1, r2 }))
      await popupPage.evaluate((w) => chrome.windows.remove(w), newWin)
      await waitFor(async () => { const es = eventsOf(await actEntries(), "tab_closed"); return [r1, r2].every((r) => es.some((e) => e.session === sid(r.url))) })
      for (const r of [r1, r2]) if (await agentStatus(baseOf(r.url)) === 200) throw new Error("a link still works after its window closed")
      twin = null
    })

    await step("edge: worker restarts with two sessions — both resume; then one refused, the other keeps its link", async () => {
      await testPage.bringToFront()
      const r1 = await sendToSW(popupPage, { type: "connect", tabId: tabA })
      const b2 = await browser.newPage()
      await b2.goto(`${otherUrl}?b2`, { waitUntil: "load" })
      const b2Id = await tabIdOf(b2)
      const r2 = await sendToSW(popupPage, { type: "connect", tabId: b2Id })
      await testPage.bringToFront()
      // A plain restart: both resume, same links.
      await restartWorker()
      // Right away (resume maybe still in flight) each tab knows its own session id.
      for (const [r, id] of [[r1, tabA], [r2, b2Id]]) {
        const sn = await snapOf(id)
        if (!sn.sessionIds.includes(sid(r.url)) || sn.sessionIds.length !== 1) throw new Error(`session ids: ${JSON.stringify(sn.sessionIds)}`)
      }
      for (const [r, id] of [[r1, tabA], [r2, b2Id]]) {
        await waitFor(async () => (await agentStatus(baseOf(r.url))) === 200, 20000)
        const sn = await snapOf(id)
        if (sn.url !== r.url || sn.linkChanged) throw new Error(`after restart: ${JSON.stringify({ url: sn.url, changed: sn.linkChanged })}`)
      }
      // Each tab's popup lists only its own connection events.
      const evA = (await snapOf(tabA)).events
      if (evA.some((e) => e.tab === b2Id || e.sessionId === sid(r2.url))) throw new Error(`A's events include B2's: ${JSON.stringify(evA)}`)
      if (!evA.some((e) => e.type === "resumed" && e.sessionId === sid(r1.url))) throw new Error(`A's resume not listed: ${JSON.stringify(evA)}`)
      // Spoil B2's saved resume secret: the relay will refuse that resume.
      await popupPage.evaluate(async (id) => {
        const k = `as_session:${id}`
        const v = (await chrome.storage.session.get(k))[k]
        await chrome.storage.session.set({ [k]: { ...v, secret: "x".repeat(43) } })
      }, b2Id)
      await restartWorker()
      await waitFor(async () => (await agentStatus(baseOf(r1.url))) === 200, 20000)
      const s1 = await snapOf(tabA)
      if (s1.url !== r1.url || s1.linkChanged) throw new Error(`A: ${JSON.stringify({ url: s1.url, changed: s1.linkChanged })}`)
      let s2
      await waitFor(async () => { s2 = await snapOf(b2Id); return s2.linkChanged && s2.url && s2.url !== r2.url }, 20000)
      if (s2.linkChanged.reason !== "resume_refused" || !s2.linkChanged.afterRestart) throw new Error(JSON.stringify(s2.linkChanged))
      await waitFor(async () => /Link changed/.test(await pillHtml(b2)) && !/Link changed/.test(await pillHtml(testPage)))
      if (await badge(b2Id) !== "NEW" || await badge(tabA) !== "AI") throw new Error(`badges ${await badge(b2Id)} / ${await badge(tabA)}`)
      // (A call on the new link also clears its "link changed" state, so it comes last.)
      if (await agentStatus(baseOf(s2.url)) !== 200) throw new Error("B2's new link doesn't work")
      await b2.close()
      await sendToSW(popupPage, { type: "disconnect", tabId: tabA })
    })

    await step("edge: a busy page in one tab doesn't hold up Stop or Connect in others", async () => {
      const q = await browser.newPage()
      await q.goto(`${otherUrl}?q`, { waitUntil: "load" })
      const r = await browser.newPage()
      await r.goto(`http://${GENERIC_SITE_HOST}:${STATIC_PORT}/test-page.html?r`, { waitUntil: "load" })
      const [qId, rId] = [await tabIdOf(q), await tabIdOf(r)]
      await testPage.bringToFront()
      const ra2 = await sendToSW(popupPage, { type: "connect", tabId: tabA })
      const rq = await sendToSW(popupPage, { type: "connect", tabId: qId })
      if (!ra2.ok || !rq.ok) throw new Error(JSON.stringify({ ra2, rq }))
      // A loads a page that keeps its main thread busy for 10 s; the pill can't go in meanwhile.
      await testPage.evaluate((u) => { location.href = u }, `${testUrl}?spin=10000`)
      await sleep(1500)
      let t0 = Date.now()
      const stopQ = await sendToSW(popupPage, { type: "disconnect", tabId: qId })
      const stopMs = Date.now() - t0
      if (!stopQ.ok || stopMs > 3000) throw new Error(`Stop on Q took ${stopMs} ms: ${JSON.stringify(stopQ)}`)
      if (await badge(qId) !== "") throw new Error(`Q's badge: ${await badge(qId)}`)
      t0 = Date.now()
      const conR = await sendToSW(popupPage, { type: "connect", tabId: rId })
      const conMs = Date.now() - t0
      if (!conR.ok || conMs > 5000) throw new Error(`Connect on R took ${conMs} ms: ${JSON.stringify(conR)}`)
      if (await badge(rId) !== "AI") throw new Error(`R's badge: ${await badge(rId)}`)
      console.log(`       with tab A busy: Stop ${stopMs} ms, Connect ${conMs} ms`)
      // Once A is free again its pill arrives.
      await waitFor(async () => { try { return await hasPill(testPage) } catch { return false } }, 20000)
      await sendToSW(popupPage, { type: "disconnect", tabId: rId })
      await sendToSW(popupPage, { type: "disconnect", tabId: tabA })
      await q.close(); await r.close()
      await testPage.goto(testUrl, { waitUntil: "load" })
    })

    await step("edge: a tab closed while the worker is asleep: its link dies at once", async () => {
      const x = await browser.newPage()
      await x.goto(`${otherUrl}?asleep`, { waitUntil: "load" })
      const rx = await sendToSW(popupPage, { type: "connect", tabId: await tabIdOf(x) })
      await testPage.bringToFront()
      const sw = swTarget()
      await (await sw.worker()).close()
      await waitFor(async () => !browser.targets().includes(sw), 10000)
      await x.close()  // wakes the worker with tabs.onRemoved, before it has restored anything
      await waitFor(async () => (await fetch(rx.url)).status !== 200, 10000)
        .catch(() => { throw new Error("the closed tab's link still serves agents.md") })
      await waitFor(async () => eventsOf(await actEntries(), "tab_closed").some((e) => e.session === sid(rx.url)))
    })

    await step("edge: a saved session whose tab is gone is ended on the relay at the next restart", async () => {
      const y = await browser.newPage()
      await y.goto(`${otherUrl}?gone`, { waitUntil: "load" })
      const yId = await tabIdOf(y)
      const ry = await sendToSW(popupPage, { type: "connect", tabId: yId })
      await testPage.bringToFront()
      // As if the record had been saved under a tab id that no longer exists.
      await popupPage.evaluate(async (id) => {
        const v = (await chrome.storage.session.get(`as_session:${id}`))[`as_session:${id}`]
        await chrome.storage.session.remove(`as_session:${id}`)
        await chrome.storage.session.set({ "as_session:999999": { ...v, tabId: 999999 } })
      }, yId)
      await restartWorker()
      await waitFor(async () => (await fetch(ry.url)).status !== 200, 10000)
        .catch(() => { throw new Error("the unmappable session's link still serves agents.md") })
      if ((await popupPage.evaluate(() => chrome.storage.session.getKeys())).some((k) => k.startsWith("as_session:"))) throw new Error("saved record kept")
      await waitFor(async () => !(await hasPill(y)), 5000)
      await y.close()
    })

    await step("edge: the popup's Activity card: this tab's own calls, or other tabs' labelled with their site", async () => {
      const ra3 = await sendToSW(popupPage, { type: "connect", tabId: tabA })
      await callAt(baseOf(ra3.url), "/get_text", { selector: "#counter" })
      const blank = await browser.newPage()
      await blank.goto(`http://${GENERIC_SITE_HOST}:${STATIC_PORT}/test-page.html?blank`, { waitUntil: "load" })
      await waitFor(() => popupPage.evaluate((h) => document.querySelector("#activity-label").textContent === "Recent activity on other tabs"
        && document.querySelector("#activity-list li .what")?.textContent === `${h} · get_text #counter`, localHost))
      await testPage.bringToFront()
      await blank.close()
      await waitFor(() => popupPage.evaluate(() => document.querySelector("#activity-label").textContent === "Activity in this tab"
        && document.querySelector("#activity-list li .what")?.textContent === "get_text #counter"))
      // Nothing from other sessions on this tab's card.
      const ids = await popupPage.evaluate(() => [...document.querySelectorAll("#activity-list li")].map((li) => li.dataset.id))
      const mine = new Set(callsOf(await actEntries()).filter((e) => e.session === sid(ra3.url)).map((e) => e.id))
      if (!ids.every((id) => mine.has(id))) throw new Error("another session's call on this tab's card")
      // 250 newer calls from another session: this tab's calls still show.
      const flood = await popupPage.evaluate(async () => {
        const at = Date.now(), items = {}
        for (let i = 0; i < 250; i++) {
          const id = `act:${String(at + i).padStart(15, "0")}-flood${i}`
          items[id] = { id, at: at + i, kind: "call", session: "FLOOD000", host: "x.test", tool: "click", summary: "click #x", status: 200 }
        }
        await chrome.storage.local.set(items)
        return Object.keys(items)
      })
      await sleep(1500)  // a poll or two after the change
      const after = await popupPage.evaluate(() => [...document.querySelectorAll("#activity-list li")].map((li) => [li.dataset.id, li.textContent]))
      await popupPage.evaluate((ks) => chrome.storage.local.remove(ks), flood)
      if (!after.length || !after.every(([id]) => mine.has(id))) throw new Error(`card after 250 newer calls elsewhere: ${JSON.stringify(after)}`)
      await sendToSW(popupPage, { type: "disconnect", tabId: tabA })
    })

    let cspPage, cspId
    await step("edge: the /eval CSP warning shows only for a connected tab whose page blocks it", async () => {
      cspPage = await browser.newPage()
      await cspPage.goto(`${testUrl}?csp`, { waitUntil: "load" })
      cspId = await tabIdOf(cspPage)
      await testPage.bringToFront()
      await sendToSW(popupPage, { type: "connect", tabId: tabA })
      const rc = await sendToSW(popupPage, { type: "connect", tabId: cspId })
      const ev = await callAt(baseOf(rc.url), "/eval", { code: "return 1" })
      if (ev.status !== 400 || ev.json?.error?.code !== "csp_blocked_enable_user_scripts") throw new Error(`eval on CSP page: ${ev.status} ${JSON.stringify(ev.json)}`)
      const warn = () => popupPage.evaluate(() => !document.querySelector("#user-scripts-warn").hidden)
      await popupPage.reload({ waitUntil: "domcontentloaded" })
      await sleep(1500)
      if (await warn()) throw new Error("warning on a normal page")
      if (!(await sendToSW(popupPage, { type: "check_user_scripts", tabId: cspId, recheck: true })).blocked) throw new Error("probe says not blocked")
      await cspPage.bringToFront()
      await waitFor(warn)
      await shotPopupFor(cspPage, "popup-csp-warning")
      // Paused on a site the user hasn't allowed: that page isn't probed.
      await cspPage.goto(`${otherUrl}?csp`, { waitUntil: "load" })
      if ((await sendToSW(popupPage, { type: "check_user_scripts", tabId: cspId, recheck: true })).blocked) throw new Error("probed a paused tab")
      await cspPage.goto(`${testUrl}?csp`, { waitUntil: "load" })
      // An unconnected tab is never probed.
      const plain = await browser.newPage()
      await plain.goto(`${testUrl}?csp&unconnected`, { waitUntil: "load" })
      await sleep(1500)
      if (await warn()) throw new Error("warning on an unconnected tab")
      await plain.close()
      // Allow User Scripts on: no warning, and /eval works on the CSP page.
      const d = await browser.newPage()
      await d.goto(`chrome://extensions/?id=${extId}`)
      await sleep(1000)
      const row = await d.$("pierce/#allow-user-scripts")
      await row.evaluate((n) => n.scrollIntoView())
      await (await row.$("pierce/#crToggle")).click()
      await d.close()
      await cspPage.bringToFront()
      await waitFor(async () => !(await warn()), 10000)
      await waitFor(async () => (await callAt(baseOf(rc.url), "/eval", { code: "return 1" })).json?.value === 1, 10000)
    })

    await step("edge: site access turned off ends every session, with the reason", async () => {
      const r1 = await sendToSW(popupPage, { type: "connect", tabId: tabA })
      const r2 = await sendToSW(popupPage, { type: "connect", tabId: cspId })
      const d = await browser.newPage()
      await d.goto(`chrome://extensions/?id=${extId}`)
      await sleep(1000)
      await d.evaluate(() => {
        const find = (n) => n && (n.id === "hostAccess" ? n : [...(n.children ?? []), ...(n.shadowRoot ? [n.shadowRoot] : [])].map(find).find(Boolean))
        const sel = find(document.documentElement)
        sel.value = "ON_CLICK"
        sel.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await d.close()
      await waitFor(async () => (await agentStatus(baseOf(r1.url))) !== 200 && (await agentStatus(baseOf(r2.url))) !== 200, 10000)
      const s = await snapOf(tabA)
      if (s.boundTab || s.status.status !== "closed" || !/site access/.test(s.status.reason)) throw new Error(JSON.stringify(s.status))
      await waitFor(async () => { const es = eventsOf(await actEntries(), "access_removed"); return [r1, r2].every((r) => es.some((e) => e.session === sid(r.url))) })
      await testPage.bringToFront()
      await waitFor(() => popupPage.evaluate(() => /site access for Agent Socket was turned off/.test(document.querySelector("#status-text").textContent)))
      const again = await sendToSW(popupPage, { type: "connect", tabId: tabA })
      if (again.ok || !/site access/.test(again.error)) throw new Error(JSON.stringify(again))
      const act = await browser.newPage()
      await act.goto(`chrome-extension://${extId}/activity.html`, { waitUntil: "domcontentloaded" })
      await waitFor(() => act.evaluate((id) => /site access turned off/.test(document.querySelector(`.group[data-session="${id}"]`)?.textContent ?? ""), sid(r1.url)))
      await act.close()
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
