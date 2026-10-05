// E2E integration test for the chrome extension's WS reconnect path.
//
// Pipeline:
//   1. Start a local wrangler dev (DEBUG=1, so /_debug/kill-ws is available).
//   2. Launch chromium headless=new with the extension loaded.
//   3. Find the extension ID, open the popup, click Connect (programmatically).
//   4. Grab the minted URL; hit a tool endpoint (/page_info) — should 200.
//   5. Force the relay to drop the WS via POST /_debug/kill-ws/<sessionId>.
//      The extension resumes the session: the SAME URL works again and the
//      popup still shows it.
//   6. Stop the extension's service worker (as Chrome does when it idles one
//      out). The restarted worker resumes from chrome.storage.session: the
//      SAME URL works, the in-page pill stays up.
//   Before 5, the AI saves a site profile and the user keeps it, so the
//   session's tools change (update_tools) on the same URL; both resumes
//   must re-send that current tool set.
//   7. Kill the WS with ?end=1 (session gone, as if the grace window ran
//      out): the resume is refused, the extension re-mints, the popup shows
//      the new URL, the new URL works and the old one is dead.
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
import { testExtensionDir } from "./ext-dir.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const EXT_DIR = testExtensionDir()
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
const RELAY_LOG = `/tmp/as-ext-reconnect-wrangler-${RELAY_PORT}.log`
function startRelay() {
  const logFile = RELAY_LOG
  try { fs.unlinkSync(logFile) } catch {}
  const out = fs.openSync(logFile, "w")
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(RELAY_PORT), "--ip", "127.0.0.1", "--var", "DEBUG:1"],
    { cwd: path.join(ROOT, "relay"), stdio: ["ignore", out, out], env: { ...process.env, FORCE_COLOR: "0" }, detached: true },
  )
  return { child, stop: () => new Promise((resolve) => {
    child.on("exit", () => resolve())
    try { process.kill(-child.pid, "SIGTERM") } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {}; resolve() }, 3000)
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

  // Kept profile → live tools; they must survive both kinds of resume.
  const tokenBase = (u) => u.replace(/\/agents\.md$/, "")
  const keptToolWorks = async (u) => {
    const tools = (await (await fetch(`${tokenBase(u)}/tools.json`)).json()).tools.map((t) => t.path)
    if (!tools.includes("/kept_tool")) throw new Error(`/kept_tool not in tools.json: ${tools}`)
    const r = await fetch(`${tokenBase(u)}/kept_tool`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    const j = await r.json()
    if (j.value !== "test page") throw new Error(`/kept_tool → ${r.status} ${JSON.stringify(j)}`)
  }
  await step("save + Keep a profile: its tool goes live on the same URL", async () => {
    const r = await fetch(`${tokenBase(initialUrl)}/save_site_profile`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: [{ path: "/kept_tool", description: "Read the heading.", code: "return document.getElementById('t').textContent" }] }),
    })
    const j = await r.json()
    if (j.status !== "pending_user_approval") throw new Error(JSON.stringify(j))
    const k = await sendToSW(popup, { type: "keep_profile", host: j.host })
    if (!k?.ok || !k.live) throw new Error(JSON.stringify(k))
    await keptToolWorks(initialUrl)
  })

  const toolUrl = (u) => `${u.replace(/\/agents\.md$/, "")}/page_info`
  const callTool = (u) => fetch(toolUrl(u), { method: "POST", headers: {"content-type":"application/json"}, body: "{}" })
  // Poll until the URL answers 200 (the extension reconnects with backoff).
  async function waitWorks(u, ms = 15000) {
    const end = Date.now() + ms
    let last
    while (Date.now() < end) {
      const r = await callTool(u)
      last = `${r.status} ${await r.text()}`
      if (r.status === 200) return
      await sleep(250)
    }
    throw new Error(`URL never worked again; last: ${last}`)
  }
  const popupUrl = () => popup.evaluate(() => document.querySelector("#link-input")?.value ?? "")
  const resumedCount = () => (fs.readFileSync(RELAY_LOG, "utf8").match(new RegExp(`resumed sessionId=${initialSession}`, "g")) ?? []).length

  // ── 1. relay-side WS drop → resume, same URL ──
  await step("force WS close via /_debug/kill-ws", async () => {
    const r = await fetch(`${RELAY_BASE}/_debug/kill-ws/${initialSession}`, { method: "POST" })
    if (!r.ok) throw new Error(`kill-ws returned ${r.status}: ${await r.text()}`)
  })
  await step("right after the drop: tool call → 503 app_offline + Retry-After", async () => {
    const r = await callTool(initialUrl)
    if (r.status === 200) return  // already resumed (fast machine) — fine
    if (r.status !== 503 || r.headers.get("retry-after") !== "2") throw new Error(`expected 503 + Retry-After, got ${r.status} ${r.headers.get("retry-after")}`)
  })
  await step("after the drop: the SAME URL works again", () => waitWorks(initialUrl))
  await step("after the drop: the resume re-sent the kept tool", () => keptToolWorks(initialUrl))
  await step("relay log shows a resume", async () => {
    if (resumedCount() < 1) throw new Error("no 'resumed sessionId=' line in the relay log")
  })
  await step("popup still shows the original URL", async () => {
    await sleep(1200)  // popup polls once a second
    const val = await popupUrl()
    if (val !== initialUrl) throw new Error(`popup shows ${val}, want ${initialUrl}`)
  })

  // ── 2. service-worker restart → resume from chrome.storage.session ──
  const swTarget = chrome.browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))
  await step("stop the extension service worker", async () => {
    if (!swTarget) throw new Error("service worker target not found")
    const worker = await swTarget.worker()
    await worker.close()
    const end = Date.now() + 10000
    while (chrome.browser.targets().includes(swTarget)) {
      if (Date.now() > end) throw new Error("service worker target still alive")
      await sleep(100)
    }
  })
  const resumesBefore = resumedCount()
  await step("after the SW restart: the SAME URL works", async () => {
    await page.bringToFront()  // the pill in the bound tab polls the SW, waking it
    await waitWorks(initialUrl, 20000)
  })
  await step("after the SW restart: the kept tool is still served", () => keptToolWorks(initialUrl))
  await step("a new service worker resumed the session", async () => {
    const sw = chrome.browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))
    if (!sw || sw === swTarget) throw new Error("no new service worker target")
    if (resumedCount() <= resumesBefore) throw new Error("relay log shows no new resume")
  })
  await step("after the SW restart: pill still on the bound tab, popup connected with the same URL", async () => {
    await sleep(1500)
    if (!(await page.$("agent-socket-indicator"))) throw new Error("pill gone from the bound tab")
    const snap = await sendToSW(popup, { type: "snapshot" })
    if (snap?.status?.status !== "connected" || snap.url !== initialUrl || snap.boundTab?.id == null) {
      throw new Error(`bad snapshot: ${JSON.stringify({ status: snap?.status, url: snap?.url, bound: snap?.boundTab?.id })}`)
    }
  })

  // ── 3. session gone → resume refused → re-mint ──
  await step("end the session via /_debug/kill-ws?end=1", async () => {
    const r = await fetch(`${RELAY_BASE}/_debug/kill-ws/${initialSession}?end=1`, { method: "POST" })
    if (!r.ok) throw new Error(`kill-ws returned ${r.status}: ${await r.text()}`)
  })
  const newUrl = await step("popup reflects a new URL after the refused resume", async () => {
    const end = Date.now() + 15000
    for (;;) {
      const val = await popupUrl()
      if (val && val !== initialUrl) return val
      if (Date.now() > end) throw new Error(`link-input still shows ${val}`)
      await sleep(250)
    }
  })
  console.log(`  new paste URL:    ${newUrl}`)
  const newSession = parseSessionId(newUrl)
  if (newSession === initialSession) throw new Error("sessionId did NOT change after the session ended")
  await step("new URL /page_info returns 200", () => waitWorks(newUrl))
  await step("old URL is dead (503 app_offline)", async () => {
    const r = await callTool(initialUrl)
    if (r.status !== 503) throw new Error(`expected 503, got ${r.status}`)
  })

  console.log(`\n──  ${passed} passed, ${failed} failed`)
}

main()
  .catch((e) => { console.error("\nFATAL:", e?.message ?? e); failed++ })
  .finally(async () => {
    try { await chrome?.browser?.close() } catch {}
    try { await relay?.stop() } catch {}
    try { await statics?.close() } catch {}
    try { fs.rmSync(EXT_DIR, { recursive: true, force: true }) } catch {}
    process.exit(failed === 0 ? 0 : 1)
  })
