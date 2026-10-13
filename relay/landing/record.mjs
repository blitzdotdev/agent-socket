// Records /media/demo.mp4 for "Watch it": the page in headless Chromium,
// connected to the live relay through its own "Try it" demo, and a script in
// the agent's seat calling the link. Nothing is staged in the page: the
// figure moves because the calls arrive. Needs ffmpeg and puppeteer-core.
//
//   node relay/landing/record.mjs [page url, default http://127.0.0.1:8940/]
//
// The page is loaded with ?relay=https://agentsocket.dev so the session runs on
// the live relay even when the page is served locally.

import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer-core"

const HERE = dirname(fileURLToPath(import.meta.url))
const MEDIA = join(HERE, "..", "public", "media")
const page_url = (process.argv[2] ?? "http://127.0.0.1:8940/") + "?relay=https://agentsocket.dev"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(MEDIA, { recursive: true })
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1.5 })
await page.goto(page_url, { waitUntil: "networkidle0" })
await page.evaluate(() => document.querySelector("[data-connect]").click())
await page.waitForFunction(() => !document.querySelector("[data-link]").hidden, { timeout: 20000 })
const link = await page.$eval("[data-link]", (el) => el.textContent)
const base = link.replace(/\/agents\.md$/, "")
const plate = await page.evaluate(() => {
  const el = document.querySelector("[data-hero]").closest(".iso-plate")
  el.scrollIntoView({ block: "center" })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
})
await sleep(1200)
const webm = join(MEDIA, "demo.webm")
const recorder = await page.screencast({ path: webm, crop: plate })
const call = (method, path, body) => fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json().catch(() => ({})))

await sleep(1200)
await fetch(link)                                  // the agent reads its notes
await fetch(base + "/tools.json")
for (const [method, path, body, pause] of [
  ["POST", "/send_call", { from: "cloud", to: "laptop" }, 300],
  ["POST", "/send_call", { from: "script", to: "app" }, 300],
  ["POST", "/send_call", { from: "terminal", to: "laptop" }, 600],
  ["POST", "/close_lid", null, 900],
  ["POST", "/send_call", { from: "cloud", to: "laptop" }, 700],
  ["POST", "/send_call", { from: "script", to: "app" }, 600],
  ["POST", "/open_lid", null, 900],
  ["POST", "/send_call", { from: "terminal", to: "laptop" }, 600],
  ["POST", "/pull_plug", { link: "laptop" }, 900],
  ["POST", "/send_call", { from: "cloud", to: "laptop" }, 600],
  ["POST", "/plug_in", { link: "laptop" }, 900],
  ["POST", "/send_call", { from: "script", to: "laptop" }, 1400],
]) {
  const r = await call(method, path, body)
  console.log(method, path, JSON.stringify(body ?? {}), "→", r.result ?? r.now ?? r.laptop ?? JSON.stringify(r))
  await sleep(pause)
}
await recorder.stop()
await page.evaluate(() => document.querySelector("[data-stop]").click())
await browser.close()

// mp4 for every browser, plus a poster from the first second
const mp4 = join(MEDIA, "demo.mp4")
// shown at twice the real speed (the page says so): every call waits for its
// bead's round trip, so real time is about a minute
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", "setpts=0.5*PTS,scale=1600:-2:flags=lanczos,fps=30", "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4])
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1", "-i", mp4, "-frames:v", "1", "-q:v", "4", join(MEDIA, "demo.jpg")])
rmSync(webm)
console.log("wrote", mp4)
