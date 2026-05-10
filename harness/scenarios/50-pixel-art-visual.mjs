// 50-pixel-art-visual — drives the pixel-art-canvas demo via puppeteer.
//
// 1. Start a static file server rooted at the package root so the demo
//    can resolve ../../sdk/dist/index.js.
// 2. Launch chromium (system /usr/bin/chromium per CLAUDE.md), open the
//    demo with ?harness=1.
// 3. Wait for window.__harness.ready and SDK connection.
// 4. Mint a token via __harness.mintToken(); record the URL.
// 5. From the harness, curl /set_pixel three times with different colors.
// 6. Read window.__harness.canvasState() back through the page; verify
//    the pixels match what was painted.
// 7. Take a screenshot for manual inspection.
//
// Skipped (with PASS) if /usr/bin/chromium isn't installed — non-Alpine
// hosts may not have it where expected.

import { Assert } from "../lib/assert.mjs"
import { httpPost, RELAY_HTTP } from "../lib/relay.mjs"
import { withBrowser, startStaticServer } from "../lib/browser.mjs"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"

export default async function () {
  const a = new Assert("50-pixel-art-visual")

  if (!fs.existsSync(CHROMIUM_PATH)) {
    a.pass(`skipped — ${CHROMIUM_PATH} not present (set CHROMIUM_PATH or apk add chromium)`)
    return
  }

  const server = await startStaticServer(0)
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage()
      await page.setViewport({ width: 1280, height: 900 })
      const consoleLines = []
      page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
      page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`))

      // Load the demo, point it at the relay running on RELAY_HTTP.
      const u = `${server.url}/examples/pixel-art-canvas/?harness=1&relay=${encodeURIComponent(RELAY_HTTP)}`
      await page.goto(u, { waitUntil: "networkidle2", timeout: 15_000 })

      // Wait for the harness hook to mount.
      await page.waitForFunction(() => (window).__harness?.ready === true, { timeout: 5_000 })
      a.pass("__harness ready")

      // Trigger SDK connection from the page; returns the new sessionId.
      const sessionId = await page.evaluate(async () => (window).__harness.connect())
      a.ok(typeof sessionId === "string" && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(sessionId),
        "SDK connected from browser, sessionId is Crockford-base32",
        { sessionId, consoleLines: consoleLines.slice(-6) })

      // Mint a token from the page.
      const url = await page.evaluate(async () => (window).__harness.mintToken("visual-test"))
      a.ok(typeof url === "string" && url.includes("/v1/t/") && url.endsWith("/agents.md"),
        "minted URL has the expected shape",
        { url })

      // Extract the agent-token from the URL.
      const tokenMatch = url.match(/\/v1\/t\/([^/]+)\/agents.md$/)
      a.ok(tokenMatch, "URL contains a parseable token")
      const token = tokenMatch[1]

      // Clear before painting so we start from known state.
      await httpPost(`/v1/t/${token}/clear`, {})

      // 1. Single set_pixel — backcompat.
      const r1 = await httpPost(`/v1/t/${token}/set_pixel`, { x: 0, y: 0, color: "#ff0000" })
      a.equal(r1.status, 200, "set_pixel → 200")
      a.equal(r1.json?.ok, true, "set_pixel ok")

      // 2. Batch set_pixels — green diagonal in one call.
      const batch = []
      for (let i = 1; i <= 5; i++) batch.push({ x: i, y: i, color: "#00ff00" })
      const r2 = await httpPost(`/v1/t/${token}/set_pixels`, { pixels: batch })
      a.equal(r2.status, 200, "set_pixels → 200")
      a.equal(r2.json?.painted, 5, "set_pixels painted all 5")

      // 3. fill_rect — solid blue 8×8 in the corner.
      const r3 = await httpPost(`/v1/t/${token}/fill_rect`, { x: 24, y: 24, w: 8, h: 8, color: "#0000ff" })
      a.equal(r3.status, 200, "fill_rect → 200")
      a.equal(r3.json?.painted, 64, "fill_rect painted 64 cells")

      // 4. Out-of-range entries silently skipped.
      const r4 = await httpPost(`/v1/t/${token}/set_pixels`, { pixels: [
        { x: 10, y: 10, color: "#ffffff" },
        { x: 99, y: 99, color: "#ffffff" },
        { x: -1, y: 0,  color: "#ffffff" },
      ]})
      a.equal(r4.status, 200, "set_pixels with OOR entries → 200")
      a.equal(r4.json?.painted, 1, "1 painted")
      a.equal(r4.json?.skipped, 2, "2 skipped")

      // Read the canvas state back from the page.
      const grid = await page.evaluate(() => (window).__harness.canvasState())
      a.equal(grid[0][0],   "#ff0000", "(0,0) red (set_pixel)")
      a.equal(grid[3][3],   "#00ff00", "(3,3) green (set_pixels diagonal)")
      a.equal(grid[31][31], "#0000ff", "(31,31) blue (fill_rect)")
      a.equal(grid[10][10], "#ffffff", "(10,10) white (set_pixels mixed)")
      a.equal(grid[20][20], "#0f0f12", "(20,20) bg (untouched)")

      // Save a screenshot for manual inspection.
      const outdir = path.join(os.tmpdir(), "agent-socket-visual")
      fs.mkdirSync(outdir, { recursive: true })
      await page.screenshot({ path: path.join(outdir, "pixel-art.png") })
      a.pass(`screenshot at ${outdir}/pixel-art.png`)
    })
  } finally {
    await server.close()
  }
}
