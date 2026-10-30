#!/usr/bin/env node
// npx @agent-socket/shell — let an agent anywhere run shell commands on this
// machine through an agent-socket link, one at a time, each shown here first.
//
//   npx @agent-socket/shell [--for 60m|2h|none] [--relay URL]
//
// Nothing runs until you press Enter on it (or switch to auto with `a`).
// The agent's side of the contract is ../agents.md.

import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version
const AGENTS_MD = fs.readFileSync(path.join(PKG, "agents.md"), "utf8")
const SHELL = process.env.SHELL || "/bin/sh"
const START_DIR = process.cwd()
// How long /run holds the agent's call before answering 202 with a task: under
// the relay's 30 s sync limit. Tests set it lower to match their relay.
const HOLD_MS = Number(process.env.AGENT_SOCKET_SHELL_HOLD_MS) || 25_000
// The result goes back as one async task result, which the relay caps at
// 64 KiB of JSON; keep the output's head and tail inside that.
const HEAD = 24 * 1024, TAIL = 24 * 1024, MAX_JSON = 60 * 1024

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = c(2), bold = c(1), green = c(32), yellow = c(33), red = c(31), cyan = c(36)
const out = (s = "") => process.stdout.write(s + "\n")
const die = (s) => { process.stderr.write(red("✗ ") + s + "\n"); process.exit(1) }

// ── arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
  out(`agent-socket shell ${VERSION}: let an agent run commands on this machine, each one shown here first.

  npx @agent-socket/shell [--for 60m|2h|none] [--relay URL]

Prints a link to paste into the agent's chat. Each command the agent sends waits
here: Enter runs it, n refuses it (with an optional note to the agent), e edits
it, a switches to auto (commands run as they arrive), s back to step.
Ctrl-C stops a running command; Ctrl-C or q at the prompt ends the session.`)
  process.exit(0)
}
if (args.includes("-v") || args.includes("--version")) { out(VERSION); process.exit(0) }
const RELAY = (opt("--relay") || process.env.AGENT_SOCKET_URL || "https://agentsocket.dev").replace(/\/+$/, "")
const FOR = opt("--for") ?? "60m"
const forMs = (() => {
  if (FOR === "none") return null
  const m = /^(\d+)(m|h)$/.exec(FOR)
  if (!m || +m[1] === 0) die(`--for takes minutes or hours (30m, 2h) or none, not "${FOR}"`)
  return +m[1] * (m[2] === "h" ? 3_600_000 : 60_000)
})()

if (!process.stdin.isTTY || !process.stdout.isTTY) die("run this in a terminal: every command waits for you to approve it here.")
if (typeof WebSocket !== "function") die(`needs Node.js 22 or newer (this is ${process.version}).`)

// The SDK is vendored next to this file (scripts/vendor-sdk.sh).
const { connect, exponentialBackoff } = await import(new URL("../lib/sdk/index.js", import.meta.url))

// ── showing agent text safely ──────────────────────────────────────────
// The command and its `why` come from the agent. Control, bidi and
// zero-width characters could make what you read differ from what runs, so
// they are shown as visible escapes, never passed to the terminal.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g
const hasHidden = (s) => new RegExp(HIDDEN.source).test(s)
const escapeHidden = (s) => s.replace(HIDDEN, (ch) => red(`\\u{${ch.codePointAt(0).toString(16)}}`))
const showCmd = (cmd) => escapeHidden(cmd).split("\n").map((l, i) => (i ? "  " : bold("$ ")) + l).join("\n")
// Output going back to the agent: no terminal escapes or control characters.
const ANSI = /\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/g
const plain = (s) => s.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")

// Header values reach us as the bytes the agent sent, one char per byte;
// turn UTF-8 back into text when it is UTF-8.
function headerText(v) {
  if (typeof v !== "string" || !/[\u0080-ÿ]/.test(v) || /[^\u0000-ÿ]/.test(v)) return v
  const s = Buffer.from(v, "latin1").toString("utf8")
  return s.includes("�") ? v : s
}

// ── the agent's calls ─────────────────────────────────────────────────
function parseRun(body, headers) {
  let req
  if (/^application\/json/i.test(headers["content-type"] || "")) {
    try { req = JSON.parse(body || "{}") } catch { return { error: "the body is not valid JSON" } }
    if (!req || typeof req !== "object") return { error: "the JSON body must be an object" }
  } else {
    req = { cmd: body, why: headerText(headers["x-why"]), cwd: headerText(headers["x-cwd"]), timeout_s: headers["x-timeout"] }
  }
  const cmd = typeof req.cmd === "string" ? req.cmd.replace(/\s+$/, "") : ""
  if (!cmd.trim()) return { error: "no command: send it as the body (or {\"cmd\": \"...\"})" }
  if (cmd.length > 100_000) return { error: "the command is over 100,000 characters" }
  const timeout = req.timeout_s === undefined || req.timeout_s === "" ? 300 : Number(req.timeout_s)
  if (!Number.isFinite(timeout) || timeout < 1) return { error: "timeout must be a number of seconds, at least 1" }
  let cwd = START_DIR
  if (typeof req.cwd === "string" && req.cwd.length > 4096) return { error: "cwd is over 4,096 characters" }
  if (typeof req.cwd === "string" && req.cwd) {
    cwd = req.cwd === "~" ? os.homedir() : req.cwd.startsWith("~/") ? path.join(os.homedir(), req.cwd.slice(2)) : path.resolve(START_DIR, req.cwd)
  }
  return { cmd, why: typeof req.why === "string" ? req.why.trim().slice(0, 500) : "", cwd, timeout: Math.min(timeout, 86_400) }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}[… ${s.length - n} more characters]` : s)

function resultText(r) {
  const lines = [`status: ${r.status}`]
  if (r.exit !== undefined) lines.push(`exit: ${r.exit}`)
  if (r.seconds !== undefined) lines.push(`seconds: ${r.seconds}`)
  if (r.ran) lines.push(`ran: ${clip(r.ran, 8000).replace(/\n/g, "\n     ")}`)
  if (r.note) lines.push(`note: ${clip(r.note, 2000)}`)
  if (r.error) lines.push(`error: ${clip(r.error, 2000)}`)
  let output = r.output ?? ""
  let truncated = r.truncated
  const build = () => [...lines, ...(truncated ? [`truncated: ${truncated}`] : []), "---", output].join("\n")
  // Cut the middle further until the whole result fits the relay's cap.
  let text = build()
  while (Buffer.byteLength(JSON.stringify(text)) > MAX_JSON && output.length > 200) {
    const keep = Math.floor(output.length * 0.8 / 2)
    const cut = output.length - 2 * keep
    output = output.slice(0, keep) + `\n[… ${cut} more characters cut …]\n` + output.slice(-keep)
    truncated = truncated || "output cut in the middle to fit"
    text = build()
  }
  return text
}

// ── state ─────────────────────────────────────────────────────────────
let session = null
let link = null
let mode = "step"
let count = 0
let ending = false
let running = null      // { child, interrupts, timedOut } while a command runs
let waiter = null       // resolves the key the current prompt waits for
let lineMode = false    // a readline prompt (note, edit) owns the keyboard
const queue = []        // calls waiting their turn
let busy = false
let current = null      // the call on screen, from shown until answered
let cancelPrompt = null // ends the prompt the current call is waiting on
const endsAt = forMs ? Date.now() + forMs : null
// Results sent as async task answers. completeTask throws while the relay link
// is down and is fire-and-forget otherwise, so answers are kept and sent again
// after each reconnect (the relay keeps the same answer if it gets it twice).
const answered = []

function complete(taskId, text) {
  answered.push([taskId, text])
  if (answered.length > 100) answered.shift()
  try { session.completeTask(taskId, { status: 200, body: text, headers: { "content-type": "text/plain; charset=utf-8" } }) }
  catch { out(dim("  (the relay link is down; the result goes to the agent when it reconnects)")) }
}
function resendAnswers() {
  for (const [taskId, text] of answered) {
    try { session.completeTask(taskId, { status: 200, body: text, headers: { "content-type": "text/plain; charset=utf-8" } }) } catch { return }
  }
}

const tools = [
  { method: "GET", path: "/info", description: "OS, user, home folder, starting folder, shell, mode (step or auto) and when the session ends.",
    handler: () => ({
      os: `${os.type()} ${os.release()} (${process.platform} ${process.arch})`,
      user: os.userInfo().username, home: os.homedir(), cwd: START_DIR, shell: SHELL, mode,
      session_ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      queued: queue.length, client: `agent-socket shell ${VERSION}`,
    }) },
  { path: "/run", description: "Run one shell command on the user's machine after the user approves it. Body: the command as plain text, with the reason in an `x-why` header (optional `x-cwd`, `x-timeout` in seconds, default 300); or JSON {cmd, why, cwd, timeout_s}. Answers within ~25 s, or 202 with a taskId to poll at /_as_tasks/<taskId>. The result is plain text: status/exit/seconds/ran/note lines, `---`, then the output.",
    handler: async ({ body, headers }) => {
      const req = parseRun(body, headers)
      if (req.error) return { status: 400, body: { error: { code: "bad_request", message: req.error } } }
      if (ending) return { status: 503, body: { error: { code: "ending", message: "The user is ending this session." } } }
      const call = { n: ++count, id: "run_" + crypto.randomBytes(9).toString("base64url"), ...req, async: false, started: false }
      const done = new Promise((resolve) => { call.finish = resolve })
      queue.push(call)
      pump()
      const r = await Promise.race([done, new Promise((res) => setTimeout(res, HOLD_MS, null))])
      if (r) return { status: 200, body: resultText(r), headers: { "content-type": "text/plain; charset=utf-8" } }
      // Still waiting for the user or still running: answer with a task. The
      // SDK sends this reply before any later I/O callback can complete it.
      call.async = true
      done.then((res) => setImmediate(() => complete(call.id, resultText(res))))
      return { status: 202, taskId: call.id, body: { taskId: call.id } }
    } },
]

// ── the keyboard ──────────────────────────────────────────────────────
readline.emitKeypressEvents(process.stdin)
const keyboard = (on) => {
  if (on) { process.stdin.setRawMode(true); process.stdin.resume() }
  else { process.stdin.setRawMode(false); process.stdin.pause() }
}
process.stdin.on("keypress", (s, key) => {
  if (lineMode) return
  const k = key?.ctrl && key.name === "c" ? "ctrl-c" : key?.name === "return" || key?.name === "enter" ? "enter" : (s || "").toLowerCase()
  if (waiter) return waiter(k)
  // Idle: switch modes or end.
  if (k === "ctrl-c" || k === "q") return end("ended")
  if (k === "a" && mode !== "auto") { mode = "auto"; out(yellow("auto: commands run as they arrive. s goes back to step.")) }
  else if (k === "s" && mode !== "step") { mode = "step"; out(green("step: every command waits for you.")) }
})
const waitKey = (valid) => new Promise((resolve) => {
  waiter = (k) => { if (valid.includes(k)) { waiter = null; cancelPrompt = null; resolve(k) } }
  cancelPrompt = () => waiter("dropped")
  valid.push("dropped")
})
// A line of input (a note, an edited command), with `prefill` already typed.
function askLine(prompt, prefill = "") {
  return new Promise((resolve) => {
    lineMode = true
    process.stdin.setRawMode(false)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 })
    let cancelled = false
    rl.on("SIGINT", () => { cancelled = true; out(); rl.close() })
    cancelPrompt = () => { cancelled = true; out(); rl.close() }
    rl.question(prompt, (answer) => { rl.close(); resolve(answer) })
    rl.on("close", () => { lineMode = false; cancelPrompt = null; keyboard(true); if (cancelled) resolve(null) })
    if (prefill) rl.write(prefill)
  })
}
// A multi-line command is edited in $VISUAL / $EDITOR.
function editInEditor(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-socket-shell-")), "command.sh")
  fs.writeFileSync(file, text + "\n", { mode: 0o600 })
  keyboard(false)
  const editor = process.env.VISUAL || process.env.EDITOR || "vi"
  spawnSync(SHELL, ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" })
  keyboard(true)
  const edited = fs.readFileSync(file, "utf8").replace(/\s+$/, "")
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
  return edited
}

// ── one call at a time ────────────────────────────────────────────────
async function pump() {
  if (busy || ending) return
  const call = queue.shift()
  if (!call) return idleLine()
  busy = true
  current = call
  try { call.finish(await handle(call)) }
  finally { busy = false; current = null; if (!ending) pump() }
}
function idleLine() {
  out(dim(`Waiting for the agent… (${mode}${mode === "auto" ? ": s for step" : ": a for auto"} · q ends)`))
}

async function handle(call) {
  call.started = true
  const time = new Date().toTimeString().slice(0, 8)
  out()
  out(cyan(`── ${call.n} · ${time} `) + dim("─".repeat(30)))
  if (call.why) out(`why: ${escapeHidden(call.why)}`)
  if (call.cwd !== START_DIR) out(dim("in ") + escapeHidden(call.cwd))
  out(showCmd(call.cmd))
  if (hasHidden(call.cmd) || hasHidden(call.cwd) || hasHidden(call.why)) { out(red("⚠ this command, its folder or its reason contains hidden characters, shown as \\u{…}. Look carefully.")) }
  let cmd = call.cmd
  let edited = false
  while (mode !== "auto") {
    const more = queue.length ? dim(`   (${queue.length} more waiting)`) : ""
    out(dim("Enter run · n refuse · e edit and run · a auto · q end") + more)
    const k = await waitKey(["enter", "n", "e", "a", "q", "ctrl-c"])
    if (k === "enter") break
    if (k === "a") { mode = "auto"; out(yellow("auto: commands run as they arrive. s goes back to step (between commands).")); break }
    if (k === "dropped" || call.dropped) return dropped()
    if (k === "q" || k === "ctrl-c") { end("ended"); return { status: "refused", note: "The user ended the session." } }
    if (k === "n") {
      const note = await askLine(dim("Tell the agent why (optional, Enter to skip): "))
      if (call.dropped) return dropped()
      if (note === null) continue
      out(red("✗ refused"))
      return { status: "refused", note: note.trim().slice(0, 2000) || undefined }
    }
    if (k === "e") {
      const next = cmd.includes("\n") ? editInEditor(cmd) : await askLine(bold("$ "), cmd)
      if (call.dropped) return dropped()
      if (next === null || !next.trim()) continue
      // What you typed and submitted runs; no second confirmation.
      cmd = next
      edited = cmd !== call.cmd
      break
    }
  }
  if (ending) return { status: "refused", note: "The user ended the session." }
  call.running = true
  const r = await exec(cmd, call.cwd, call.timeout)
  if (edited) r.ran = cmd
  if (call.dropped) out(yellow("  (the relay link dropped while this ran: the agent didn't get this result and may send the command again)"))
  if (r.status === "done") out((r.exit === 0 ? green("✓") : yellow("!")) + dim(` exit ${r.exit} · ${r.seconds} s · sent`))
  else out(red(`✗ ${r.status}`) + dim(` · ${r.seconds ?? 0} s · sent`) + (r.error ? " " + r.error : ""))
  return r
}

// The relay link dropped while the call waited for you: the agent already got
// a 503 and was told to send it again, so it doesn't run from this prompt.
function dropped() {
  out(dim("  (relay link dropped: this command was withdrawn; the agent was told to send it again)"))
  return { status: "error", error: "connection dropped" }
}

// ── running a command ─────────────────────────────────────────────────
// Every process started by `pid`, found through `ps` (macOS and Linux).
function processTree(pid) {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
  const kids = new Map()
  for (const line of (r.stdout || "").split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number)
    if (p && pp) kids.set(pp, [...(kids.get(pp) || []), p])
  }
  const all = [pid]
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) || []))
  return all
}
function killTree(pid) {
  const pids = processTree(pid)
  for (const p of pids) { try { process.kill(p, "SIGTERM") } catch {} }
  setTimeout(() => { for (const p of pids) { try { process.kill(p, "SIGKILL") } catch {} } }, 2000).unref()
}

// While a command runs it owns the terminal: stdin is yours to type into
// (sudo's password, a y/n), and Ctrl-C reaches it the way it does in any
// shell, because it stays in the terminal's foreground process group. This
// process ignores that Ctrl-C; a second one kills the command's whole tree.
// As in a terminal, Ctrl-C doesn't reach the command's own background jobs
// (`cmd &`); a timeout does stop them, since the shell is still there.
process.on("SIGINT", () => {
  if (!running) return end("ended")
  running.interrupts++
  if (running.interrupts >= 2) killTree(running.child.pid)
})

function exec(cmd, cwd, timeoutS) {
  return new Promise((resolve) => {
    try { if (!fs.statSync(cwd).isDirectory()) throw 0 } catch { return resolve({ status: "error", error: `no such folder: ${cwd}` }) }
    const t0 = Date.now()
    const head = [], tail = []
    let headBytes = 0, tailBytes = 0, total = 0
    const keep = (buf) => {
      total += buf.length
      if (headBytes < HEAD) { const part = buf.subarray(0, HEAD - headBytes); head.push(part); headBytes += part.length; buf = buf.subarray(part.length) }
      if (!buf.length) return
      tail.push(buf); tailBytes += buf.length
      while (tailBytes - tail[0].length >= TAIL) tailBytes -= tail.shift().length
    }
    keyboard(false)
    let child
    try { child = spawn(SHELL, ["-c", cmd], { cwd, stdio: ["inherit", "pipe", "pipe"] }) }
    catch (e) { keyboard(true); return resolve({ status: "error", error: e.message }) }
    running = { child, interrupts: 0, timedOut: false }
    const timer = setTimeout(() => { running.timedOut = true; out(yellow(`\n(timed out after ${timeoutS} s; stopping it)`)); killTree(child.pid) }, timeoutS * 1000)
    child.stdout.on("data", (d) => { process.stdout.write(d); keep(d) })
    child.stderr.on("data", (d) => { process.stderr.write(d); keep(d) })
    child.on("error", (e) => { running.error = e.message })
    // A background job (`server &`) keeps the output pipes open after the
    // command itself has exited; give it a moment, then stop reading.
    child.on("exit", () => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy() }, 1000).unref())
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      const { timedOut, interrupts, error } = running
      running = null
      keyboard(true)
      let output = plain(Buffer.concat(head).toString("utf8"))
      let truncated
      if (total > headBytes) {
        const tailBuf = Buffer.concat(tail)
        const tailStart = Math.max(0, tailBuf.length - (total - headBytes))
        const dropped = total - headBytes - (tailBuf.length - tailStart)
        if (dropped > 0) { output += `\n[… ${dropped} bytes cut …]\n`; truncated = `kept the first ${headBytes} and last ${tailBuf.length - tailStart} of ${total} bytes` }
        output += plain(tailBuf.subarray(tailStart).toString("utf8"))
      }
      const seconds = Math.round((Date.now() - t0) / 100) / 10
      const status = error ? "error" : timedOut ? "timed_out" : interrupts || signal ? "killed" : "done"
      resolve({ status, exit: code ?? (signal ? `signal ${signal}` : undefined), seconds, output, truncated, error })
    })
  })
}

// ── session ───────────────────────────────────────────────────────────
function copy(text) {
  const tries = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
  for (const [bin, ...a] of tries) {
    const r = spawnSync(bin, a, { input: text, stdio: ["pipe", "ignore", "ignore"] })
    if (r.status === 0) return true
  }
  return false
}
function showLink(url, changed) {
  link = url
  const copied = copy(url)
  out()
  out(changed ? yellow(bold("The link changed. Paste this new one into the agent's chat:")) : bold(`Link${copied ? " (copied)" : ""}:`))
  out("  " + cyan(url))
  if (changed && copied) out(dim("  (copied)"))
}

let endTimer = null
async function end(why) {
  if (ending) return
  ending = true
  if (running) killTree(running.child.pid)
  for (const call of queue.splice(0)) call.finish({ status: "refused", note: "The user ended the session." })
  clearTimeout(endTimer)
  out()
  out(why === "timer" ? yellow("Time's up: the session ended and the link no longer works.") : "Session ended. The link no longer works.")
  // Wait for the close to reach the relay: a socket that just vanishes is
  // held for a resume, and its link would keep answering.
  const ws = session?.ws
  const closed = ws && ws.readyState === 1 ? new Promise((res) => { ws.addListener("close", res); setTimeout(res, 2000) }) : Promise.resolve()
  session?.close()
  await closed
  process.exit(0)
}

out(bold(`agent-socket shell ${VERSION}`) + dim(` · ${os.userInfo().username}@${os.hostname()} · ${SHELL}`))
const backoff = exponentialBackoff()
try {
  session = await connect({
    baseUrl: RELAY,
    appId: "agent-socket-shell",
    appDescription: "Shell commands on the user's machine, each approved by them.",
    agentsMd: AGENTS_MD,
    tools,
    onReconnect: () => resendAnswers(),
    onSessionChanged: ({ tokensRemapped }) => { const next = [...tokensRemapped.values()][0]; if (next) showLink(next, true) },
    onDisconnect: (info) => {
      // Calls still held open by the relay just failed with 503 on the agent's
      // side; drop the ones you haven't seen, the agent will send them again.
      const lost = queue.filter((c) => !c.async)
      for (const c of lost) { queue.splice(queue.indexOf(c), 1); c.finish({ status: "error", error: "connection dropped" }) }
      if (lost.length) out(dim(`  (relay link dropped: ${lost.length} waiting command(s) dropped; the agent was told to retry)`))
      // The one on screen too: withdrawn if you haven't run it yet.
      if (current && !current.async) {
        current.dropped = true
        if (!current.running) cancelPrompt?.()
      }
      return backoff(info)
    },
  })
} catch (e) {
  die(`couldn't reach the relay at ${RELAY}: ${e.message}`)
}
const minted = await session.mintAgentToken({ label: `shell ${os.hostname()}` })
showLink(minted.url, false)
out(dim(`Paste it into your agent's chat. ${endsAt ? `Ends at ${new Date(endsAt).toTimeString().slice(0, 5)} (--for ${FOR})` : "No time limit"} · q or Ctrl-C ends it now.`))
out(dim("Every command waits for you here."))
if (endsAt) endTimer = setTimeout(() => end("timer"), forMs)
keyboard(true)
idleLine()
