// Puppeteer-based browser driver for visual harness scenarios.
//
// Uses puppeteer-core with system chromium (Alpine ships /usr/bin/chromium;
// don't use Playwright's bundled chromium — it's glibc and segfaults on musl
// per CLAUDE.md).
//
// Exposes `withBrowser(fn)` that handles launch + cleanup, and a tiny static
// file server so visual scenarios can host the demo SPA without depending on
// the user remembering to start one.

import puppeteer from "puppeteer-core"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "../..")  // .../agent-socket/

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"

/**
 * Run an async function with a launched browser. Browser is always closed.
 */
export async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=gl-egl",
      "--disable-background-networking",
      "--window-size=1280,900",
    ],
  })
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

/**
 * Start a static file server rooted at packages/agent-socket. Returns
 * { url, close }. The url is `http://localhost:<port>`.
 */
export async function startStaticServer(port = 0) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname)
    let filePath = path.join(PKG_ROOT, urlPath.replace(/^\/+/, ""))
    if (!filePath.startsWith(PKG_ROOT)) {
      res.writeHead(403); res.end("forbidden"); return
    }
    try {
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) filePath = path.join(filePath, "index.html")
    } catch {
      res.writeHead(404); res.end("not found"); return
    }
    let body
    try { body = fs.readFileSync(filePath) } catch { res.writeHead(404); res.end(); return }
    const ext = path.extname(filePath).toLowerCase()
    const ct = {
      ".html": "text/html; charset=utf-8",
      ".js":   "text/javascript; charset=utf-8",
      ".mjs":  "text/javascript; charset=utf-8",
      ".css":  "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    }[ext] || "application/octet-stream"
    res.writeHead(200, { "content-type": ct, "cache-control": "no-store" })
    res.end(body)
  })
  await new Promise((r) => server.listen(port, "127.0.0.1", r))
  const addr = server.address()
  const realPort = typeof addr === "object" && addr ? addr.port : port
  return {
    url: `http://localhost:${realPort}`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
