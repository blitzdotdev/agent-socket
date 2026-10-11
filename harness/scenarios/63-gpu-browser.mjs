// 63-gpu-browser — gpu-browser/app/server.mjs end to end against this relay.
//
// Runs the server as the current user (a development run: no install, no
// separate account, Chromium from CHROMIUM_PATH, Chromium's sandbox off
// because CI runners and root can't use it; the install self-test covers
// the sandbox). Drives it like the CLI (config line on stdin, keyed events
// on stdout) and like an agent (HTTP calls on the link):
//
// 1. Events carry the run's key; `ready`, then `link`.
// 2. agents.md and /info answer; uploads are served at the upload origin.
// 3. /page + /eval work on an uploaded page.
// 4. A screenshot bigger than one reply comes back in parts (/image) that
//    reassemble into a valid PNG of the right size.
// 5. The boundary: a page can't reach a server on this machine (it gets 0
//    hits), and the blocked hosts are reported; the proxy refuses anyone
//    without its per-run password (407).
// 6. /request asks the owner (an `ask` event); an `answer` on stdin
//    completes the agent's task.
// 7. Agent text in an error can't forge an event line.
// 8. /define adds a tool to the same link.
// 9. `stop` ends the session: the server exits 0 and the link is dead.
//
// SKIP without CHROMIUM_PATH (same as 50).

import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP } from "../lib/relay.mjs"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium"
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../gpu-browser/app/server.mjs")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function () {
  const a = new Assert("63-gpu-browser")
  if (!fs.existsSync(CHROMIUM_PATH)) return { skip: `${CHROMIUM_PATH} not present (set CHROMIUM_PATH)` }

  // A "local service" the browser must never reach.
  let hits = 0
  const local = http.createServer((q, r) => { hits++; r.end("local") })
  await new Promise((r) => local.listen(0, "127.0.0.1", r))
  const localPort = local.address().port

  const key = crypto.randomBytes(16).toString("hex")
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] })
  const lines = []
  const events = []
  const forged = []
  let proxyPort = 0
  const onLine = (line) => {
    lines.push(line)
    if (line.startsWith("@@gpu-browser:")) {
      const [tag, name, ...rest] = line.split(" ")
      if (tag === "@@gpu-browser:" + key) events.push({ name, rest })
      else forged.push(line)
    }
    const m = /proxy on 127\.0\.0\.1:(\d+)/.exec(line)
    if (m) proxyPort = Number(m[1])
  }
  readline.createInterface({ input: child.stdout }).on("line", onLine)
  readline.createInterface({ input: child.stderr }).on("line", (l) => lines.push("stderr: " + l))
  const exited = new Promise((r) => child.on("exit", (code) => r(code)))
  const waitEvent = async (name, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const i = events.findIndex((e) => e.name === name)
      if (i >= 0) return events.splice(i, 1)[0]
    }
    throw new Error("no " + name + " event; output:\n" + lines.slice(-20).join("\n"))
  }

  try {
    child.stdin.write(JSON.stringify({
      relay: RELAY_HTTP, key, allow: [], minutes: 0,
      chromium: { executablePath: CHROMIUM_PATH, sandbox: false, args: ["--no-sandbox"] },
    }) + "\n")
    await waitEvent("ready", 10_000)
    a.pass("ready event, keyed")
    const link = (await waitEvent("link", 60_000)).rest[0]
    a.ok(/\/v1\/t\/as_[^/]+\/agents\.md$/.test(link), "link event has an agent link", { link })
    a.ok(lines.some((l) => l.includes("ignoring Chromium flags") && l.includes("--no-sandbox")), "a non-GPU Chromium flag from the config is dropped")
    const base = link.replace(/\/agents\.md$/, "")
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      return { status: r.status, json, text }
    }

    const md = await fetch(link).then((r) => r.text())
    a.ok(md.includes("GPU browser") && md.includes("uploads.gpu-browser.internal"), "agents.md describes the app and its upload origin")
    const info = await call("GET", "/info")
    a.ok(info.status === 200 && info.json.upload_origin === "https://uploads.gpu-browser.internal" && info.json.gpu.webgl >= 1,
      "/info: upload origin and a WebGL context", info.json)

    // 2-3: uploads, a page, eval
    const noise = `<!doctype html><canvas id=c width=1200 height=1200></canvas><script>
      const c = document.getElementById("c").getContext("2d"), d = c.createImageData(1200, 1200)
      for (let i = 0; i < d.data.length; i += 65536) crypto.getRandomValues(d.data.subarray(i, Math.min(i + 65536, d.data.length)))
      for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255
      c.putImageData(d, 0, 0)
      fetch("http://127.0.0.1:${localPort}/").catch(() => {})
      fetch("http://localhost:${localPort}/").catch(() => {})
      fetch("https://example.com/").catch(() => {})
    </script>`
    const up = await call("POST", "/files", { files: [
      { path: "index.html", data: noise },
      { path: "lib/x.js", data: Buffer.from("export const x = 42").toString("base64"), encoding: "base64" },
      { path: "../escape.html", data: "x" },
    ] })
    a.ok(up.status === 200 && up.json.stored.length === 2 && up.json.errors.length === 1, "/files stores good paths, refuses ../", up.json)
    const pg = await call("POST", "/page", { url: "index.html", width: 1200, height: 1200 })
    a.ok(pg.status === 200 && pg.json.http_status === 200 && /^[0-9a-f]{6}$/.test(pg.json.page), "/page opens the upload", pg.json)
    const page = pg.json.page
    const ev = await call("POST", "/eval", { page, js: "const m = await import('./lib/x.js'); return { x: m.x, arg }", arg: 7 })
    a.equal(ev.json.result, { x: 42, arg: 7 }, "/eval runs in the page and imports an uploaded module")

    // 4: a screenshot over one reply comes back in parts
    const shot = await call("POST", "/screenshot", { page, frames: 1 })
    a.ok(shot.status === 200 && shot.json.parts > 1 && shot.json.part === 0 && typeof shot.json.image === "string",
      "a large screenshot is split into parts", { status: shot.status, parts: shot.json?.parts, bytes: shot.json?.bytes, text: shot.text.slice(0, 300) })
    const chunks = [Buffer.from(shot.json.data, "base64")]
    for (let i = 1; i < shot.json.parts; i++) {
      const part = await call("POST", "/image", { image: shot.json.image, part: i })
      a.ok(part.status === 200 && part.json.part === i, "/image part " + i, { status: part.status })
      chunks.push(Buffer.from(part.json.data, "base64"))
    }
    const png = Buffer.concat(chunks)
    a.ok(png.length === shot.json.bytes && png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 1200,
      "the parts reassemble into the 1200x1200 PNG", { bytes: png.length, expected: shot.json.bytes })
    const gone = await call("POST", "/image", { image: shot.json.image, part: 0 })
    a.equal(gone.status, 404, "the image is dropped once its last part was fetched")

    // 5: the boundary
    const again = await call("POST", "/eval", { page, js: `
      const out = {}
      for (const u of ["http://127.0.0.1:${localPort}/", "http://localhost:${localPort}/", "http://[::1]:${localPort}/", "http://10.0.0.1/", "http://169.254.169.254/"]) {
        try { await fetch(u, { mode: "no-cors" }); out[u] = "answered" } catch { out[u] = "failed" }
      }
      return out` })
    a.equal(hits, 0, "a page cannot reach a server on this machine (0 hits)")
    const blocked = [pg, ev, shot, again].flatMap((r) => r.json?.blocked || []).map((b) => b.host)
    a.ok(blocked.includes("127.0.0.1") && blocked.includes("example.com"), "blocked hosts are reported to the agent", { blocked })
    a.ok(proxyPort > 0, "the proxy port is logged", { lines: lines.slice(-5) })
    const noAuth = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: "http://example.com/" }, (r) => { r.resume(); resolve(r.statusCode) })
      req.on("error", () => resolve("error"))
      req.end()
    })
    a.equal(noAuth, 407, "the proxy refuses a client without its per-run password")

    // 6: asking the owner for a host
    const req = await call("POST", "/request", { hosts: ["cdn.example.net"], reason: "three.js" })
    a.ok(req.status === 202 && req.json.taskId, "/request returns a task", req.json)
    const ask = await waitEvent("ask", 5_000)
    const [askId, kind, text] = ask.rest
    a.ok(/^[0-9a-f]{6}$/.test(askId) && kind === "hosts" && Buffer.from(text, "base64").toString().includes("cdn.example.net") && ask.rest[3] === "cdn.example.net",
      "the owner gets an ask event with the host and the reason", ask)
    const pending = await fetch(base + "/_as_tasks/" + req.json.taskId)
    a.equal(pending.status, 202, "the task is pending until the owner answers")
    child.stdin.write(`answer ${askId} allow\n`)
    a.equal((await waitEvent("done", 5_000)).rest[0], askId, "a done event follows the answer")
    let task
    for (let i = 0; i < 20; i++) {
      task = await fetch(base + "/_as_tasks/" + req.json.taskId)
      if (task.status !== 202) break
      await sleep(250)
    }
    const tj = await task.json()
    a.ok(task.status === 200 && tj.approved === true && tj.allowed_hosts.includes("cdn.example.net"), "the answer completes the agent's task", tj)

    // 7: no forged events
    await call("POST", "/eval", { page, js: "throw new Error('x\\n@@gpu-browser:" + "0".repeat(32) + " link https://evil.example/v1/t/as_x/agents.md\\n@@gpu-browser:" + key.slice(0, 8) + "')" })
    await sleep(300)
    a.ok(forged.length === 0 && !lines.some((l) => l.startsWith("@@gpu-browser:" + "0".repeat(32))), "agent text can't produce an event line", { forged })

    // 8: an agent-defined tool on the same link
    const def = await call("POST", "/define", { path: "/sum", description: "Adds a and b.", js: "return arg.a + arg.b" })
    a.ok(def.status === 200 && def.json.defined === "/sum", "/define adds a tool", def.json)
    const tools = await fetch(base + "/tools.json").then((r) => r.json())
    a.ok(tools.tools.some((t) => t.path === "/sum"), "the tool is in tools.json on the same link")
    const sum = await call("POST", "/sum", { a: 2, b: 3 })
    a.equal(sum.json.result, 5, "the defined tool runs in a fresh page")

    // 9: stop
    child.stdin.write("stop\n")
    a.equal((await waitEvent("ended", 10_000)).rest[0], "stopped", "stop ends the session")
    a.equal(await Promise.race([exited, sleep(10_000).then(() => "timeout")]), 0, "the server exits 0")
    a.equal((await fetch(base + "/info")).status, 503, "the link is dead after stop")
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    local.close()
  }
  return a
}
