// The GPU browser server: a Chromium on this machine, shared with agents
// through an agent-socket link. In an install it runs as the dedicated
// agent-socket-gpu-browser account; see ../README.md.
//
// The boundary is fixed here; everything inside it is free:
// - its own Chromium with its sandbox on, every request forced through the
//   filtering proxy below (password-protected, so nothing else on this
//   machine can use it): hosts on the allowlist only, ports 80/443,
//   hostnames only, and nothing that resolves to a private, loopback or
//   link-local address (checked on the address it then connects to, so DNS
//   rebinding can't slip through). Uploads are served at UPLOAD_ORIGIN from
//   memory.
// - agent code runs only inside pages.
// - widening (a new host) needs the owner: an `ask` event goes out, the
//   answer comes back on stdin.
//
// stdin: first line a JSON config (relay, key, allow, minutes, chromium),
// then `answer <id> <allow|always|deny>` or `stop`. stdout: log lines for
// the owner, and events `@@gpu-browser:<key> <name> ...` that only whoever
// chose the key (the CLI) can tell apart from log text.
//
// `node server.mjs --self-test` launches Chromium, draws a WebGL canvas,
// prints one JSON line about the GPU and exits (used by the installer).

import http from "node:http"
import net from "node:net"
import dns from "node:dns/promises"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { UPLOAD_ORIGIN, clean, gpuFlags, hostAllowed, privateAddr, refuseTarget, validFilePath, validHost, validToolPath } from "./policy.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Installed: <dir>/app/server.mjs next to <dir>/browsers and <dir>/VERSION.
const INSTALLED = fs.existsSync(path.join(HERE, "..", "VERSION"))
if (INSTALLED) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(HERE, "..", "browsers")
  // The account's own home, whatever HOME sudo passed on (Apple's sudoers
  // keeps the caller's). Chromium profiles and Playwright temp files stay there.
  process.env.HOME = os.userInfo().homedir
  // Likewise the XDG directories (some sudoers keep them): Chromium puts its
  // crash reports under XDG_CONFIG_HOME and dies if it can't create them.
  for (const k of Object.keys(process.env)) if (k.startsWith("XDG_")) delete process.env[k]
  process.env.XDG_CONFIG_HOME = path.join(os.homedir(), ".config")
  process.env.XDG_CACHE_HOME = path.join(os.homedir(), ".cache")
  process.env.TMPDIR = path.join(os.homedir(), "tmp")
  fs.rmSync(process.env.TMPDIR, { recursive: true, force: true })
  fs.mkdirSync(process.env.TMPDIR, { mode: 0o700, recursive: true })
}
// A self-test that fails reports Chromium's own last log lines: Playwright
// prints them under DEBUG=pw:browser (read when it is imported); they are
// kept here instead of going to stderr.
const SELF_TEST = process.argv.includes("--self-test")
const chromiumLog = { errors: [], tail: [] } // errors: the first lines that name a failure
if (SELF_TEST) {
  process.env.DEBUG = "pw:browser"
  process.stderr.write = (chunk) => {
    for (let l of String(chunk).split("\n")) {
      if (!l.trim() || /dbus|ssl_client|handshake failed|cv_display_link/.test(l)) continue
      l = l.replace(/^\S+ pw:browser /, "").slice(0, 300)
      if (/ERROR|FATAL|Check failed|signal|Received|Terminating|exception/i.test(l) && chromiumLog.errors.length < 15) chromiumLog.errors.push(l)
      chromiumLog.tail.push(l)
      if (chromiumLog.tail.length > 8) chromiumLog.tail.shift()
    }
    return true
  }
}
const { chromium } = await import("playwright-core")

const LIMITS = {
  pages: 8, fileBytes: 64 << 20, files: 2000, resultChars: 256_000, opMs: 25_000, idleMs: 15 * 60_000,
  tools: 30, askMs: 15 * 60_000, hostsPerAsk: 10, asks: 10, logLines: 100,
  // One reply is one WebSocket frame, and the relay ends the whole session
  // on a frame over 4,194,304 characters. Replies are measured against this
  // budget first; images over a part's size come back in parts (/image).
  replyChars: 4_000_000, partBytes: 2_800_000, imageBytes: 64 << 20, imageMs: 10 * 60_000,
}
const TYPES = {
  html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  json: "application/json", map: "application/json", txt: "text/plain", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", ktx2: "image/ktx2", glb: "model/gltf-binary", gltf: "model/gltf+json",
  wasm: "application/wasm", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
}

const out = (line) => process.stdout.write(line + "\n")
const log = (msg) => out(clean(msg))
let KEY = ""
const event = (e) => out("@@gpu-browser:" + KEY + " " + e)
const b64 = (s) => Buffer.from(s, "utf8").toString("base64")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (code, message) => Object.assign(new Error(message), { code })
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw fail("timeout", what + " timed out after " + ms + " ms") })])
const err = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } })

// ── network: allowlist + filtering proxy ─────────────────────────────
const allowed = new Set()
const refused = new Map() // host -> why the proxy refused it (newest 200), for per-page reports

async function vet(host, port) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  const deny = (reason) => {
    refused.delete(h); refused.set(h, reason)
    if (refused.size > 200) refused.delete(refused.keys().next().value)
    return { reason }
  }
  const why = refuseTarget(allowed, h, port)
  if (why) return deny(why)
  let addrs
  try { addrs = await dns.lookup(h, { all: true, verbatim: true }) } catch { return deny("does not resolve") }
  if (!addrs.length) return deny("does not resolve")
  for (const a of addrs) if (privateAddr(a.address)) return deny("resolves to a private address")
  return { address: addrs[0].address, addrs: addrs.map((a) => a.address) }
}

// Per-run credentials: the proxy listens on loopback, which other local
// programs (and containers that reach the host's loopback) can connect to.
const PROXY_USER = "gpu-browser"
const PROXY_PASS = crypto.randomBytes(18).toString("base64url")
const PROXY_AUTH = Buffer.from("Basic " + Buffer.from(PROXY_USER + ":" + PROXY_PASS).toString("base64"))
function authorized(req) {
  const got = Buffer.from(String(req.headers["proxy-authorization"] || ""))
  return got.length === PROXY_AUTH.length && crypto.timingSafeEqual(got, PROXY_AUTH)
}
const NEED_AUTH = "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"gpu-browser\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

// Connect to the first address that answers (all were vetted as public),
// giving each at most 5 s so one that drops packets can't use up the page's
// time. Returns a cancel function for when the client goes away first.
function connectAny(addrs, port, onConnect, onFail) {
  let sock = null, timer = null, done = false
  const next = (i) => {
    if (done) return
    if (i >= addrs.length) { done = true; return onFail() }
    const s = sock = net.connect(port, addrs[i])
    let moved = false
    const fallback = () => { if (moved) return; moved = true; clearTimeout(timer); s.destroy(); next(i + 1) }
    timer = setTimeout(fallback, 5000)
    s.once("error", fallback)
    // Once connected, errors belong to the tunnel, never to the next address.
    s.once("connect", () => { moved = true; clearTimeout(timer); s.off("error", fallback); done = true; onConnect(s) })
  }
  next(0)
  return () => { if (!done) { done = true; clearTimeout(timer); sock?.destroy() } }
}

function startProxy() {
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) { res.socket?.end(NEED_AUTH); return }
    let u
    try { u = new URL(req.url) } catch { res.writeHead(400).end(); return }
    if (u.protocol !== "http:") { res.writeHead(400).end(); return }
    const port = Number(u.port || 80)
    const v = await vet(u.hostname, port)
    if (v.reason) { res.writeHead(403, { "content-type": "text/plain", "x-agent-socket-blocked": "1" }).end(u.hostname + ": " + v.reason); return }
    const headers = { ...req.headers, host: u.host }
    delete headers["proxy-connection"]
    delete headers["proxy-authorization"]
    const up = http.request({ host: v.address, port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers)
      r.pipe(res)
    })
    up.on("error", () => res.destroy())
    req.pipe(up)
  })
  server.on("connect", async (req, sock, head) => {
    sock.on("error", () => {})
    if (!authorized(req)) { sock.end(NEED_AUTH); return }
    const i = req.url.lastIndexOf(":")
    const port = Number(req.url.slice(i + 1))
    const v = await vet(req.url.slice(0, i), port)
    if (v.reason) { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return }
    const cancel = connectAny(v.addrs, port, (up) => {
      if (sock.destroyed) return up.destroy()
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head?.length) up.write(head)
      up.pipe(sock)
      sock.pipe(up)
      up.on("error", () => sock.destroy())
      sock.on("close", () => up.destroy())
    }, () => sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
    sock.on("close", cancel)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

// ── uploads, served at UPLOAD_ORIGIN ─────────────────────────────────
const files = new Map() // path -> { buf, type }
let fileBytes = 0
const typeOf = (p) => TYPES[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream"
function putFile(f) {
  const p = typeof f?.path === "string" ? f.path.replace(/^\/+/, "") : ""
  if (!validFilePath(p)) return "bad path (letters, digits, . _ - /; no . or .. segments)"
  if (typeof f.data !== "string") return "data must be a string"
  const chunk = Buffer.from(f.data, f.encoding === "base64" ? "base64" : "utf8")
  const prev = files.get(p)
  const buf = f.append && prev ? Buffer.concat([prev.buf, chunk]) : chunk
  const next = fileBytes - (prev?.buf.length || 0) + buf.length
  if (next > LIMITS.fileBytes) return "over the " + (LIMITS.fileBytes >> 20) + " MiB total for files"
  if (!prev && files.size >= LIMITS.files) return "too many files"
  const type = typeof f.content_type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(f.content_type)
    ? f.content_type : (prev && f.append ? prev.type : typeOf(p))
  files.set(p, { buf, type })
  fileBytes = next
  return { path: p, bytes: buf.length }
}
async function serveFile(route) {
  let p = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, "")
  if (p === "" || p.endsWith("/")) p += "index.html"
  const f = files.get(p)
  if (!f) return route.fulfill({ status: 404, contentType: "text/plain", body: "not uploaded: " + p })
  return route.fulfill({ status: 200, contentType: f.type, body: f.buf, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } })
}

// ── Chromium and pages ───────────────────────────────────────────────
let browser = null
let keeper = null
let gpuInfo = null
let proxyPort = 0
let launchOpts = {}
let stopping = false
const pages = new Map() // id -> { ctx, page, logs, blocked, last }

async function launch() {
  const b = await chromium.launch({
    // channel "chromium": the full Chromium in new headless mode, which uses
    // the GPU (the default headless shell renders in software).
    channel: launchOpts.executablePath ? undefined : "chromium",
    executablePath: launchOpts.executablePath,
    headless: true,
    // Playwright turns the sandbox off unless asked; it stays on except in a
    // development run that explicitly says otherwise (root, CI containers).
    chromiumSandbox: launchOpts.sandbox,
    // Playwright's own handlers exit the process before stop() can end the link.
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    // Playwright adds <-loopback> to the bypass list, so loopback goes
    // through the proxy too (and is refused there), and answers the 407.
    proxy: { server: "http://127.0.0.1:" + proxyPort, username: PROXY_USER, password: PROXY_PASS },
    args: [
      ...(launchOpts.args || []),
      // Nothing resolves outside the proxy; no QUIC or WebRTC UDP around it.
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  })
  // Without a display session (this account never logs in), Chromium on
  // macOS crashes when its last window closes; one page stays open for good,
  // and the GPU probe runs in a second page of its context.
  try {
    const keeperCtx = await b.newContext()
    await keeperCtx.newPage()
    keeper = keeperCtx
  } catch (e) { await b.close().catch(() => {}); throw e }
  browser = b
  b.on("disconnected", () => {
    pages.clear()
    browser = null
    keeper = null
    if (stopping) return
    log("browser exited, relaunching (open pages are gone)")
    relaunch(1)
  })
}
// Relaunches back off (1, 2, 4, 8, 16 s). If Chromium still won't start,
// the session ends rather than answer "unavailable" until someone notices.
let onBrowserGone = () => process.exit(1)
function relaunch(n) {
  setTimeout(() => launch().catch((e) => {
    log("relaunch failed: " + String(e.message).split("\n")[0])
    if (stopping) return
    if (n < 5) relaunch(n + 1)
    else { log("Chromium doesn't start any more; ending the session"); onBrowserGone() }
  }), 1000 * 2 ** (n - 1))
}
async function ready() {
  for (let i = 0; !browser && i < 50; i++) await sleep(100)
  if (!browser) throw fail("unavailable", "the browser is restarting; retry in a few seconds")
  return browser
}
// A browser that has just exited still looks open until its `disconnected`
// event; one retry lands on the relaunched one.
async function newContext(opts) {
  try { return await (await ready()).newContext(opts) } catch (e) {
    if (!/has been closed/.test(e.message)) throw e
    log("the browser closed under a new page; retrying on the relaunched one")
    await sleep(1500)
    return (await ready()).newContext(opts)
  }
}

// Console output and blocked hosts since the last call, for one page.
function report(p) {
  const r = {}
  if (p?.logs.length) r.console = p.logs.splice(0)
  if (p?.blocked.size) {
    r.blocked = [...p.blocked].map(([host, reason]) => ({ host, reason }))
    r.hint = "Blocked hosts: upload what you need with POST /files (served at " + UPLOAD_ORIGIN + "/), or ask for the host with POST /request."
    p.blocked.clear()
  }
  return r
}
function pageOf(id) {
  const p = pages.get(id)
  if (!p) throw fail("no_page", "no page " + JSON.stringify(id) + " (open pages: " + ([...pages.keys()].join(", ") || "none") + ")")
  p.last = Date.now()
  return p
}
// Pages being opened count against the limit from the first moment: calls
// run concurrently, and each awaits Chromium before its page is in `pages`.
let opening = 0
async function openPage(a) {
  if (pages.size + opening >= LIMITS.pages) throw fail("too_many_pages", "at most " + LIMITS.pages + " pages; close some with POST /close")
  opening++
  try { return await openPageNow(a) } finally { opening-- }
}
async function openPageNow(a) {
  const target = new URL(typeof a.url === "string" && a.url ? a.url : "index.html", UPLOAD_ORIGIN + "/")
  if (!/^https?:$/.test(target.protocol)) throw fail("bad_url", "only http(s) URLs")
  if (target.origin !== UPLOAD_ORIGIN && !hostAllowed(allowed, target.hostname)) {
    throw fail("host_not_allowed", target.hostname + " is not allowed yet: upload the page with POST /files and open it by path, or POST /request for the host")
  }
  const w = Math.min(Math.max(a.width | 0 || 1280, 16), 4096)
  const h = Math.min(Math.max(a.height | 0 || 720, 16), 4096)
  const scale = Math.min(Math.max(Number(a.scale) || 1, 0.25), 3)
  const ctx = await newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, serviceWorkers: "block", acceptDownloads: false })
  await ctx.route(UPLOAD_ORIGIN + "/**", serveFile)
  const page = await ctx.newPage()
  const id = crypto.randomBytes(3).toString("hex")
  const rec = { ctx, page, logs: [], blocked: new Map(), last: Date.now() }
  const push = (s) => { if (rec.logs.length < LIMITS.logLines) rec.logs.push(s.slice(0, 500)) }
  const block = (url) => {
    let host = ""
    try { host = new URL(url).hostname.replace(/^\[|\]$/g, "") } catch {}
    rec.blocked.set(host, refused.get(host) || "blocked")
  }
  // window.open() would make pages outside the page limit; they are closed.
  ctx.on("page", (p) => { if (p !== page) { push("popup closed: " + p.url().slice(0, 200)); p.close().catch(() => {}) } })
  page.on("console", (m) => push(m.type() + ": " + m.text()))
  page.on("pageerror", (e) => push("pageerror: " + (e.stack || e.message)))
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText || ""
    if (/TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED/.test(why)) block(r.url())
    else push("requestfailed: " + r.url().slice(0, 200) + " " + why)
  })
  page.on("response", (r) => { if (r.status() === 403 && r.headers()["x-agent-socket-blocked"]) block(r.url()) })
  pages.set(id, rec)
  const wait = ["load", "domcontentloaded", "networkidle", "commit"].includes(a.wait) ? a.wait : "load"
  const resp = await page.goto(target.href, { waitUntil: wait, timeout: LIMITS.opMs - 2000 })
    .catch((e) => { push("goto: " + e.message.split("\n")[0]); return null })
  return { page: id, url: target.href, http_status: resp?.status() ?? null, viewport: { width: w, height: h, scale } }
}
async function closePage(id) {
  const p = pages.get(id)
  if (!p) return false
  pages.delete(id)
  await p.ctx.close().catch(() => {})
  return true
}

function serialize(v) {
  const s = JSON.stringify(v === undefined ? null : v)
  return s.length > LIMITS.resultChars ? { result_truncated: s.slice(0, LIMITS.resultChars) } : { result: JSON.parse(s) }
}
async function evalIn(p, js, arg) {
  if (typeof js !== "string" || !js.trim()) throw fail("bad_js", "js must be the body of an async function; return a JSON value")
  // A string expression runs through CDP, so the page's own CSP can't block it.
  return withTimeout(p.page.evaluate("(async (arg) => {\n" + js + "\n})(" + JSON.stringify(arg ?? null) + ")"), LIMITS.opMs - 2000, "js")
}

// Screenshots too big for one reply are kept here and fetched in parts.
const images = new Map() // id -> { buf, type, parts, expires }
let imageBytes = 0
function dropImage(id) {
  const im = images.get(id)
  if (!im) return
  images.delete(id)
  imageBytes -= im.buf.length
}
function sweepImages() { for (const [id, im] of images) if (im.expires < Date.now()) dropImage(id) }
function imagePart(im, id, part) {
  const data = im.buf.subarray(part * LIMITS.partBytes, (part + 1) * LIMITS.partBytes).toString("base64")
  return { image: id, type: im.type, bytes: im.buf.length, parts: im.parts, part, data }
}
async function shoot(p, a = {}) {
  const frames = Math.min(Math.max(a.frames ?? 2, 0), 120)
  if (frames) {
    await withTimeout(p.page.evaluate((n) => new Promise((r) => {
      const f = () => (--n <= 0 ? r() : requestAnimationFrame(f))
      requestAnimationFrame(f)
    }), frames), 10_000, "frames").catch(() => {})
  }
  const type = a.type === "jpeg" ? "jpeg" : "png"
  const opts = { type, fullPage: !!a.full_page, omitBackground: !!a.omit_background && type === "png", timeout: LIMITS.opMs - 5000 }
  if (type === "jpeg") opts.quality = Math.min(Math.max(a.quality | 0 || 85, 1), 100)
  if (a.clip && typeof a.clip === "object") opts.clip = { x: +a.clip.x || 0, y: +a.clip.y || 0, width: +a.clip.width || 1, height: +a.clip.height || 1 }
  const buf = typeof a.selector === "string" ? await p.page.locator(a.selector).first().screenshot(opts) : await p.page.screenshot(opts)
  if (buf.length <= LIMITS.partBytes) return { type, bytes: buf.length, parts: 1, data: buf.toString("base64") }
  sweepImages()
  if (buf.length > LIMITS.imageBytes) throw fail("image_too_large", "image is " + buf.length + " bytes, over " + LIMITS.imageBytes + ": use jpeg, a clip or a smaller viewport/scale")
  while (imageBytes + buf.length > LIMITS.imageBytes && images.size) dropImage(images.keys().next().value)
  const id = crypto.randomBytes(4).toString("hex")
  const im = { buf, type, parts: Math.ceil(buf.length / LIMITS.partBytes), expires: Date.now() + LIMITS.imageMs }
  images.set(id, im)
  imageBytes += buf.length
  return imagePart(im, id, 0)
}
// Concurrent calls share one probe (each would open a page of its own).
let gpuProbe = null
function gpu() {
  if (gpuInfo) return Promise.resolve(gpuInfo)
  gpuProbe ??= probeGpu().finally(() => { gpuProbe = null })
  return gpuProbe
}
async function probeGpu() {
  await ready()
  if (!keeper) throw fail("unavailable", "the browser is restarting; retry in a few seconds")
  const page = await keeper.newPage()
  try {
    gpuInfo = await withTimeout(page.evaluate(async () => {
      const c = document.createElement("canvas")
      const gl = c.getContext("webgl2") || c.getContext("webgl")
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info")
      let webgpu = null
      try {
        const ad = navigator.gpu && await navigator.gpu.requestAdapter()
        webgpu = ad ? (ad.info ? { vendor: ad.info.vendor, architecture: ad.info.architecture } : true) : false
      } catch { webgpu = false }
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : null)
      return { webgl: gl ? (gl instanceof WebGL2RenderingContext ? 2 : 1) : 0, renderer, webgpu }
    }), 10_000, "gpu probe")
    gpuInfo.software = /swiftshader|llvmpipe|software/i.test(gpuInfo.renderer || "")
  } finally { await page.close().catch(() => {}) }
  return gpuInfo
}

// ── approvals: `ask` event out, `answer` line in ─────────────────────
const asks = new Map() // id -> { kind, hosts, taskId, timer }
let session = null
function ask(kind, text, extra) {
  const id = crypto.randomBytes(3).toString("hex")
  const a = { kind, ...extra }
  a.timer = setTimeout(() => answer(id, "timeout"), LIMITS.askMs)
  asks.set(id, a)
  event("ask " + id + " " + kind + " " + b64(text) + (a.hosts ? " " + a.hosts.join(" ") : ""))
  return id
}
// completeTask throws while the link to the relay is down; such answers are
// kept and sent once the SDK has resumed the session (the task survives a
// resume), so the agent's poll still gets them.
// completeTask is also fire-and-forget: a frame sent just as the link drops
// is lost without an error. So answers are kept and sent again after every
// reconnect (completing a task twice stores the same reply), as many as the
// relay keeps tasks for one session.
const answered = []
function complete(taskId, reply) {
  answered.push([taskId, reply])
  if (answered.length > 100) answered.shift()
  try { session?.completeTask(taskId, reply) }
  catch { log("the relay link is down; the answer goes to the agent when it's back") }
}
function resendAnswers() {
  for (const [taskId, reply] of answered) {
    try { session.completeTask(taskId, reply) } catch { return }
  }
}
function answer(id, choice) {
  const a = asks.get(id)
  if (!a) return log("no pending request " + id)
  asks.delete(id)
  clearTimeout(a.timer)
  event("done " + id)
  const yes = choice === "allow" || choice === "always"
  if (a.kind === "hosts") {
    if (yes) for (const h of a.hosts) allowed.add(h)
    if (choice === "always") event("persist-hosts " + a.hosts.join(" "))
    log((yes ? "allowed " : "refused ") + a.hosts.join(", ") + (choice === "always" ? " (always)" : yes ? " (this session)" : choice === "timeout" ? " (no answer)" : ""))
    // Throws while the link is down; the agent's poll then never completes.
    complete(a.taskId, { body: { approved: yes, answer: choice, hosts: a.hosts, allowed_hosts: [...allowed].slice(0, 100) } })
  }
}

// ── agent-defined tools: they run in pages, so defining needs no approval;
// they last for this session only (a later agent would see another agent's
// code under a trusted-looking name) ──
const defined = new Map() // path -> definition
const pick = (d) => ({ path: d.path, description: d.description, js: d.js, input_schema: d.input_schema, url: d.url, width: d.width, height: d.height, scale: d.scale, wait: d.wait, screenshot: d.screenshot })
function toolProblem(d) {
  if (!d || typeof d !== "object") return "body must be an object"
  if (!validToolPath(d.path)) return "path must look like /orbit_shots (a-z 0-9 _ -, one segment)"
  if (builtins.some((t) => t.path === d.path || t.path.startsWith(d.path + "/"))) return d.path + " is a built-in"
  if (typeof d.description !== "string" || !d.description.trim() || d.description.length > 4000) return "description: 1-4000 characters"
  if (typeof d.js !== "string" || !d.js.trim() || d.js.length > 32_000) return "js: the body of an async function, at most 32000 characters"
  if (d.input_schema !== undefined && (typeof d.input_schema !== "object" || JSON.stringify(d.input_schema).length > 16_000)) return "input_schema: a JSON Schema object"
  if (d.url !== undefined && typeof d.url !== "string") return "url must be a string"
  if (!defined.has(d.path) && defined.size >= LIMITS.tools) return "at most " + LIMITS.tools + " defined tools"
  return null
}
function definedTool(d) {
  return {
    path: d.path,
    description: d.description + "\n\n(Agent-defined. Body: your arguments as JSON, passed to the tool's js as `arg`; add \"page\": \"<id>\" to run in an open page instead of a fresh one.)",
    input_schema: d.input_schema || { type: "object" },
    handler: guard(d.path, async (a) => {
      let id = typeof a.page === "string" ? a.page : null
      let opened = false
      if (id) pageOf(id)
      else { id = (await openPage({ url: d.url, width: d.width, height: d.height, scale: d.scale, wait: d.wait })).page; opened = true }
      try {
        const p = pageOf(id)
        const r = serialize(await evalIn(p, d.js, a))
        if (d.screenshot) r.image = await shoot(p, typeof d.screenshot === "object" ? d.screenshot : {})
        return { ...r, ...(opened ? {} : { page: id }), ...report(p) }
      } finally { if (opened) await closePage(id) }
    }),
  }
}
function define(d) {
  const why = toolProblem(d)
  if (!why) defined.set(d.path, pick(d))
  return why
}
const toolList = () => [...builtins, ...[...defined.values()].map(definedTool)]
let syncing = Promise.resolve()
const syncTools = () => (syncing = syncing.then(() => session?.updateTools(toolList(), agentsMd())).catch((e) => log("tool update failed: " + e.message)))

// Every handler: parse, log one line, map errors to HTTP answers, and never
// send a reply over the relay's frame budget (that would end the session).
function guard(name, fn) {
  return async ({ body }) => {
    let a = {}
    if (body) {
      try { a = JSON.parse(body) } catch { a = null }
      if (!a || typeof a !== "object" || Array.isArray(a)) return err(400, "bad_json", "the body must be a JSON object")
    }
    const t = Date.now()
    try {
      const r = await fn(a)
      if (JSON.stringify(r).length > LIMITS.replyChars) {
        log(name + " reply too large")
        return err(413, "reply_too_large", "the reply would be over " + LIMITS.replyChars + " characters; return less (a smaller result, jpeg, a clip)")
      }
      log(name + " (" + (Date.now() - t) + " ms)")
      return r
    } catch (e) {
      const msg = String(e.message || e).split("\n").slice(0, 3).join(" ")
      log(name + " failed: " + msg)
      const status = { no_page: 404, too_many_pages: 429, too_many_requests: 429, host_not_allowed: 403, image_too_large: 413, no_image: 404, timeout: 504, unavailable: 503 }[e.code] || 400
      return err(status, e.code || "failed", msg)
    }
  }
}

let endsAt = null
let pwVersion = null
const builtins = [
  { method: "GET", path: "/info", description: "GPU (WebGL renderer, WebGPU), Chromium and Playwright versions, allowed hosts, open pages, uploaded files, when the session ends, limits and agent-defined tools.",
    handler: guard("info", async () => ({
      gpu: await gpu(), chromium: (await ready()).version(), playwright: pwVersion, upload_origin: UPLOAD_ORIGIN,
      allowed_hosts: [...allowed], pages: [...pages.keys()], files: { count: files.size, bytes: fileBytes },
      session_ends_at: endsAt ? new Date(endsAt).toISOString() : null, tools: [...defined.keys()], limits: LIMITS,
      isolation: { account: os.userInfo().username, installed: INSTALLED, chromium_sandbox: launchOpts.sandbox },
    })) },
  { path: "/files", description: "Upload files, served at " + UPLOAD_ORIGIN + "/<path> to pages opened here. Body: {\"files\": [{\"path\": \"index.html\", \"data\": \"...\", \"encoding\": \"utf8\" | \"base64\", \"append\": false, \"content_type\": optional}]}. A request body is at most 1 MiB, so send big files in base64 pieces with append: true. The content type comes from the extension.",
    input_schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "object", required: ["path", "data"], properties: {
      path: { type: "string" }, data: { type: "string" }, encoding: { enum: ["utf8", "base64"] }, append: { type: "boolean" }, content_type: { type: "string" } } } } } },
    handler: guard("files", async (a) => {
      if (!Array.isArray(a.files) || !a.files.length) throw fail("bad_files", "files: a non-empty array")
      const stored = []
      const errors = []
      for (const f of a.files) {
        const r = putFile(f)
        if (typeof r === "string") errors.push({ path: f?.path, error: r })
        else stored.push(r)
      }
      return { stored, errors, total: { count: files.size, bytes: fileBytes } }
    }) },
  { method: "GET", path: "/files", description: "List uploaded files with sizes.",
    handler: guard("files list", async () => ({ files: [...files].map(([p, f]) => ({ path: p, bytes: f.buf.length, type: f.type })), bytes: fileBytes })) },
  { path: "/files/delete", description: "Delete uploaded files. Body: {\"paths\": [...]} or {\"all\": true}.",
    handler: guard("files delete", async (a) => {
      const ps = a.all ? [...files.keys()] : Array.isArray(a.paths) ? a.paths : []
      for (const p of ps) {
        const f = files.get(p)
        if (f) { fileBytes -= f.buf.length; files.delete(p) }
      }
      return { deleted: ps.length, total: { count: files.size, bytes: fileBytes } }
    }) },
  { path: "/page", description: "Open a page in a fresh, isolated context. Body: {\"url\": \"index.html\" (a path under " + UPLOAD_ORIGIN + "/, or an https URL on an allowed host), \"width\": 1280, \"height\": 720, \"scale\": 1, \"wait\": \"load\" | \"domcontentloaded\" | \"networkidle\"}. Returns the page id, plus console output and blocked hosts so far.",
    input_schema: { type: "object", properties: { url: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, scale: { type: "number" }, wait: { type: "string" } } },
    handler: guard("page", async (a) => {
      const r = await openPage(a)
      return { ...r, ...report(pages.get(r.page)) }
    }) },
  { path: "/eval", description: "Run JavaScript in a page. Body: {\"page\": \"<id>\", \"js\": \"<body of an async function>\", \"arg\": <any JSON>}. Use `return` to send back a JSON value (truncated past 256k characters). Also returns console output since the last call.",
    input_schema: { type: "object", required: ["page", "js"], properties: { page: { type: "string" }, js: { type: "string" }, arg: {} } },
    handler: guard("eval", async (a) => {
      const p = pageOf(a.page)
      return { ...serialize(await evalIn(p, a.js, a.arg)), ...report(p) }
    }) },
  { path: "/screenshot", description: "Screenshot a page after `frames` animation frames (default 2). Body: {\"page\": \"<id>\", \"type\": \"png\" | \"jpeg\", \"quality\": 85, \"full_page\": false, \"selector\": optional, \"clip\": {x,y,width,height} optional, \"omit_background\": false, \"frames\": 2}. Returns {type, bytes, parts, data} with data in base64 (e.g. `jq -r .data | base64 -d > shot.png`). When parts > 1 the reply also has an `image` id and holds part 0: fetch parts 1..parts-1 with POST /image and concatenate the decoded bytes in order.",
    input_schema: { type: "object", required: ["page"], properties: { page: { type: "string" }, type: { enum: ["png", "jpeg"] }, quality: { type: "integer" }, full_page: { type: "boolean" }, selector: { type: "string" }, clip: { type: "object" }, omit_background: { type: "boolean" }, frames: { type: "integer" } } },
    handler: guard("screenshot", async (a) => {
      const p = pageOf(a.page)
      return { ...(await shoot(p, a)), ...report(p) }
    }) },
  { path: "/image", description: "One part of a large screenshot. Body: {\"image\": \"<id from /screenshot>\", \"part\": 1}. Parts are kept 10 minutes; the image is dropped once its last part is fetched.",
    input_schema: { type: "object", required: ["image", "part"], properties: { image: { type: "string" }, part: { type: "integer" } } },
    handler: guard("image", async (a) => {
      sweepImages()
      const im = images.get(a.image)
      if (!im) throw fail("no_image", "no image " + JSON.stringify(a.image) + " (expired, fully fetched, or never made)")
      const part = a.part | 0
      if (part < 0 || part >= im.parts) throw fail("bad_part", "part must be 0.." + (im.parts - 1))
      const r = imagePart(im, a.image, part)
      if (part === im.parts - 1) dropImage(a.image)
      return r
    }) },
  { path: "/close", description: "Close a page. Body: {\"page\": \"<id>\"} or {\"all\": true}. Idle pages close after 15 minutes anyway.",
    handler: guard("close", async (a) => {
      const ids = a.all ? [...pages.keys()] : [a.page]
      let n = 0
      for (const id of ids) if (await closePage(id)) n++
      return { closed: n, pages: [...pages.keys()] }
    }) },
  { path: "/request", description: "Ask the owner to let pages reach more hosts (a CDN, an API). Body: {\"hosts\": [\"cdn.jsdelivr.net\", \"*.example.com\"], \"reason\": \"one line the owner will see\"}. The owner is asked on their machine; this returns 202 with a taskId: poll <link base>/_as_tasks/<taskId> every few seconds until it answers {approved, allowed_hosts}. At most 10 requests wait at a time (429 beyond that). Uploading what you need with /files needs no approval.",
    input_schema: { type: "object", required: ["hosts", "reason"], properties: { hosts: { type: "array", items: { type: "string" } }, reason: { type: "string" } } },
    handler: guard("request", async (a) => {
      const hosts = Array.isArray(a.hosts) ? [...new Set(a.hosts.map((h) => String(h).toLowerCase()))] : []
      const bad = hosts.filter((h) => !validHost(h))
      if (!hosts.length || hosts.length > LIMITS.hostsPerAsk || bad.length) {
        throw fail("bad_hosts", "hosts: 1-" + LIMITS.hostsPerAsk + " hostnames like cdn.jsdelivr.net or *.example.com" + (bad.length ? " (bad: " + clean(bad.join(", ")).slice(0, 200) + ")" : ""))
      }
      // A plain host a wildcard already covers isn't missing; a wildcard is
      // missing unless that exact wildcard was granted.
      const missing = hosts.filter((h) => !allowed.has(h) && (h.startsWith("*.") || !hostAllowed(allowed, h)))
      if (!missing.length) return { approved: true, answer: "already", allowed_hosts: [...allowed] }
      // Checked before the owner is prompted, so requests can't flood them.
      if (asks.size >= LIMITS.asks) throw fail("too_many_requests", LIMITS.asks + " requests are already waiting for the owner; poll those first")
      const reason = clean(String(a.reason || "").replace(/\s+/g, " ").trim()).slice(0, 300) || "(no reason given)"
      const taskId = crypto.randomUUID()
      const id = ask("hosts", "An agent asks to let the GPU browser reach:\n\n  " + missing.join("\n  ") + "\n\nIts reason: " + reason, { hosts: missing, taskId })
      log("request " + id + ": " + missing.join(", ") + " - " + reason)
      return { status: 202, taskId }
    }) },
  { path: "/define", description: "Add your own tool to this link, live: it opens a fresh page at `url` (default index.html), runs `js` with your call's body as `arg`, optionally screenshots, and closes the page; it lasts for this session. Body: {\"path\": \"/orbit_shots\", \"description\": \"...\", \"js\": \"<body of an async function>\", \"input_schema\": optional, \"url\": optional, \"width\"/\"height\"/\"scale\"/\"wait\": optional, \"screenshot\": false | true | {screenshot options}}. Re-fetch the tool list afterwards. Needs no approval. Redefining a path replaces it.",
    input_schema: { type: "object", required: ["path", "description", "js"], properties: { path: { type: "string" }, description: { type: "string" }, js: { type: "string" }, input_schema: { type: "object" }, url: { type: "string" }, screenshot: {} } },
    handler: guard("define", async (a) => {
      const why = define(a)
      if (why) throw fail("bad_tool", why)
      log("tool " + a.path + " defined")
      await syncTools()
      return { defined: a.path, tools: [...defined.keys()] }
    }) },
  { path: "/undefine", description: "Remove an agent-defined tool for this session. Body: {\"path\": \"/orbit_shots\"}.",
    handler: guard("undefine", async (a) => {
      const had = defined.delete(a.path)
      if (had) await syncTools()
      return { removed: had, tools: [...defined.keys()] }
    }) },
]

function agentsMd() {
  return `# GPU browser (agent-socket)

A real Chromium on its owner's machine, with that machine's GPU, shared with you through this link. Use it to render WebGL/WebGPU (three.js and the like) and get screenshots back. It runs under a separate, locked-down account: it can't see the owner's files or local network.

Typical flow:
1. \`GET /info\` - GPU, versions, what is allowed, when the session ends.
2. \`POST /files\` - upload your page and assets; they are served at ${UPLOAD_ORIGIN}/<path>. Bundle or inline your libraries: pages can reach no other host unless the owner allows it.
3. \`POST /page\` with {"url": "index.html"} - opens it, returns a page id.
4. \`POST /eval\` to drive the scene, \`POST /screenshot\` to get an image (base64 in \`data\`; large images come in parts, fetched with \`POST /image\`).
5. \`POST /close\` when done.

Network: pages reach only ${UPLOAD_ORIGIN}/ (your uploads) and hosts the owner allowed${allowed.size ? " (now: " + [...allowed].join(", ") + ")" : " (none yet)"}. Private and local network addresses are never reachable. Blocked requests are listed under \`blocked\` in the next reply for that page. To use a CDN or API, \`POST /request\` with the hosts and a one-line reason, then poll the returned task until the owner answers.

Your own tools: \`POST /define\` turns a page script into a tool on this same link for this session (no approval needed); re-fetch the tool list after.
${defined.size ? "\nAgent-defined tools now: " + [...defined.keys()].join(", ") + "\n" : ""}
Limits: request bodies 1 MiB (upload big files in base64 pieces with append), ${LIMITS.pages} open pages, calls time out after about ${Math.round(LIMITS.opMs / 1000)} s, idle pages close after 15 minutes.${endsAt ? " This session ends at " + new Date(endsAt).toISOString() + "." : ""} The link stops working when the owner stops sharing.
`
}

// ── self-test (installer) ────────────────────────────────────────────
async function selfTest() {
  launchOpts = { args: ["--enable-logging=stderr", "--v=0"], sandbox: true }
  proxyPort = (await startProxy()).address().port
  try {
    await launch()
    const g = await gpu()
    // What every run does next: open a context and close it again. The
    // browser must still be there afterwards (on macOS a crash here would
    // only show up later, as "browser has been closed").
    await (await (await browser.newContext()).newPage()).context().close()
    await sleep(1500)
    if (!browser?.isConnected()) throw new Error("Chromium exited after a context closed")
    await (await browser.newContext()).close()
    stopping = true
    await browser?.close()
    out(JSON.stringify({ ok: true, chromium: "launched", ...g }))
    process.exit(0)
  } catch (e) {
    out(JSON.stringify({ ok: false, error: String(e.message || e).split("\n")[0], chromium_log: chromiumLog }))
    process.exit(1)
  }
}

// ── start ────────────────────────────────────────────────────────────
async function main() {
  const lines = readline.createInterface({ input: process.stdin })
  // One listener from the start: later lines and the close can arrive in the
  // same chunk as the config, before the control handlers below exist.
  const early = []
  let onLine = null, onClose = null, closed = false
  lines.on("line", (l) => (onLine ? onLine(l) : early.push(l)))
  lines.on("close", () => { closed = true; onClose?.() })
  const first = await new Promise((resolve) => {
    onLine = (l) => { onLine = null; resolve(l) }
    onClose = () => resolve(null)
  })
  let cfg
  try { cfg = JSON.parse(first) } catch { cfg = null }
  if (!cfg || typeof cfg.key !== "string" || !/^[0-9a-f]{16,64}$/.test(cfg.key) || typeof cfg.relay !== "string") {
    log("expected a config line on stdin (this server is started by: npx @agent-socket/gpu-browser)")
    process.exit(2)
  }
  KEY = cfg.key
  for (const h of cfg.allow || []) if (validHost(h)) allowed.add(h)
  const flags = gpuFlags(cfg.chromium?.args)
  if (flags.dropped.length) log("ignoring Chromium flags that aren't GPU settings: " + flags.dropped.join(" "))
  // A custom Chromium binary and turning the sandbox off are for development
  // runs only (the harness, a checkout); an install always uses its own
  // Chromium, sandboxed.
  launchOpts = {
    args: flags.args,
    executablePath: !INSTALLED && cfg.chromium?.executablePath ? String(cfg.chromium.executablePath) : undefined,
    sandbox: INSTALLED || cfg.chromium?.sandbox !== false,
  }
  pwVersion = cfg.playwrightVersion || null
  // The link's lifetime is a safety limit: a value that isn't a number of
  // minutes (0 = until stopped) refuses to start rather than meaning "forever".
  const minutes = cfg.minutes ?? 0
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    log("minutes must be a number of minutes, 0 for no limit (got " + JSON.stringify(cfg.minutes) + ")")
    process.exit(2)
  }
  if (minutes > 0) endsAt = Date.now() + minutes * 60_000
  // Proves the CLI's stdin reaches us (it passes through sudo).
  event("ready")

  // Ending: the owner's `stop`, Ctrl-C (the CLI forwards it, and sudo may
  // too), the CLI dying (stdin closes), or the timer.
  const { connect, endSession } = await import("./lib/sdk/index.js")
  const stop = async (why) => {
    if (stopping) return
    stopping = true
    event("ended " + why)
    if (session) {
      const held = { baseUrl: cfg.relay, sessionId: session.sessionId, secret: session.resumeSecret }
      session.close()
      // close() only starts the socket's close; exiting right after can drop
      // the frame and leave the link held. endSession confirms.
      if (held.secret) await withTimeout(endSession(held), 3000, "end").catch(() => {})
    }
    await withTimeout(browser?.close() ?? Promise.resolve(), 3000, "browser close").catch(() => {})
    process.exit(0)
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => stop("signal"))
  onLine = (line) => {
    try {
      const [cmd, x, y] = line.trim().split(/\s+/)
      if (cmd === "stop") stop("stopped")
      else if (cmd === "answer" && x) answer(x, ["allow", "always", "deny"].includes(y) ? y : "deny")
    } catch (e) { log("control line failed: " + e.message) }
  }
  for (const l of early.splice(0)) onLine(l)
  onClose = () => stop("owner gone")
  if (closed) onClose()
  onBrowserGone = () => stop("browser failed")
  // A timer holds at most 2^31-1 ms (~24.8 days); longer sessions re-arm.
  const arm = () => {
    const left = endsAt - Date.now()
    if (left <= 0) stop("timer")
    else setTimeout(arm, Math.min(left, 2 ** 31 - 1)).unref()
  }
  if (endsAt) arm()
  setInterval(() => { for (const [id, p] of pages) if (Date.now() - p.last > LIMITS.idleMs) closePage(id) }, 60_000).unref()

  proxyPort = (await startProxy()).address().port
  log("proxy on 127.0.0.1:" + proxyPort + " (password-protected)")
  await launch()
  session = await connect({
    baseUrl: cfg.relay, appId: "agent-socket-gpu-browser", appDescription: "Chromium with its owner's GPU, for WebGL/WebGPU renders",
    agentsMd: agentsMd(), tools: toolList(),
    onSessionChanged: ({ tokensRemapped }) => { for (const url of tokensRemapped?.values() ?? []) event("link " + url) }, // a Map: old URL -> new
    onReconnect: () => resendAnswers(),
  })
  const link = await session.mintAgentToken({ label: "gpu-browser" })
  event("link " + link.url)
}

if (SELF_TEST) await selfTest()
else await main().catch((e) => { log("could not start: " + (e.message || e)); process.exit(1) })
