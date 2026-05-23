// E2E integration test for the chrome extension's WS reconnect path.
//
// Pipeline:
//   1. Start a local wrangler dev (DEBUG=1, so /_debug/kill-ws is available).
//   2. Launch chromium headless=new with the extension loaded.
//   3. Find the extension ID, open the popup, click Connect (programmatically).
//   4. Grab the minted URL; hit a tool endpoint (/page_info) — should 200.
//   5. Force the relay to drop the WS via POST /_debug/kill-ws/<sessionId>.
//   6. Wait for the reconnect (exp backoff: 1s base + jitter).
//   7. Verify either:
//        (a) original URL still works (rare — relay drops the in-memory
//            session entirely, so we expect (b)), OR
//        (b) popup's linkInput reflects the new URL, and the new URL works.
//
// Run: node chrome-extension/test/reconnect.e2e.mjs
//
// Requirements: /usr/bin/chromium (or CHROMIUM_PATH=...), node + puppeteer-core
// already in packages/agent-socket/node_modules.

import { spawn } from "node:child_process"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer-core"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const EXT_DIR = path.resolve(__dirname, "..")
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"
const RELAY_PORT = parseInt(process.env.RELAY_PORT ?? "8796", 10)
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`
const STATIC_PORT = parseInt(process.env.STATIC_PORT ?? "8797", 10)

// ── small assert harness ────────────────────────────────────────
let passed = 0, failed = 0
const failures = []
async function step(name, fn) {
  const t0 = Date.now()
  try { const r = await fn(); passed++; console.log(`  PASS ${name.padEnd(60)} (${Date.now()-t0}ms)`); return r }
  catch (e) { failed++; failures.push({name, error:e}); console.log(`  FAIL ${name.padEnd(60)} (${Date.now()-t0}ms)\n       ${e?.message ?? e}`); throw e }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── relay ────────────────────────────────────────────────────────
async function waitForRelay(deadline = Date.now() + 30000) {
  while (Date.now() < deadline) {
    try { const r = await fetch(`${RELAY_BASE}/_debug/health`); if (r.ok) return } catch {}
    await sleep(250)
  }
  throw new Error("relay never became ready")
}
function startRelay() {
  const logFile = "/tmp/as-ext-reconnect-wrangler.log"
  try { fs.unlinkSync(logFile) } catch {}
  const out = fs.openSync(logFile, "w")
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(RELAY_PORT), "--ip", "127.0.0.1", "--var", "DEBUG:1"],
    { cwd: path.join(ROOT, "relay"), stdio: ["ignore", out, out], env: { ...process.env, FORCE_COLOR: "0" } },
  )
  return { child, stop: () => new Promise((resolve) => {
    child.on("exit", () => resolve())
    try { child.kill("SIGTERM") } catch {}
    setTimeout(() => { try { child.kill("SIGKILL") } catch {}; resolve() }, 3000)
  })}
}

// ── tiny static server (test page for the chrome ext to attach to) ──
function startStatic() {
  const html = `<!DOCTYPE html><html><body><h1 id="t">test page</h1></body></html>`
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {"content-type":"text/html"})
    res.end(html)
  })
  return new Promise((resolve) => server.listen(STATIC_PORT, "127.0.0.1", () => resolve({ server, close: () => new Promise((r) => server.close(() => r())) })))
}

// ── chromium ──────────────────────────────────────────────────────
async function launchChrome() {
  const userDataDir = fs.mkdtempSync("/tmp/as-ext-reconnect-")
  // Alpine GL args (match scripts/screenshot.sh):
  const isAlpine = fs.existsSync("/etc/alpine-release")
  const glArgs = isAlpine ? ["--use-gl=angle", "--use-angle=gl-egl"] : []
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "new",
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
      ...glArgs,
    ],
    defaultViewport: null,
  })
  return { browser, userDataDir }
}

async function waitForExtensionId(browser, timeout = 15000) {
  // The SW shows up as a `service_worker` target. Find it via target list.
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const targets = browser.targets()
    const sw = targets.find((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"))
    if (sw) {
      const m = sw.url().match(/^chrome-extension:\/\/([a-p]+)\//)
      if (m) return m[1]
    }
    await sleep(200)
  }
  throw new Error("extension service-worker target not seen")
}

async function openPopup(browser, extId) {
  const popupUrl = `chrome-extension://${extId}/popup.html`
  const page = await browser.newPage()
  await page.goto(popupUrl, { waitUntil: "domcontentloaded" })
  return page
}

async function sendToSW(popupPage, msg, timeoutMs = 10000) {
  // popup.html runs in an extension context with full chrome.* APIs.
  return popupPage.evaluate(async (msg, timeoutMs) => {
    const p = chrome.runtime.sendMessage(msg)
    return await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("sendMessage timeout")), timeoutMs)),
    ])
  }, msg, timeoutMs)
}

function parseSessionId(url) {
  const m = url.match(/\/v1\/t\/as_([0-9A-HJKMNP-TV-Z]{8})_/)
  return m ? m[1] : null
}

// ── main ─────────────────────────────────────────────────────────
let chrome, relay, statics
async function main() {
  console.log("── chrome-ext WS reconnect E2E ──")
  console.log(`  CHROMIUM=${CHROMIUM}`)

  console.log("starting relay…")
  relay = startRelay()
  await waitForRelay()
  console.log(`  relay ready on ${RELAY_BASE}`)

  statics = await startStatic()
  console.log(`  static page on http://127.0.0.1:${STATIC_PORT}/`)

  console.log("launching chromium…")
  chrome = await launchChrome()

  // Override extension's default relay base.
  const extId = await step("locate extension service-worker target", () => waitForExtensionId(chrome.browser))
  console.log(`  extension id: ${extId}`)

  // Open a tab on the static page so the extension has an active tab to drive.
  const page = await chrome.browser.newPage()
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/`, { waitUntil: "domcontentloaded" })

  // Open popup.
  const popup = await openPopup(chrome.browser, extId)

  // Configure the extension to use our local relay.
  await step("set relay base to local wrangler dev", async () => {
    const r = await sendToSW(popup, { type: "set_relay_base", base: RELAY_BASE })
    if (!r?.ok) throw new Error(`set_relay_base failed: ${JSON.stringify(r)}`)
  })

  // Activate the test tab (so the extension knows which tab to operate on).
  await page.bringToFront()
  await sleep(200)

  // Connect.
  const initialUrl = await step("connect via popup", async () => {
    const r = await sendToSW(popup, { type: "connect" })
    if (!r?.ok && !r?.url) throw new Error(`connect failed: ${JSON.stringify(r)}`)
    return r.url
  })
  console.log(`  initial paste URL: ${initialUrl}`)
  const initialSession = parseSessionId(initialUrl)
  if (!initialSession) throw new Error("could not parse session-id from URL")
  console.log(`  initial sessionId: ${initialSession}`)

  // Pre-kill tool call: /page_info should 200.
  await step("pre-kill: /page_info returns 200", async () => {
    const r = await fetch(`${initialUrl.replace(/\/agents\.md$/, "")}/page_info`, {
      method: "POST", headers: {"content-type":"application/json"}, body: "{}",
    })
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${await r.text()}`)
  })

  // FORCE the WS to drop (relay-side). This simulates exactly the production
  // bug: WS closes from the server, extension's _onClose fires.
  await step("force WS close via /_debug/kill-ws", async () => {
    const r = await fetch(`${RELAY_BASE}/_debug/kill-ws/${initialSession}`, { method: "POST" })
    if (!r.ok) throw new Error(`kill-ws returned ${r.status}: ${await r.text()}`)
  })

  // Old URL should now 503 — the session is dead at the relay.
  await step("post-kill, pre-reconnect: old URL returns 503 app_offline", async () => {
    await sleep(300)  // let the relay tear down the session
    const r = await fetch(`${initialUrl.replace(/\/agents\.md$/, "")}/page_info`, {
      method: "POST", headers: {"content-type":"application/json"}, body: "{}",
    })
    if (r.status !== 503) throw new Error(`expected 503, got ${r.status}`)
  })

  // Wait for the extension's reconnect logic to fire + remint.
  // Backoff base 1s; allow up to ~4s for the connect+register+mint to land.
  await sleep(4000)

  // The popup should have received a `url_changed` event and updated its
  // linkInput. Read the live value.
  const newUrl = await step("popup reflects new URL after reconnect", async () => {
    const val = await popup.evaluate(() => document.querySelector("#link-input")?.value ?? "")
    if (!val) throw new Error("link-input empty after reconnect")
    if (val === initialUrl) throw new Error(`link-input still shows the dead URL: ${val}`)
    return val
  })
  console.log(`  new paste URL:    ${newUrl}`)
  const newSession = parseSessionId(newUrl)
  console.log(`  new sessionId:    ${newSession}`)
  if (newSession === initialSession) throw new Error("sessionId did NOT change — reconnect didn't actually fire")

  // Post-reconnect: the new URL should work.
  await step("post-reconnect: new URL /page_info returns 200", async () => {
    const r = await fetch(`${newUrl.replace(/\/agents\.md$/, "")}/page_info`, {
      method: "POST", headers: {"content-type":"application/json"}, body: "{}",
    })
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${await r.text()}`)
  })

  console.log(`\n──  ${passed} passed, ${failed} failed`)
}

main()
  .catch((e) => { console.error("\nFATAL:", e?.message ?? e); failed++ })
  .finally(async () => {
    try { await chrome?.browser?.close() } catch {}
    try { await relay?.stop() } catch {}
    try { await statics?.close() } catch {}
    process.exit(failed === 0 ? 0 : 1)
  })
