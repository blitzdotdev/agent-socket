// 64-shell — the shell CLI (shell/bin/agent-socket-shell.mjs) end to end: it
// runs in a pseudo-terminal (util-linux `script`) against the relay, the
// test types keys into it like a person and calls the link like an agent.
// Covers: info, run with Enter (sync and as a 202 task), refuse with a note,
// edit, auto and back to step, a queue of three, Ctrl-C stopping a command
// and its background child, timeout, output cut to fit the relay's task
// cap, hidden characters (in the command or its folder) shown escaped, an
// oversized folder refused, the relay link dropping while a command waits
// (it is withdrawn, not run), a bad request, and q ending the session so the
// link answers 503.

import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Assert } from "../lib/assert.mjs"
import { RELAY_HTTP, killWs } from "../lib/relay.mjs"

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../shell/bin/agent-socket-shell.mjs")
const HOLD_MS = 1500 // under the harness relay's MAX_SYNC_TOOL_MS (3000)
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g")

function startCli() {
  // `script -qfc` gives the CLI a real terminal; its stdin is our keyboard.
  const child = spawn("script", ["-qfc", `${process.execPath} ${CLI} --relay ${RELAY_HTTP} --for 10m`, "/dev/null"], {
    env: { ...process.env, AGENT_SOCKET_SHELL_HOLD_MS: String(HOLD_MS), SHELL: "/bin/sh", TERM: "xterm" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let screen = ""
  child.stdout.on("data", (d) => { screen += d.toString("utf8") })
  child.stderr.on("data", (d) => { screen += d.toString("utf8") })
  const text = () => screen.replace(ANSI, "").replace(/\r/g, "")
  let mark = 0
  return {
    child,
    text,
    // Wait for `re` in the output after the last waitFor's match.
    async waitFor(re, what, ms = 10_000) {
      const deadline = Date.now() + ms
      for (;;) {
        const t = text().slice(mark)
        const m = re.exec(t)
        if (m) { mark += m.index + m[0].length; return m }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; screen tail:\n${text().slice(-1500)}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    keys: (s) => child.stdin.write(s),
  }
}

// The agent's side: POST /run, then poll the task while it answers 202.
async function run(base, body, headers = {}) {
  let r = await fetch(`${base}/run`, { method: "POST", body, headers })
  let wentAsync = false
  const deadline = Date.now() + 30_000
  while (r.status === 202) {
    if (Date.now() > deadline) throw new Error(`no result for ${JSON.stringify(body)} within 30 s`)
    wentAsync = true
    const { taskId } = await r.json()
    await new Promise((res) => setTimeout(res, 300))
    r = await fetch(`${base}/_as_tasks/${taskId}`)
  }
  return { status: r.status, text: await r.text(), wentAsync, type: r.headers.get("content-type") }
}
const field = (text, name) => (new RegExp(`^${name}: (.*)$`, "m").exec(text) || [])[1]
const output = (text) => text.slice(text.indexOf("\n---\n") + 5)

export default async function () {
  const a = new Assert("64-shell")
  if (spawnSync("script", ["--version"]).status !== 0) return { skip: "needs util-linux script for a pseudo-terminal" }

  const cli = startCli()
  try {
    const m = await cli.waitFor(/(https?:\/\/\S+\/agents\.md)/, "the link", 20_000)
    const base = m[1].replace(/\/agents\.md$/, "")
    a.pass("CLI printed a link")
    await cli.waitFor(/Waiting for the agent/, "idle line")

    // info
    const info = await (await fetch(`${base}/info`)).json()
    a.equal([info.mode, info.shell], ["step", "/bin/sh"], "GET /info: step mode, the shell")

    // Enter runs it; quick enough for a direct answer.
    let p = run(base, "echo hello-$((40+2))", { "x-why": "say hello" })
    await cli.waitFor(/why: say hello\n\$ echo hello-\$\(\(40\+2\)\)/, "the command shown with its why")
    cli.keys("\r")
    let r = await p
    a.equal([r.status, field(r.text, "status"), field(r.text, "exit"), output(r.text).trim()], [200, "done", "0", "hello-42"], "Enter runs it; result has status, exit and output")
    a.ok(/^text\/plain/.test(r.type || ""), "result is text/plain", { type: r.type })
    a.ok(!r.wentAsync, "a quick approval answers directly")

    // Slow approval → 202 task, polled to the result.
    p = run(base, "echo later", { "x-why": "slow approval" })
    await cli.waitFor(/\$ echo later/, "slow command shown")
    await new Promise((res) => setTimeout(res, HOLD_MS + 800))
    cli.keys("\r")
    r = await p
    a.ok(r.wentAsync && field(r.text, "status") === "done" && output(r.text).trim() === "later", "approval after the hold → 202 task with the result", { r })

    // Refuse with a note.
    p = run(base, "rm -rf /tmp/does-not-matter", { "x-why": "clean up" })
    await cli.waitFor(/\$ rm -rf/, "rm shown")
    cli.keys("n")
    await cli.waitFor(/Tell the agent why/, "note prompt")
    cli.keys("not that folder\r")
    r = await p
    a.equal([field(r.text, "status"), field(r.text, "note")], ["refused", "not that folder"], "refused, with the user's note")

    // Edit: the edited command runs and is reported as `ran:`.
    p = run(base, "echo one")
    await cli.waitFor(/\$ echo one/, "command to edit")
    cli.keys("e")
    await new Promise((res) => setTimeout(res, 300))
    cli.keys("\x15echo two\r") // Ctrl-U clears the prefilled line
    r = await p
    a.equal([field(r.text, "ran"), output(r.text).trim()], ["echo two", "two"], "edited command runs, reported as ran:")

    // JSON body, cwd, and a queue of three answered in order.
    const ps = [1, 2, 3].map((i) => run(base, JSON.stringify({ cmd: `pwd; echo q${i}`, why: `queue ${i}`, cwd: "/tmp" }), { "content-type": "application/json" }))
    for (let i = 1; i <= 3; i++) {
      await cli.waitFor(new RegExp(`why: queue \\d+`), `queued call ${i}`)
      cli.keys("\r")
    }
    const qs = await Promise.all(ps)
    a.ok(qs.every((q, i) => output(q.text).trim() === `/tmp\nq${i + 1}`), "three queued calls, each run in cwd /tmp", { qs: qs.map((q) => q.text) })

    // Ctrl-C stops the running command and the session stays up. As in a
    // terminal, the command's background job isn't touched, and it doesn't
    // keep the result waiting either.
    const tag = "sleep 97" + String(process.pid % 10)
    p = run(base, `${tag}0 & ${tag}1; wait`, { "x-why": "long sleep" })
    await cli.waitFor(/long sleep/, "sleep shown")
    cli.keys("\r")
    await new Promise((res) => setTimeout(res, 800))
    cli.keys("\x03")
    r = await p
    a.equal(field(r.text, "status"), "killed", "Ctrl-C → killed, with the background job still holding the output pipe")
    a.ok(!spawnSync("pgrep", ["-f", `${tag}1`]).stdout.length, "the foreground command is gone")
    spawnSync("pkill", ["-f", `${tag}0`])

    // Timeout stops the whole tree, background jobs included.
    p = run(base, `${tag}2 & ${tag}3; wait`, { "x-timeout": "1" })
    await cli.waitFor(/\$ sleep 97\d2 &/, "timeout command shown")
    cli.keys("\r")
    r = await p
    a.equal(field(r.text, "status"), "timed_out", "x-timeout → timed_out")
    await new Promise((res) => setTimeout(res, 300))
    const left = spawnSync("pgrep", ["-f", `${tag}[23]`], { encoding: "utf8" }).stdout.trim()
    a.ok(!left, "timeout left nothing running", { left })

    // Big output is cut in the middle to fit the relay's 64 KiB task cap.
    p = run(base, "printf START; head -c 300000 /dev/zero | tr '\\0' x; printf END")
    await cli.waitFor(/\$ printf START/, "big output command")
    await new Promise((res) => setTimeout(res, HOLD_MS + 300)) // force the task path, which has the cap
    cli.keys("\r")
    r = await p
    const o = output(r.text)
    a.ok(r.wentAsync && field(r.text, "truncated") && o.startsWith("START") && o.endsWith("END") && Buffer.byteLength(JSON.stringify(r.text)) <= 64 * 1024,
      "big output: head and tail kept, marked truncated, fits the task cap", { len: r.text.length, truncated: field(r.text, "truncated") })

    // Hidden characters are shown as escapes, with a warning.
    p = run(base, `echo safe${ESC}[2K${ESC}[1Gecho evil`)
    await cli.waitFor(/u\{1b\}.*\n.*hidden characters/, "escaped control characters and the warning")
    cli.keys("n")
    await cli.waitFor(/Tell the agent why/, "note prompt")
    cli.keys("\r")
    r = await p
    a.equal(field(r.text, "status"), "refused", "escape-sequence command shown escaped, refused")

    // The folder comes from the agent too: shown escaped, with the warning.
    p = run(base, JSON.stringify({ cmd: "echo in-folder", cwd: `/tmp${ESC}[2K${ESC}[1G/home` }), { "content-type": "application/json" })
    await cli.waitFor(/in \/tmp\\u\{1b\}\[2K\\u\{1b\}\[1G\/home\n\$ echo in-folder\n.*hidden characters/, "the folder shown escaped, with the warning")
    cli.keys("n")
    await cli.waitFor(/Tell the agent why/, "note prompt")
    cli.keys("\r")
    r = await p
    a.equal(field(r.text, "status"), "refused", "escape-sequence folder shown escaped, refused")

    // A folder too long to report back is refused up front (it used to make
    // the result too big to ever fit, and the CLI spun forever).
    const long = await fetch(`${base}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "true", cwd: "/x" + "y".repeat(70_000) }) })
    a.equal(long.status, 400, "a 70,000-character folder → 400")

    // The relay link drops while a command waits on screen: the agent gets a
    // 503 and is told to retry, so the command is withdrawn here and Enter
    // doesn't run it.
    const sessionId = /\/v1\/t\/as_([0-9A-Z]{8})_/.exec(base)[1]
    p = fetch(`${base}/run`, { method: "POST", body: "echo ran-$((6*7))-marker", headers: { "x-why": "before the drop" } })
    await cli.waitFor(/why: before the drop\n/, "the command shown before the drop")
    a.equal((await killWs(sessionId)).status, 200, "kill-ws")
    const lost = await p
    a.equal(lost.status, 503, "the agent's call fails with 503 when the link drops")
    await cli.waitFor(/this command was withdrawn/, "the command withdrawn on screen")
    cli.keys("\r")
    await new Promise((res) => setTimeout(res, 800))
    a.ok(!/ran-42-marker/.test(cli.text()), "Enter after the drop runs nothing")
    const deadline = Date.now() + 15_000
    while ((await fetch(`${base}/info`)).status !== 200) {
      if (Date.now() > deadline) throw new Error("the link didn't come back after the drop")
      await new Promise((res) => setTimeout(res, 300))
    }
    p = run(base, "echo after-drop")
    await cli.waitFor(/\$ echo after-drop/, "a command after the reconnect")
    cli.keys("\r")
    r = await p
    a.equal(output(r.text).trim(), "after-drop", "the same link works after the reconnect")

    // Auto: `a` at a prompt runs it and the next one runs without a key.
    p = run(base, "echo auto-1")
    await cli.waitFor(/\$ echo auto-1/, "auto-1 shown")
    cli.keys("a")
    r = await p
    a.equal(output(r.text).trim(), "auto-1", "a runs the command")
    r = await run(base, "echo auto-2")
    a.equal(output(r.text).trim(), "auto-2", "auto: the next command runs without a key")
    cli.keys("s")
    await cli.waitFor(/step: every command waits/, "back to step")
    p = run(base, "echo step-again")
    await cli.waitFor(/\$ echo step-again\nEnter run/, "step again: waits for a key")
    cli.keys("\r")
    r = await p
    a.equal(output(r.text).trim(), "step-again", "step mode again")

    // Bad request.
    const bad = await fetch(`${base}/run`, { method: "POST", body: "   " })
    a.equal(bad.status, 400, "empty command → 400")

    // q ends the session: the CLI exits and the link answers 503 at once.
    await cli.waitFor(/Waiting for the agent/, "idle before q")
    cli.keys("q")
    const code = await new Promise((res) => { cli.child.on("exit", res); setTimeout(() => res("still running"), 5000) })
    a.equal(code, 0, "q: the CLI exits cleanly")
    const gone = await fetch(`${base}/info`)
    a.equal(gone.status, 503, "after q the link answers 503")
    const body = await gone.json()
    a.ok(!/reconnecting/.test(body?.error?.message || ""), "the session ended (not held for a resume)", { body })
  } catch (e) {
    if (!e.scenario && !e.extra) e.message += "\n--- CLI screen ---\n" + cli.text().slice(-3000)
    throw e
  } finally {
    try { cli.child.kill("SIGKILL") } catch {}
  }
  return a
}
