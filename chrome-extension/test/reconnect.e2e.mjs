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
//      SAME URL works, the in-page pill stays up, and the session timer (changed
//      before the restart) and allowed sites (a second one allowed) are kept.
//   Before 5, the AI saves a site profile and the user keeps it, so the
//   session's tools change (update_tools) on the same URL; both resumes
//   must re-send that current tool set.
//   6b. The relay goes away for a while (laptop asleep, network down) and
//      Chrome stops the worker meanwhile: the pill says "reconnecting", the
//      restarted worker can't reach the relay but keeps the saved session
//      and retries, and once the relay is back (restarted, its Durable
//      Object storage kept) the SAME URL works again with no link change.
//   7. Kill the WS with ?end=1 (session gone, as if the grace window ran
//      out): the resume is refused, the extension re-mints, the popup shows
//      the new URL, the new URL works and the old one is dead.
//   8. Link-changed state after that refused resume: the pill turns into
//      "Link changed … [Copy link] [Stop]", the badge says NEW, the popup
//      shows a banner with the new link and the reason, the diagnostics list
//      the drop + refusal; the old link's 503 tells the AI what to do. Copy in
//      the popup clears it; so does a tool call on the new link, and Copy in
//      the pill. SHOT_DIR=<dir> saves screenshots of the pill and popup.
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
const SHOT_DIR = process.env.SHOT_DIR ?? ""

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
    ["wrangler", "dev", "--port", String(RELAY_PORT), "--ip", "127.0.0.1", "--var", "DEBUG:1", ...(process.env.INSPECTOR_PORT ? ["--inspector-port", process.env.INSPECTOR_PORT] : [])],
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

// Clipboard read from the popup page (an extension page with clipboard-read).
let readClipboard = async () => { throw new Error("clipboard reader not set up") }
async function assertClipboard(want) {
  const got = await readClipboard()
  if (got !== want) throw new Error(`clipboard has ${JSON.stringify(got)}, want ${want}`)
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
  await chrome.browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extId}`, ["clipboard-read", "clipboard-write"])
  readClipboard = async () => {
    await popup.bringToFront()  // readText needs a focused document
    return popup.evaluate(() => navigator.clipboard.readText())
  }

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

  // Timer + site lock are saved with the session: change both before the restart.
  const firstOrigin = `http://127.0.0.1:${STATIC_PORT}`
  const altOrigin = `http://localhost:${STATIC_PORT}`
  let limitsBefore
  await step("change the timer to 4 h and allow a second site", async () => {
    const t = await sendToSW(popup, { type: "set_timer", minutes: 240 })
    if (!t?.ok) throw new Error(JSON.stringify(t))
    await page.goto(`${altOrigin}/`, { waitUntil: "domcontentloaded" })
    const a = await sendToSW(popup, { type: "allow_origin", origin: altOrigin })
    if (!a?.ok) throw new Error(JSON.stringify(a))
    await page.goto(`${firstOrigin}/`, { waitUntil: "domcontentloaded" })
    // Tools swap to the second site's and back; wait for the kept tool again.
    await until(() => keptToolWorks(initialUrl).then(() => true, () => false), "kept tool back", 15000)
    const snap = await sendToSW(popup, { type: "snapshot" })
    if (JSON.stringify(snap.siteLock) !== JSON.stringify({ origins: [firstOrigin, altOrigin], any: false })) throw new Error(JSON.stringify(snap.siteLock))
    limitsBefore = { endsAt: snap.endsAt, siteLock: snap.siteLock }
  })
  const assertLimitsKept = async () => {
    const snap = await sendToSW(popup, { type: "snapshot" })
    if (snap.endsAt !== limitsBefore.endsAt || JSON.stringify(snap.siteLock) !== JSON.stringify(limitsBefore.siteLock)) {
      throw new Error(`limits changed: ${JSON.stringify({ endsAt: snap.endsAt, siteLock: snap.siteLock })} vs ${JSON.stringify(limitsBefore)}`)
    }
    const j = await (await callTool(initialUrl)).json()
    if (j.session_ends_at !== new Date(limitsBefore.endsAt).toISOString() || j.allowed_origins.join() !== `${firstOrigin},${altOrigin}`) throw new Error(JSON.stringify(j))
    const alarm = await popup.evaluate(() => chrome.alarms.get("as-session-end"))
    if (alarm?.scheduledTime !== limitsBefore.endsAt) throw new Error(`alarm: ${JSON.stringify(alarm)}`)
  }

  // ── 2. service-worker restart → resume from chrome.storage.session ──
  const swTarget = chrome.browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))
  // Counted before the stop: the pill's poll can wake a new worker right away.
  const resumesBefore = resumedCount()
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
  await step("after the SW restart: the SAME URL works", async () => {
    await page.bringToFront()  // the pill in the bound tab polls the SW, waking it
    await waitWorks(initialUrl, 20000)
  })
  await step("after the SW restart: the kept tool is still served", () => keptToolWorks(initialUrl))
  await step("a new service worker resumed the session", async () => {
    const sw = chrome.browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))
    if (!sw || sw === swTarget) throw new Error("no new service worker target")
    await until(() => resumedCount() > resumesBefore, "a new resume in the relay log", 5000)
  })
  await step("after the SW restart: pill still on the bound tab, popup connected with the same URL", async () => {
    await sleep(1500)
    if (!(await page.$("agent-socket-indicator"))) throw new Error("pill gone from the bound tab")
    const snap = await sendToSW(popup, { type: "snapshot" })
    if (snap?.status?.status !== "connected" || snap.url !== initialUrl || snap.boundTab?.id == null) {
      throw new Error(`bad snapshot: ${JSON.stringify({ status: snap?.status, url: snap?.url, bound: snap?.boundTab?.id })}`)
    }
  })
  await step("after the SW restart: timer, alarm and allowed sites kept; pill shows the time left", async () => {
    await assertLimitsKept()
    await until(async () => /· 4 h left/.test((await pill())?.html ?? ""), "pill time left")
  })

  // ── 2b. relay unreachable for a while + worker restart meanwhile ──
  const OUTAGE_MS = parseInt(process.env.OUTAGE_MS ?? "20000", 10)
  const pillHtml = async () => (await pill())?.html ?? ""
  await step("the relay goes away (restart with storage kept)", async () => {
    await relay.stop()
    await page.bringToFront()
    await until(async () => /reconnecting/.test(await pillHtml()), "pill says reconnecting", 15000)
  })
  await step("stop the service worker during the outage", async () => {
    const sw = chrome.browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))
    if (!sw) throw new Error("service worker target not found")
    await (await sw.worker()).close()
    const end = Date.now() + 10000
    while (chrome.browser.targets().includes(sw)) {
      if (Date.now() > end) throw new Error("service worker target still alive")
      await sleep(100)
    }
  })
  await step("restarted worker can't reach the relay: keeps the link, retries, pill says reconnecting", async () => {
    await page.bringToFront()  // the pill polls the SW, waking it
    const snap = await until(async () => {
      const s = await sendToSW(popup, { type: "snapshot" }).catch(() => null)
      return s?.events?.some((e) => e.type === "resume_retry") ? s : null
    }, "a resume_retry event", 20000)
    if (snap.url !== initialUrl || snap.boundTab?.id == null || snap.status?.status !== "reconnect-failed" || snap.linkChanged) {
      throw new Error(`bad snapshot during the outage: ${JSON.stringify({ url: snap.url, bound: snap.boundTab?.id, status: snap.status, linkChanged: snap.linkChanged })}`)
    }
    await until(async () => /reconnecting/.test(await pillHtml()), "pill says reconnecting")
  })
  await sleep(OUTAGE_MS)
  await step(`after a ${Math.round(OUTAGE_MS / 1000)} s outage the relay comes back`, async () => {
    relay = startRelay()
    await waitForRelay()
  })
  await step("after the outage: the SAME URL works", () => waitWorks(initialUrl, 60000))
  await step("after the outage: connected, same link, no link-changed notice", async () => {
    const snap = await until(async () => {
      const s = await sendToSW(popup, { type: "snapshot" }).catch(() => null)
      return s?.status?.status === "connected" ? s : null
    }, "connected snapshot", 10000)
    if (snap.url !== initialUrl || snap.linkChanged) throw new Error(JSON.stringify({ url: snap.url, linkChanged: snap.linkChanged }))
    await until(async () => /has access/.test(await pillHtml()), "pill back to normal")
    await assertLimitsKept()
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

  // ── 4. the user is told the link changed ──
  // (before any tool call on the new URL: a tool call clears the state)
  const snapNow = () => sendToSW(popup, { type: "snapshot" })
  const boundTabId = (await snapNow()).boundTab?.id
  const badge = () => popup.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), boundTabId)
  // The pill lives in a closed shadow root; CDP can still see inside it.
  async function pill() {
    const cdp = await page.createCDPSession()
    try {
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true })
      const find = (n, pred) => pred(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map((c) => find(c, pred)).find(Boolean)
      const host = find(root, (n) => n.nodeName === "AGENT-SOCKET-INDICATOR")
      if (!host) return null
      const attr = (n, k) => { const a = n.attributes ?? []; const i = a.findIndex((v, j) => j % 2 === 0 && v === k); return i === -1 ? null : a[i + 1] }
      const node = find(host, (n) => /^pill\b/.test(attr(n, "class") ?? ""))
      const copy = find(host, (n) => attr(n, "data-action") === "copy")
      const html = (await cdp.send("DOM.getOuterHTML", { nodeId: node.nodeId })).outerHTML
      let copyBox = null
      if (copy && attr(copy, "hidden") === null) {
        const [x1, y1, , , x3, y3] = (await cdp.send("DOM.getBoxModel", { nodeId: copy.nodeId })).model.content
        copyBox = { x: (x1 + x3) / 2, y: (y1 + y3) / 2 }
      }
      return { html, copyBox, changed: /class="pill changed"/.test(html) }
    } finally { await cdp.detach().catch(() => {}) }
  }
  async function until(cond, what, ms = 8000) {
    const end = Date.now() + ms
    for (;;) {
      const v = await cond()
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out: ${what}`)
      await sleep(200)
    }
  }
  const popupUi = () => popup.evaluate(() => ({
    banner: !document.querySelector("#changed-card").hidden,
    link: document.querySelector("#changed-input").value,
    reason: document.querySelector("#changed-reason").textContent,
    linkCard: !document.querySelector("#link-card").hidden,
    events: [...document.querySelectorAll("#events-list li")].map((li) => li.textContent),
  }))
  async function assertChanged(url, label) {
    await step(`${label}: pill says the link changed, with Copy link + Stop`, async () => {
      await page.bringToFront()
      const p = await until(async () => { const p = await pill(); return p?.changed && p.copyBox ? p : null }, "pill link-changed state")
      if (!/Link changed — paste the new link into your AI chat/.test(p.html)) throw new Error(p.html)
      if (!/data-action="stop"/.test(p.html)) throw new Error("no Stop")
      if (p.html.includes(url)) throw new Error("the link is in the page DOM")
    })
    await step(`${label}: badge says NEW`, async () => {
      if (await badge() !== "NEW") throw new Error(`badge=${await badge()}`)
    })
    await step(`${label}: popup banner shows the new link and why`, async () => {
      const ui = await until(async () => { const u = await popupUi(); return u.banner && u.link === url ? u : null }, "popup banner")
      if (ui.linkCard) throw new Error("the plain link card is shown too")
      if (!/new link was created/.test(ui.reason)) throw new Error(`reason: ${ui.reason}`)
    })
  }
  async function assertCleared(label) {
    await step(`${label}: pill, badge and popup back to normal`, async () => {
      await until(async () => !(await snapNow()).linkChanged, "state cleared")
      await until(async () => (await badge()) === "AI", "badge AI")
      await until(async () => { const p = await pill(); return p && !p.changed && !p.copyBox }, "pill normal")
      await until(async () => { const u = await popupUi(); return !u.banner && u.linkCard }, "popup normal")
    })
  }

  await assertChanged(newUrl, "refused resume")
  await step("popup diagnostics list the drop, the refusal and the new session", async () => {
    const ev = (await popupUi()).events.join("\n")
    for (const re of [/Connection dropped \(close 1011/, /Resume of \w{8} refused \(close 4401\)/, /New session \w{8}: the link changed/]) {
      if (!re.test(ev)) throw new Error(`no ${re} in:\n${ev}`)
    }
  })
  await step("old URL: 503 app_offline telling the AI to ask for the new link", async () => {
    const r = await callTool(initialUrl)
    const j = await r.json()
    if (r.status !== 503 || j.error?.code !== "app_offline") throw new Error(`${r.status} ${JSON.stringify(j)}`)
    if (!/ask the user to reconnect/.test(j.error.message)) throw new Error(j.error.message)
  })
  if (SHOT_DIR) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.bringToFront()
    await sleep(300)
    await page.screenshot({ path: path.join(SHOT_DIR, "pill-link-changed.png") })
    await popup.bringToFront()
    await popup.setViewport({ width: 384, height: 640 })
    await popup.screenshot({ path: path.join(SHOT_DIR, "popup-link-changed.png"), clip: { x: 0, y: 0, width: 384, height: 640 } })
    await popup.evaluate(() => { document.querySelector("#advanced").open = true })
    await sleep(200)
    await popup.screenshot({ path: path.join(SHOT_DIR, "popup-diagnostics.png"), fullPage: true })
    await popup.evaluate(() => { document.querySelector("#advanced").open = false })
    console.log(`  screenshots in ${SHOT_DIR}`)
  }
  await step("Copy in the popup banner copies the new link and clears the state", async () => {
    await popup.bringToFront()
    await popup.click("#changed-copy")
    await assertClipboard(newUrl)
  })
  await assertCleared("after popup Copy")
  await step("new URL /page_info returns 200", () => waitWorks(newUrl))
  await step("old URL is dead (503 app_offline)", async () => {
    const r = await callTool(initialUrl)
    if (r.status !== 503) throw new Error(`expected 503, got ${r.status}`)
  })

  // A tool call on the new link means the AI has it: clears the state too.
  const nextUrl = async (prev) => {
    const r = await fetch(`${RELAY_BASE}/_debug/kill-ws/${parseSessionId(prev)}?end=1`, { method: "POST" })
    if (!r.ok) throw new Error(`kill-ws ${r.status}`)
    return until(async () => { const s = await snapNow(); return s.linkChanged && s.url && s.url !== prev ? s.url : null }, "new link", 15000)
  }
  const thirdUrl = await step("end the session again: a new link", () => nextUrl(newUrl))
  await assertChanged(thirdUrl, "second refusal")
  await step("a tool call on the new link clears the state", () => waitWorks(thirdUrl))
  await assertCleared("after a tool call")

  // Copy in the pill (127.0.0.1 is a secure context: navigator.clipboard).
  const fourthUrl = await step("end the session a third time: a new link", () => nextUrl(thirdUrl))
  await assertChanged(fourthUrl, "third refusal")
  await step("Copy link in the pill copies the new link and clears the state", async () => {
    await page.bringToFront()
    const p = await pill()
    await page.mouse.click(p.copyBox.x, p.copyBox.y)
    await until(async () => !(await snapNow()).linkChanged, "cleared by the pill")
    await assertClipboard(fourthUrl)
  })
  await assertCleared("after pill Copy")
  await step("the pill's link works", () => waitWorks(fourthUrl))

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
