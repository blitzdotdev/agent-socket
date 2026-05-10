// One-port server that fronts both the static demo + the relay,
// so a single Cloudflare tunnel URL gives end-users access to everything.
//
// Routes:
//   GET  /                              → redirect to /examples/pixel-art-canvas/
//   GET  /examples/*  GET /sdk/*        → static files (rooted at agent-socket/)
//   *    /v1/*  /_debug/*  /_as_*       → proxy to wrangler dev (default :8787)
//   WS   /v1/_ws                        → proxied as a WebSocket upgrade
//
// Usage:
//   node scripts/serve-unified.mjs [--port=8080] [--relay=http://localhost:8787]

import http from "node:http"
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { URL } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "..")  // .../agent-socket/

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=")
    return [a.slice(2, i === -1 ? undefined : i), i === -1 ? "true" : a.slice(i + 1)]
  })
)
const PORT = parseInt(args.port ?? "8080", 10)
const RELAY = (args.relay ?? "http://localhost:8787").replace(/\/+$/, "")
const RELAY_URL = new URL(RELAY)

const RELAY_PREFIXES = ["/v1/", "/_debug/", "/_as_"]
const isRelayPath = (p) => RELAY_PREFIXES.some((pre) => p === pre.replace(/\/$/, "") || p.startsWith(pre))

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".md":   "text/markdown; charset=utf-8",
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname)
  if (urlPath === "/") {
    res.writeHead(302, { location: "/examples/pixel-art-canvas/" })
    res.end()
    return
  }
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
  try { body = fs.readFileSync(filePath) } catch { res.writeHead(404); res.end("not found"); return }
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "cache-control": "no-store",
  })
  res.end(body)
}

function proxyHttp(req, res) {
  const u = new URL(req.url, "http://x")
  const opts = {
    host: RELAY_URL.hostname,
    port: RELAY_URL.port || 80,
    method: req.method,
    path: u.pathname + u.search,
    headers: { ...req.headers, host: `${RELAY_URL.hostname}:${RELAY_URL.port || 80}` },
  }
  const upstream = http.request(opts, (uRes) => {
    res.writeHead(uRes.statusCode ?? 502, uRes.headers)
    uRes.pipe(res)
  })
  upstream.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { code: "upstream_error", message: e.message } }))
    } else {
      res.destroy(e)
    }
  })
  req.pipe(upstream)
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x")
  if (isRelayPath(u.pathname)) return proxyHttp(req, res)
  return serveStatic(req, res)
})

// WebSocket upgrade proxy: pipe raw bytes between the client and the relay.
server.on("upgrade", (req, clientSocket, head) => {
  const u = new URL(req.url, "http://x")
  if (!isRelayPath(u.pathname)) {
    clientSocket.destroy()
    return
  }
  const upstream = net.connect({ host: RELAY_URL.hostname, port: parseInt(RELAY_URL.port || "80", 10) })
  upstream.on("connect", () => {
    // Re-write Host header to match upstream so wrangler dev routes correctly.
    const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`]
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        for (const vv of v) lines.push(`${k}: ${vv}`)
      } else if (typeof v === "string") {
        if (k.toLowerCase() === "host") lines.push(`host: ${RELAY_URL.host}`)
        else lines.push(`${k}: ${v}`)
      }
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n")
    if (head && head.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  const cleanup = () => { try { upstream.destroy() } catch {}; try { clientSocket.destroy() } catch {} }
  upstream.on("error", cleanup)
  upstream.on("close", cleanup)
  clientSocket.on("error", cleanup)
  clientSocket.on("close", cleanup)
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`unified server: http://localhost:${PORT}`)
  console.log(`  static     →  ${PKG_ROOT}`)
  console.log(`  proxied    →  ${RELAY}`)
  console.log(`  open       →  http://localhost:${PORT}/`)
})
