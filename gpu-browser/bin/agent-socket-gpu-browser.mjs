#!/usr/bin/env node
// npx @agent-socket/gpu-browser — share this machine's GPU browser with an
// agent through an agent-socket link. Runs as you; starts the server
// (../app/server.mjs) as the agent-socket-gpu-browser account, which the
// installer (../install/install.sh, run once with sudo after asking) creates.
//
//   npx @agent-socket/gpu-browser [--for 60m|2h|none] [--relay URL] [--yes]
//   npx @agent-socket/gpu-browser install | status | stop | uninstall | help
//
// Approvals (an agent asking for more hosts) are answered here, in this
// terminal; nothing else can answer them.

import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const NAME = "agent-socket-gpu-browser"
const DIR = "/opt/" + NAME
const NODE = DIR + "/node/bin/node"
const SERVER = DIR + "/app/server.mjs"
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version
const SETTINGS = path.join(os.homedir(), ".agent-socket", "gpu-browser")
const DEFAULT_RELAY = "https://agentsocket.dev"
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
const MAC = process.platform === "darwin"
const TTY = !!(process.stdin.isTTY && process.stdout.isTTY)

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = c(2), bold = c(1), green = c(32), yellow = c(33), red = c(31)
const say = (s = "") => process.stdout.write(s + "\n")
const die = (s, code = 1) => { process.stderr.write(red("✗ ") + s + "\n"); process.exit(code) }
// Server output is the account's (less trusted than you): no control,
// bidi or format characters reach your terminal.
const safe = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "?").slice(0, 2000)

// ── what is installed ─────────────────────────────────────────────────
// A hash of what the install is made from, so a changed package reinstalls
// even when its version number didn't move.
function packageHash() {
  const h = crypto.createHash("sha256")
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules") continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { h.update(path.relative(PKG, p) + "\0"); h.update(fs.readFileSync(p)); h.update("\0") }
    }
  }
  walk(path.join(PKG, "app"))
  walk(path.join(PKG, "install"))
  return h.digest("hex")
}
function installed() {
  try {
    const env = Object.fromEntries(fs.readFileSync(DIR + "/install.env", "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
    return fs.existsSync(SERVER) ? env : null
  } catch { return null }
}
const newer = (a, b) => {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}
const running = () => spawnSync("pgrep", ["-f", SERVER], { encoding: "utf8" }).stdout.trim()
// Exactly the command the installed sudo rule allows. macOS: root joins the
// account's launchd domain (Chromium needs it) and runs the inner sudo, whose
// -H is needed because Apple's sudoers keeps HOME. Linux: sudo sets HOME to
// the account's anyway, and -H would make sudo ask for a password.
const startArgs = (acctUid) => MAC
  ? ["/bin/launchctl", "asuser", String(acctUid), "/usr/bin/sudo", "-u", NAME, "-H", NODE, SERVER]
  : ["-u", NAME, NODE, SERVER]
// Does the installed sudo rule let us start without a password?
const ruleActive = (acctUid) => spawnSync("sudo", ["-n", "-l", ...startArgs(acctUid)], { stdio: "ignore" }).status === 0

async function ask(question, def) {
  if (!TTY) return def
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = await new Promise((r) => rl.question(question, r))
  rl.close()
  return a.trim()
}

// ── install / update ──────────────────────────────────────────────────
async function install(yes, reason) {
  say(bold(reason))
  say(`It will, with one sudo password prompt:
  • create a separate account, ${NAME}, that can't log in and can't read your files
  • put Node.js ${fs.readFileSync(path.join(PKG, "install/node.txt"), "utf8").match(/^version (.+)$/m)[1]}, Playwright and Chromium (~400 MB) in ${DIR}
  • add one sudo rule that lets you start the browser as that account without a password
  • check that Chromium starts there with its sandbox and the GPU
Remove everything later with: npx @agent-socket/gpu-browser uninstall`)
  if (!yes) {
    if (!TTY) die("run it in a terminal to confirm, or pass --yes")
    if (!/^(|y|yes)$/i.test(await ask("Continue? [Y/n] ", "n"))) die("nothing changed", 0)
  }
  // Streamed: the install takes a few minutes and says what it is doing.
  const child = spawn("sudo", ["/bin/sh", path.join(PKG, "install/install.sh"), "--user", os.userInfo().username, "--home", os.homedir(),
    "--pkg", PKG, "--version", VERSION, "--hash", packageHash()], { cwd: "/", stdio: ["inherit", "pipe", "inherit"] })
  const events = []
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("@@install ")) events.push(line.slice(10))
    else if (line) say(dim(line))
  })
  const status = await new Promise((r) => child.on("close", r))
  if (status !== 0 || !events.includes("done")) die("install failed (above); run the same command again after fixing it")
  if (events.includes("software-rendering")) say(yellow("⚠ Chromium renders in software here (no usable GPU), so renders will be slow."))
  if (events.includes("sudo-rule skipped")) say(yellow("⚠ No sudo rule: each start will ask for your password."))
  say(green("✓ installed"))
  if (events.includes("home-open")) {
    const mode = (fs.statSync(os.homedir()).mode & 0o777).toString(8)
    say(yellow(`⚠ Your home folder (${os.homedir()}, mode ${mode}) can be opened by other accounts, so the browser's account could read files in it.`))
    say(dim("  Closing it (chmod 700) is what macOS does for new accounts; it can break sharing it with other local users (web servers in ~/public_html, Samba)."))
    if (!yes && /^(|y|yes)$/i.test(await ask("Close it? [Y/n] ", "n"))) {
      fs.mkdirSync(SETTINGS, { recursive: true })
      fs.writeFileSync(path.join(SETTINGS, "home-mode-before.txt"), mode + "\n")
      fs.chmodSync(os.homedir(), 0o700)
      say(green("✓ closed (uninstall offers to put it back)"))
    }
  }
}

// ── your settings ─────────────────────────────────────────────────────
function settings() {
  const top = path.dirname(SETTINGS)
  fs.mkdirSync(SETTINGS, { recursive: true })
  const copy = (from, to) => { if (!fs.existsSync(to)) fs.copyFileSync(path.join(PKG, "install", from), to) }
  copy("agent-socket-README.md", path.join(top, "README.md"))
  copy("user-README.md", path.join(SETTINGS, "README.md"))
  const hostsFile = path.join(SETTINGS, "allowed-hosts.txt")
  if (!fs.existsSync(hostsFile)) fs.writeFileSync(hostsFile, "# Hosts the GPU browser's pages may reach, one per line (*.example.com works).\n# \"always\" answers add to this file; edit it freely.\n")
  const allow = fs.readFileSync(hostsFile, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim().toLowerCase()).filter((h) => h && HOST_RE.test(h))
  let config = {}
  try { config = JSON.parse(fs.readFileSync(path.join(SETTINGS, "config.json"), "utf8")) } catch (e) { if (e.code !== "ENOENT") say(yellow("⚠ ignoring config.json: " + e.message)) }
  return { hostsFile, allow, config }
}

// ── run ───────────────────────────────────────────────────────────────
function parseFor(v) {
  if (v === "none" || v === "0") return 0
  const m = /^(\d+)(m|h)$/.exec(v || "")
  if (!m) die("--for takes e.g. 30m, 2h or none")
  return Number(m[1]) * (m[2] === "h" ? 60 : 1)
}

async function start(opts) {
  const { hostsFile, allow, config } = settings()
  const relay = String(opts.relay || config.relay || DEFAULT_RELAY).replace(/\/+$/, "")
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(relay) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(relay)) die("the relay must be an https URL (got " + relay + ")")
  const minutes = opts.for !== undefined ? parseFor(opts.for) : config.minutes ?? 60
  const inst = installed()
  if (running()) die("the GPU browser is already running (another terminal?). Stop it there, or: npx @agent-socket/gpu-browser stop")
  const key = crypto.randomBytes(16).toString("hex")

  const endsAt = minutes ? Date.now() + minutes * 60_000 : null

  let ready = false, link = null, stopping = false, child = null
  const queue = []            // pending asks, answered one at a time
  let current = null, rl = null
  const send = (line) => { try { child?.stdin.write(line + "\n") } catch {} }
  const prompt = () => {
    if (current || !queue.length || stopping) return
    current = queue.shift()
    process.stdout.write("\x07")
    say("")
    say(yellow("⚠ The agent asks to let the browser's pages reach:"))
    for (const h of current.hosts) say("    " + bold(h) + (h.startsWith("*.") ? dim("  (every subdomain)") : ""))
    for (const l of current.text.split("\n").filter((l) => l.startsWith("Its reason:"))) say("  " + l)
    if (MAC) spawnSync("osascript", ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "agent-socket GPU browser"', "-e", "end run", "The agent asks for " + current.hosts.join(", ") + " — answer in the terminal"], { stdio: "ignore" })
    if (!TTY) { say(dim("  (no terminal to answer in: denied)")); send(`answer ${current.id} deny`); current = null; return prompt() }
    rl.setPrompt("  Allow for this session? [y/N], or type 'always' to also remember it: ")
    rl.prompt()
  }
  const onAnswer = (input) => {
    if (!current) return
    const a = input.trim().toLowerCase()
    const choice = a === "always" ? "always" : /^y(es)?$/.test(a) ? "allow" : "deny"
    send(`answer ${current.id} ${choice}`)
    current = null
    prompt()
  }
  if (TTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl.on("line", onAnswer)
    rl.on("SIGINT", () => stop("Ctrl-C"))
  }

  const event = (name, rest) => {
    if (name === "ready") { ready = true; return }
    if (name === "link") {
      const url = rest[0] || ""
      if (!url.startsWith(relay + "/v1/t/") || !/^[\x21-\x7e]+$/.test(url)) return say(yellow("⚠ ignored a malformed link from the server"))
      link = url
      say("")
      say(green("✓ Sharing. Paste this link into the agent's chat") + (copy(url) ? dim(" (copied to the clipboard)") : "") + ":")
      say("    " + bold(url))
      say(dim(`  Anyone with the link can use this browser ${endsAt ? "for " + minutes + " min (until " + new Date(endsAt).toLocaleTimeString() + ")" : "until you stop it"}. Ctrl-C stops it.`))
      say(dim(`  Pages reach only the agent's uploads${allow.length ? " and " + allow.join(", ") : ""}; the agent asks here for anything else.`))
      say("")
      return
    }
    if (name === "ask") {
      const [id, kind, b64, ...hosts] = rest
      if (!/^[0-9a-f]{6}$/.test(id) || kind !== "hosts" || !hosts.length || !hosts.every((h) => HOST_RE.test(h))) return
      let text = ""
      try { text = safe(Buffer.from(b64, "base64").toString("utf8")) } catch {}
      queue.push({ id, hosts, text })
      return prompt()
    }
    if (name === "done") {
      // Answered (here) or timed out (server side): drop it from the queue.
      const i = queue.findIndex((q) => q.id === rest[0])
      if (i >= 0) queue.splice(i, 1)
      if (current && current.id === rest[0]) { current = null; say(dim("  (request timed out)")); prompt() }
      return
    }
    if (name === "persist-hosts") {
      const add = rest.filter((h) => HOST_RE.test(h))
      const have = new Set(fs.readFileSync(hostsFile, "utf8").split("\n").map((l) => l.trim()))
      const fresh = add.filter((h) => !have.has(h))
      if (fresh.length) fs.appendFileSync(hostsFile, fresh.join("\n") + "\n")
      return say(green("✓ remembered in " + hostsFile + ": " + add.join(", ")))
    }
    if (name === "ended") return say(dim("session ended (" + safe(rest[0] || "") + ")"))
  }
  const prefix = "@@gpu-browser:" + key + " "
  // Server output goes above an open approval prompt, not into it.
  const show = (text) => {
    if (current && rl) {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      say(text)
      rl.prompt(true)
    } else say(text)
  }
  let timer = null
  const watchReady = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (ready) return
      say(red("✗ The browser didn't confirm its start within 20 s (its input didn't arrive through sudo)."))
      stop("no answer")
    }, 20_000)
  }

  // Start the server through the sudo rule, detached: it then isn't in this
  // terminal's process group, and Ctrl-C reaches only us (we end the link
  // cleanly). Without the rule (or when a later, broader sudo rule still
  // wants a password, which sudo -l doesn't show) ask for the password once
  // and start it attached.
  let retried = false
  const launch = (nopass) => {
    if (!nopass) {
      say(dim("sudo asks for your password to start the browser as " + NAME + "."))
      if (spawnSync("sudo", ["-v"], { stdio: "inherit" }).status !== 0) die("sudo failed")
    }
    const p = spawn("sudo", ["-n", ...startArgs(inst.account_uid)], { cwd: "/", stdio: ["pipe", "pipe", "pipe"], detached: nopass })
    child = p
    let errText = ""
    readline.createInterface({ input: p.stdout }).on("line", (line) => {
      if (line.startsWith(prefix)) { const [name, ...rest] = line.slice(prefix.length).split(" "); return event(name, rest) }
      if (line.startsWith("@@gpu-browser:")) return   // not ours: never shown, never acted on
      show(dim(safe(line)))
    })
    readline.createInterface({ input: p.stderr }).on("line", (line) => {
      errText += line + "\n"
      if (!/password is required/.test(line)) show(dim(safe(line)))
    })
    p.on("exit", (code) => {
      if (p !== child) return
      if (!ready && !stopping && !retried && /password is required/.test(errText)) { retried = true; return launch(false) }
      rl?.close()
      if (!stopping && !link) die("the browser stopped (exit status " + code + "); its output is above")
      process.exit(stopping || code === 0 ? 0 : 1)
    })
    p.stdin.on("error", () => {})
    p.stdin.write(JSON.stringify({ relay, key, allow, minutes, chromium: { args: Array.isArray(config.chromiumArgs) ? config.chromiumArgs : [] } }) + "\n")
    watchReady()
  }

  function stop(why) {
    if (stopping) return
    stopping = true
    clearTimeout(timer)
    say(dim("stopping (" + why + ")..."))
    send("stop")
    child?.stdin.end()
    setTimeout(() => process.exit(0), 8_000).unref()
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stop(sig))
  launch(ruleActive(inst.account_uid))
}

function copy(text) {
  const tools = MAC ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
  for (const [cmd, ...args] of tools) {
    if (spawnSync("sh", ["-c", "command -v " + cmd], { stdio: "ignore" }).status !== 0) continue
    if (spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0) return true
  }
  return false
}

// ── status / stop / uninstall ─────────────────────────────────────────
function status() {
  const inst = installed()
  say(bold("agent-socket GPU browser ") + dim("(npx @agent-socket/gpu-browser " + VERSION + ")"))
  if (!inst) return say("  not installed (the first run installs it)")
  say(`  installed: ${DIR}, version ${inst.version}${inst.hash === packageHash() ? "" : dim(" (this package differs: the next start updates it)")}`)
  say(`  account:   ${NAME} (uid ${inst.account_uid}), installed by ${inst.user}`)
  say(`  GPU:       ${inst.gpu || "unknown"}`)
  say(`  sudo rule: ${ruleActive(inst.account_uid) ? "active (starts without a password)" : "not active (each start asks for your password)"}`)
  say(`  running:   ${running() ? "yes" : "no"}`)
  say(`  settings:  ${SETTINGS}`)
  say(`  remove:    npx @agent-socket/gpu-browser uninstall  (or: sudo sh ${DIR}/uninstall.sh)`)
}
function stopOthers() {
  if (!running()) return say("not running")
  say(dim("stopping the server (sudo may ask for your password)..."))
  spawnSync("sudo", ["-u", NAME, "pkill", "-f", SERVER], { stdio: "inherit" })
  say(running() ? red("✗ still running") : green("✓ stopped"))
}
async function uninstall(yes) {
  if (!fs.existsSync(DIR)) return say("not installed")
  say("This removes the browser's account (" + NAME + "), its sudo rule and " + DIR + ".")
  if (!yes) {
    if (!TTY) die("run it in a terminal to confirm, or pass --yes")
    if (!/^(|y|yes)$/i.test(await ask("Remove? [Y/n] ", "n"))) die("nothing changed", 0)
  }
  const r = spawnSync("sudo", ["/bin/sh", DIR + "/uninstall.sh"], { cwd: "/", stdio: "inherit" })
  if (r.status !== 0) die("uninstall failed (above)")
  const before = path.join(SETTINGS, "home-mode-before.txt")
  if (fs.existsSync(before)) {
    const mode = fs.readFileSync(before, "utf8").trim()
    if (/^[0-7]{3}$/.test(mode) && !yes && /^(y|yes)$/i.test(await ask(`Install closed your home folder (it was ${mode}). Open it again? [y/N] `, "n"))) {
      fs.chmodSync(os.homedir(), parseInt(mode, 8))
      say(green("✓ home folder back to " + mode))
    }
    fs.rmSync(before, { force: true })
  }
  say(green("✓ removed") + dim(" (your settings stay in " + SETTINGS + ")"))
}

// ── main ──────────────────────────────────────────────────────────────
const HELP = `npx @agent-socket/gpu-browser — let an agent anywhere render on this machine's GPU

  npx @agent-socket/gpu-browser             start; prints a link to paste into the agent's chat
      --for 30m | 2h | none                 how long the link lives (default 60m)
      --relay https://...                   another agent-socket relay (default ${DEFAULT_RELAY})
      --yes                                 don't ask before installing or updating
  npx @agent-socket/gpu-browser install     only install or update (the first start does it too)
  npx @agent-socket/gpu-browser status      what is installed, where, and whether it runs
  npx @agent-socket/gpu-browser stop        stop a browser running in another terminal
  npx @agent-socket/gpu-browser uninstall   remove the account, the sudo rule and ${DIR}

The first run installs it (one sudo prompt). Settings: ${SETTINGS}`

async function main() {
  const argv = process.argv.slice(2)
  const opts = {}
  let cmd = "start"
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--yes" || a === "-y") opts.yes = true
    else if (a === "--for" || a === "--relay") opts[a.slice(2)] = argv[++i]
    else if (a.startsWith("--for=") || a.startsWith("--relay=")) opts[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1)
    else if (["start", "install", "status", "stop", "uninstall", "help", "version"].includes(a)) cmd = a
    else if (a === "-h" || a === "--help") cmd = "help"
    else die("unknown argument: " + a + "\n\n" + HELP)
  }
  if (cmd === "help") return say(HELP)
  if (cmd === "version") return say(VERSION)
  if (!MAC && process.platform !== "linux") die("macOS and Linux only")
  if (process.getuid?.() === 0) die("run it as your normal user, not root (it asks for sudo when it needs it)")
  if (cmd === "status") return status()
  if (cmd === "stop") return stopOthers()
  if (cmd === "uninstall") return uninstall(opts.yes)

  if (process.env.HTTPS_PROXY || process.env.https_proxy) say(yellow("⚠ HTTPS_PROXY is set, but the GPU browser connects directly (proxies aren't supported yet)."))
  const inst = installed()
  if (cmd === "install" && inst && inst.hash === packageHash()) return say(green("✓ already installed and current"))
  if (!inst) await install(opts.yes, "The GPU browser isn't installed yet.")
  else if (inst.user !== os.userInfo().username) die(`it is installed for ${inst.user} on this machine; they can remove it with: npx @agent-socket/gpu-browser uninstall`)
  else if (newer(inst.version, VERSION)) die(`a newer version (${inst.version}) is installed; run: npx @agent-socket/gpu-browser@latest`)
  else if (inst.hash !== packageHash()) {
    if (running()) die("an update is ready, but the browser is running in another terminal; stop it first")
    await install(opts.yes, `Updating the GPU browser (${inst.version} → ${VERSION}).`)
  }
  if (cmd === "install") return
  await start(opts)
}

main().catch((e) => die(e.stack || String(e)))
