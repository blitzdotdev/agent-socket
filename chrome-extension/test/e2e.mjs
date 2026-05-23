// End-to-end test for the Chrome extension.
//
// Pipeline:
//   1. Start agent-socket relay (wrangler dev on :RELAY_PORT, DEBUG=1)
//   2. Start a tiny static HTTP server for the test page on :STATIC_PORT
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const EXT_DIR = path.resolve(__dirname, "..")
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const RELAY_PORT = parseInt(process.env.RELAY_PORT ?? "8794", 10)
const STATIC_PORT = parseInt(process.env.STATIC_PORT ?? "8795", 10)
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`

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
    ["wrangler", "dev", "--port", String(RELAY_PORT), "--ip", "127.0.0.1", "--var", "DEBUG:1"],
    { cwd: path.join(ROOT, "relay"), stdio: ["ignore", out, out], env: { ...process.env, FORCE_COLOR: "0" } },
  )
  return {
    child,
    log: logFile,
    stop: () => new Promise((resolve) => {
      child.__stopped = true
      child.on("exit", () => resolve())
      try { child.kill("SIGTERM") } catch {}
      setTimeout(() => { try { child.kill("SIGKILL") } catch {}; resolve() }, 3000)
    }),
  }
}

// ── static page server ────────────────────────────────────────────────
function startStatic() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
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
    stop: () => new Promise((r) => srv.close(() => r())),
  })))
}

// ── chrome ────────────────────────────────────────────────────────────
async function launchChrome() {
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
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
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
  let staticSrv, browser, userDataDir
  try {
    staticSrv = await startStatic()
    await waitForRelay()
    console.log("[setup] relay ready")

    const launch = await launchChrome()
    browser = launch.browser; userDataDir = launch.userDataDir
    const extId = await waitForExtensionId(browser)
    console.log(`[setup] extension id: ${extId}`)

    // Open the test page first.
    const testUrl = `${staticSrv.url}/test-page.html`
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
    })

    await step("GET /tools.json lists all universal tools", async () => {
      const j = await (await fetch(`${tokenBase}/tools.json`)).json()
      const have = new Set(j.tools.map((t) => t.path))
      for (const p of ["/eval", "/page_info", "/dom_query", "/click", "/fill", "/wait_for", "/navigate", "/screenshot", "/save_site_profile"]) {
        if (!have.has(p)) throw new Error(`missing ${p}`)
      }
      if (j.tools.length < 15) throw new Error(`expected ≥15 tools, got ${j.tools.length}`)
    })

    // ── 3. Page info / DOM tools ──────────────────────────────────
    await step("POST /page_info reflects the test page", async () => {
      const { status, json } = await callTool("/page_info", {})
      if (status !== 200) throw new Error(`status ${status}`)
      if (!json.url?.includes("test-page.html")) throw new Error(`url=${json.url}`)
      if (!/E2E Test Page/.test(json.title)) throw new Error(`title=${json.title}`)
      if (json.host !== `127.0.0.1:${STATIC_PORT}`) throw new Error(`host=${json.host}`)
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

    // ── 5. Tabs ────────────────────────────────────────────────────
    await step("POST /tabs_list lists the test tab", async () => {
      const { json } = await callTool("/tabs_list", {})
      if (!Array.isArray(json)) throw new Error(`array? ${typeof json}`)
      if (!json.find((t) => (t.url ?? "").includes("test-page.html"))) {
        throw new Error(`test tab not in list`)
      }
    })

    // ── 6. Screenshot ──────────────────────────────────────────────
    await step("POST /screenshot returns a PNG data URL", async () => {
      const { status, json } = await callTool("/screenshot", {})
      if (status !== 200) throw new Error(`status ${status}`)
      if (!json.data_url?.startsWith("data:image/png;base64,")) {
        throw new Error(`bad data url: ${String(json.data_url).slice(0, 80)}`)
      }
    })

    // ── 7. Save & reload site profile ─────────────────────────────
    await step("POST /save_site_profile persists discovered tool", async () => {
      const { status, json } = await callTool("/save_site_profile", {
        host: `127.0.0.1:${STATIC_PORT}`,
        tools: [
          {
            path: "/get_counter",
            description: "Read the current counter value as a number.",
            input_schema: { type: "object", properties: {} },
            code: "return Number(document.getElementById('counter').textContent);",
          },
          {
            path: "/inc_n",
            description: "Click increment N times.",
            input_schema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
            code: "for (let i = 0; i < args.n; i++) document.getElementById('inc-btn').click(); return Number(document.getElementById('counter').textContent);",
          },
        ],
        notes: "Test-page profile — counter & form submit.",
      })
      if (status !== 200 || !json.saved) throw new Error(JSON.stringify(json))
    })

    await step("reconnect surfaces saved tools as first-class", async () => {
      await sendToSW(popupPage, { type: "disconnect" })
      const r = await sendToSW(popupPage, { type: "connect" })
      const expectedHost = `127.0.0.1:${STATIC_PORT}`
      if (!r.ok || r.profile !== expectedHost) throw new Error(`profile=${r.profile} (want ${expectedHost}): ${JSON.stringify(r)}`)
      const newBase = r.url.replace(/\/agents\.md.*$/, "")
      activeTokenBase = newBase
      const tools = await (await fetch(`${newBase}/tools.json`)).json()
      const paths = tools.tools.map((t) => t.path)
      if (!paths.includes("/get_counter")) throw new Error(`/get_counter missing: ${paths.join(",")}`)
      if (!paths.includes("/inc_n")) throw new Error(`/inc_n missing`)
      // Call the discovered tool
      const r1 = await fetch(`${newBase}/get_counter`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      const j1 = await r1.json()
      if (typeof j1.value !== "number") throw new Error(`/get_counter: ${JSON.stringify(j1)}`)
      // And the parameterized one
      const r2 = await fetch(`${newBase}/inc_n`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 3 }) })
      const j2 = await r2.json()
      if (typeof j2.value !== "number" || j2.value < j1.value + 3) {
        throw new Error(`/inc_n didn't increment 3x: before=${j1.value} after=${j2.value}`)
      }
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

    // ── 9. Cleanup ─────────────────────────────────────────────────
    await step("disconnect cleanly", async () => {
      const r = await sendToSW(popupPage, { type: "disconnect" })
      if (r.status !== "idle") throw new Error(JSON.stringify(r))
    })

    console.log(`\n${passed} passed, ${failed} failed`)
  } catch (e) {
    console.log("\n[fatal]", e?.message ?? e)
    if (e?.stack) console.log(e.stack.split("\n").slice(0, 8).join("\n"))
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (staticSrv) await staticSrv.stop()
    await relay.stop()
    if (userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {} }
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
