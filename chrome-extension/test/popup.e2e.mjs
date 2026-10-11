// End-to-end test of the REAL toolbar popup: opened with
// chrome.action.openPopup() and driven through its own buttons, not
// popup.html loaded in a tab (which is what e2e.mjs does, and which hid the
// bugs below: in a tab the popup is never the stale half of an update).
//
//   1. Fresh install: the popup on a web page says "Not connected" and offers
//      Connect; no script errors.
//   2. Connect in the popup: the link shows, is copied, works, and is still
//      there (with Stop and the timer) when the popup is opened again.
//   3. A second tab: its popup offers Connect and lists the first tab;
//      connecting it gives it its own working link; each tab's popup shows
//      its own link.
//   4. Update from an older build with a live session (OLD_REF, default
//      86bafd1, the single-tab build): the files on disk change but Chrome
//      keeps running the old background worker until the extension is
//      reloaded, while the popup always loads from disk. The popup must still
//      show the link or say to reload, never a half-drawn page; its Reload
//      button finishes the update, after which Connect works.
//
// SHOT_DIR=<dir> saves a screenshot of every popup state.
// Run: npm run ext:test:popup   (needs git history for OLD_REF)

import { execFileSync, spawn } from "node:child_process"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer-core"
import { EXT_DIR, testExtensionDir } from "./ext-dir.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"
const RELAY_PORT = parseInt(process.env.RELAY_PORT ?? "8798", 10)
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`
const STATIC_PORT = parseInt(process.env.STATIC_PORT ?? "8799", 10)
const OLD_REF = process.env.OLD_REF ?? "86bafd1"
const SHOT_DIR = process.env.SHOT_DIR ?? ""
const LINK_RE = /^http:\/\/127\.0\.0\.1:\d+\/v1\/t\/as_[0-9A-Za-z]{8}_[\w-]+\/agents\.md$/

// ── runner ────────────────────────────────────────────────────────────
let passed = 0, failed = 0
const failures = []
async function step(name, fn) {
  const t0 = Date.now()
  try { const r = await fn(); passed++; console.log(`  PASS ${name.padEnd(64)} (${Date.now() - t0}ms)`); return r }
  catch (e) { failed++; failures.push({ name, error: e }); console.log(`  FAIL ${name.padEnd(64)} (${Date.now() - t0}ms)\n       ${e?.message ?? e}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 8000, what = "condition") {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`)
}

// ── relay + test pages ────────────────────────────────────────────────
function startRelay() {
  const out = fs.openSync(`/tmp/as-ext-popup-wrangler-${RELAY_PORT}.log`, "w")
  const child = spawn("npx", ["wrangler", "dev", "--port", String(RELAY_PORT), "--ip", "127.0.0.1", "--var", "DEBUG:1"],
    { cwd: path.join(ROOT, "relay"), stdio: ["ignore", out, out], env: { ...process.env, FORCE_COLOR: "0" }, detached: true })
  return () => new Promise((resolve) => {
    child.on("exit", () => resolve())
    try { process.kill(-child.pid, "SIGTERM") } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {}; resolve() }, 3000)
  })
}
async function waitForRelay(deadline = Date.now() + 60000) {
  while (Date.now() < deadline) {
    try { if ((await fetch(`${RELAY_BASE}/_debug/health`)).ok) return } catch {}
    await sleep(250)
  }
  throw new Error("relay never became ready")
}
function startStatic() {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").searchParams.get("p") ?? "page"
    res.writeHead(200, { "content-type": "text/html" })
    res.end(`<!DOCTYPE html><title>Page ${name}</title><h1>${name}</h1>`)
  })
  return new Promise((r) => server.listen(STATIC_PORT, "127.0.0.1", () => r(() => new Promise((c) => server.close(c)))))
}
const pageUrl = (name) => `http://127.0.0.1:${STATIC_PORT}/?p=${name}`

// The extension at OLD_REF, from git.
function oldBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-ext-old-"))
  try {
    const tar = execFileSync("git", ["-C", ROOT, "archive", OLD_REF, "chrome-extension"], { maxBuffer: 64 << 20 })
    execFileSync("tar", ["-x", "-C", dir], { input: tar })
  } catch (e) {
    throw new Error(`can't read ${OLD_REF} from git (a shallow clone needs fetch-depth: 0): ${e.message}`)
  }
  return path.join(dir, "chrome-extension")
}

// ── chromium with the extension, and its real popup ───────────────────
async function launch(extDir) {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: false,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--disable-features=Translate,InterestFeedContentSuggestions",
      `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "as-ext-popup-prof-"))}`, "--window-size=1280,900"],
  })
  // Developer mode, as for anyone who loads the folder unpacked; without it
  // Chrome disables a reloaded command-line extension.
  const ext = await browser.newPage()
  await ext.goto("chrome://extensions")
  await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }))
  await ext.close()
  const t = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 })
  const extId = new URL(t.url()).host
  const env = { browser, extId, worker: null, pages: [] }
  await useWorker(env, t)
  await env.worker.evaluate((base) => chrome.storage.local.set({ relay_base: base }), RELAY_BASE)
  return env
}

async function useWorker(env, target) {
  env.worker = await target.worker()
  await waitFor(() => env.worker.evaluate(() => typeof chrome !== "undefined" && !!chrome.action), 5000, "worker APIs")
}

// The worker after a reload: a new target. An MV3 worker starts on demand, so
// wake it with an extension page that messages it.
async function newWorker(env, old) {
  const waker = await env.browser.newPage()
  await waker.goto(`chrome-extension://${env.extId}/activity.html`)
  await waker.evaluate(() => chrome.runtime.sendMessage({ type: "list_profiles" }))
  await useWorker(env, await env.browser.waitForTarget((t) => t !== old && t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 }))
  await waker.close()
}

async function openTab(env, name) {
  const p = await env.browser.newPage()
  await p.goto(pageUrl(name), { waitUntil: "load" })
  await p.bringToFront()
  for (const o of await env.browser.pages()) if (o.url() === "about:blank") await o.close()
  return p
}

// Opens the toolbar popup over the tab in front and attaches to it. Script
// errors are collected from the start: the page is reloaded once attached.
async function openPopup(env, shot) {
  const got = env.browser.waitForTarget((t) => t.url() === `chrome-extension://${env.extId}/popup.html`, { timeout: 10000 })
  const r = await env.worker.evaluate(() => chrome.action.openPopup().then(() => "ok", (e) => String(e)))
  if (r !== "ok") throw new Error(`openPopup: ${r}`)
  const page = await (await got).asPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.reload({ waitUntil: "load" })
  await sleep(1200)  // first render + one poll
  const popup = { page, errors, shot: (n) => screenshot(popup, n), close: () => page.close().catch(() => {}) }
  if (shot) await popup.shot(shot)
  return popup
}
async function screenshot(popup, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await popup.page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

// What the user sees: only visible elements count.
const view = (popup) => popup.page.evaluate(() => {
  const shown = (s) => { const n = document.querySelector(s); return !!n && !!n.getClientRects().length && getComputedStyle(n).visibility !== "hidden" }
  const text = (s) => (shown(s) ? document.querySelector(s).textContent.trim() : null)
  return {
    status: text("#status-text"),
    connect: shown("#connect-btn"),
    stop: shown("#disconnect-btn"),
    timer: text("#timer-text"),
    link: shown("#link-card") ? document.querySelector("#link-input").value : null,
    copyHint: text("#copy-hint"),
    others: text("#others-label"),
    otherTabs: [...document.querySelectorAll("#others-list li")].filter((li) => li.getClientRects().length).map((li) => li.textContent),
    reload: shown("#stale-card") && shown("#reload-ext"),
    error: text("#error-msg"),
    font: getComputedStyle(document.body).fontFamily.split(",")[0].trim(),
  }
})

function noErrors(popup) {
  if (popup.errors.length) throw new Error(`popup script errors: ${popup.errors.join(" | ")}`)
}
async function linkWorks(link) {
  const r = await fetch(link)
  if (r.status !== 200) throw new Error(`${link} → ${r.status}`)
}
async function connectInPopup(popup) {
  await popup.page.click("#connect-btn")
  // Connect is done once it has tried to copy the link and said so.
  return waitFor(async () => { const v = await view(popup); return v.link && v.stop && /^(Link copied|Paste this)/.test(v.copyHint ?? "") ? v : null }, 10000, "the link after Connect")
}

// ── main ──────────────────────────────────────────────────────────────
const stopRelay = startRelay()
const stopStatic = await startStatic()
const envs = []
try {
  await waitForRelay()
  console.log("── real toolbar popup ──")

  // 1–3: the current build, installed fresh.
  const env = await launch(testExtensionDir())
  envs.push(env)
  const tabA = await openTab(env, "A")
  let linkA

  await step("fresh install: Not connected, Connect offered, no errors", async () => {
    const p = await openPopup(env, "1-fresh")
    const v = await view(p)
    await p.close()
    noErrors(p)
    if (v.status !== "Not connected" || !v.connect || v.stop || v.link) throw new Error(JSON.stringify(v))
    if (v.font !== "Inter") throw new Error(`font ${v.font}`)
  })

  await step("Connect: link shown, copied, works; Stop and timer shown", async () => {
    const p = await openPopup(env)
    const v = await connectInPopup(p)
    await p.shot("2-after-connect")
    await p.close()
    noErrors(p)
    if (!LINK_RE.test(v.link)) throw new Error(`link ${v.link}`)
    if (!/^Link copied/.test(v.copyHint ?? "")) throw new Error(`copy hint ${v.copyHint}`)
    if (!/^Auto-stop in /.test(v.timer ?? "")) throw new Error(`timer ${v.timer}`)
    await linkWorks(v.link)
    linkA = v.link
  })

  await step("reopened on the connected tab: same link, Stop, no errors", async () => {
    const p = await openPopup(env, "3-reopened")
    const v = await view(p)
    await p.close()
    noErrors(p)
    if (v.link !== linkA || !v.stop || v.connect || !/^Connected/.test(v.status ?? "")) throw new Error(JSON.stringify(v))
  })

  const tabB = await openTab(env, "B")
  await step("second tab: Connect offered, first tab listed", async () => {
    const p = await openPopup(env, "4-second-tab")
    const v = await view(p)
    await p.close()
    noErrors(p)
    if (v.status !== "Not connected" || !v.connect || v.link) throw new Error(JSON.stringify(v))
    if (v.others !== "AI is connected to another tab:" || !v.otherTabs[0]?.includes("Page A")) throw new Error(JSON.stringify(v))
  })

  let linkB
  await step("second tab: Connect gives it its own working link", async () => {
    const p = await openPopup(env)
    const v = await connectInPopup(p)
    await p.shot("5-second-tab-connected")
    await p.close()
    noErrors(p)
    if (!LINK_RE.test(v.link) || v.link === linkA) throw new Error(`link ${v.link} (first tab: ${linkA})`)
    if (v.others !== "Also connected:" || !v.otherTabs[0]?.includes("Page A")) throw new Error(JSON.stringify(v))
    await linkWorks(v.link)
    await linkWorks(linkA)
    linkB = v.link
  })

  await step("each tab's popup shows its own link", async () => {
    await tabA.bringToFront()
    const a = await openPopup(env, "6-first-tab-again")
    const va = await view(a)
    await a.close()
    await tabB.bringToFront()
    const b = await openPopup(env)
    const vb = await view(b)
    await b.close()
    noErrors(a); noErrors(b)
    if (va.link !== linkA || vb.link !== linkB) throw new Error(`A: ${va.link} B: ${vb.link}`)
  })
  await env.browser.close()
  envs.pop()

  // 4: an older build with a live session; the folder is then updated.
  const dir = testExtensionDir(oldBuild())
  const old = await launch(dir)
  envs.push(old)
  await openTab(old, "U")
  let oldLink
  await step(`update from ${OLD_REF}: the old build connects`, async () => {
    const p = await openPopup(old)
    await p.page.click("#connect-btn")
    oldLink = await waitFor(() => p.page.evaluate(() => document.querySelector("#link-input").value), 10000, "old link")
    await p.shot("7-old-build-connected")
    await p.close()
    await linkWorks(oldLink)
  })

  testExtensionDir(EXT_DIR, dir)  // the folder now holds this build; Chrome isn't told
  await step("update, not reloaded yet: popup shows the link or says to reload", async () => {
    const p = await openPopup(old, "8-updated-not-reloaded")
    const v = await view(p)
    await p.close()
    noErrors(p)
    if (!(v.link === oldLink && v.stop) && !v.reload) throw new Error(`neither the link nor a reload prompt: ${JSON.stringify(v)}`)
  })

  await step("update: Reload finishes it; the popup works and Connect gives a link", async () => {
    const p = await openPopup(old)
    if (!(await view(p)).reload) throw new Error("no reload button")
    const oldTarget = old.browser.targets().find((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"))
    await p.page.click("#reload-ext").catch(() => {})  // the popup closes as the extension reloads
    await sleep(1500)
    await newWorker(old, oldTarget)
    const q = await openPopup(old, "9-after-reload")
    const v = await view(q)
    if (v.status !== "Not connected" || !v.connect || v.reload || v.font !== "Inter") throw new Error(JSON.stringify(v))
    const c = await connectInPopup(q)
    await q.shot("10-after-reload-connected")
    await q.close()
    noErrors(q)
    await linkWorks(c.link)
  })
} catch (e) {
  failed++
  failures.push({ name: "setup", error: e })
  console.log(`  FAIL setup\n       ${e?.stack ?? e}`)
} finally {
  for (const e of envs) await e.browser.close().catch(() => {})
  await stopStatic()
  await stopRelay()
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error?.message ?? f.error}`)
  process.exit(1)
}
