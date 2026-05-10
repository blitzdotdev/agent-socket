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

      // Drive set_pixel from the harness side (curl-style). Pixels at
      // (0,0) red, (5,5) green, (31,31) blue.
      const pixels = [
        { x: 0,  y: 0,  color: "#ff0000" },
        { x: 5,  y: 5,  color: "#00ff00" },
        { x: 31, y: 31, color: "#0000ff" },
      ]
      for (const p of pixels) {
        const r = await httpPost(`/v1/t/${token}/set_pixel`, p)
        a.equal(r.status, 200, `set_pixel(${p.x},${p.y},${p.color}) → 200`)
        a.equal(r.json?.ok, true, `set_pixel ok`)
      }

      // Read the canvas state back from the page; verify the cells got painted.
      const grid = await page.evaluate(() => (window).__harness.canvasState())
      a.equal(grid[0][0],   "#ff0000", "(0,0) is red")
      a.equal(grid[5][5],   "#00ff00", "(5,5) is green")
      a.equal(grid[31][31], "#0000ff", "(31,31) is blue")

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
