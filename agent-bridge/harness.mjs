// Harness adapters: spawn the user's preferred AI CLI in headless mode,
// pipe the prompt in, return stdout. Each case must actually shell out — no
// stubs. Adding a new harness is one new case below.
//
// Public surface:
//   startHarness({harness, prompt, timeout_ms, log}) → { pid, promise, cancel }
// Caller owns the promise (.then for success, .catch for failure) and can
// call cancel() at any time to SIGTERM (escalating to SIGKILL after 2s).

import { spawn, execFileSync } from "node:child_process"

// Resolve absolute binary paths once at module load. Background-launched node
// processes don't always inherit the shell PATH the way you'd expect (launchd
// in particular has its own minimal default), so `which` at startup is the
// reliable way to find harness CLIs that may live under /opt/homebrew/bin,
// ~/.local/bin, etc.
const BIN_PATH = {}
function resolveBin(name) {
  if (name in BIN_PATH) return BIN_PATH[name]
  // Look in a generous PATH at resolve time; the shell's PATH is augmented
  // beyond what the daemon inherited.
  const lookupPath = (process.env.PATH || "") +
    ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" +
    `:${process.env.HOME}/.local/bin`
  try {
    const out = execFileSync("/usr/bin/which", [name], { env: { ...process.env, PATH: lookupPath } }).toString().trim()
    BIN_PATH[name] = out || name
  } catch {
    BIN_PATH[name] = name  // fall back to bare name; spawn may still find it
  }
  return BIN_PATH[name]
}

// 15-min default. Real tasks involve multiple tool calls; 5 min is too tight.
// Caller can override per-invocation via timeout_ms.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export function startHarness({ harness, prompt, timeout_ms = DEFAULT_TIMEOUT_MS, log }) {
  if (harness === "none") {
    return runNotification(prompt, log)
  }
  const cmd = harnessCmd(harness, prompt)
  if (!cmd) {
    return {
      pid: null,
      promise: Promise.reject(new Error(`unknown harness: ${harness}`)),
      cancel: () => {},
    }
  }
  log?.(`[harness:${harness}] spawn: ${cmd.bin} ${cmd.args[0]}… (prompt ${prompt.length} chars, timeout ${timeout_ms}ms)`)
  return spawnCapture(cmd.bin, cmd.args, { timeout_ms, log, harness })
}

function harnessCmd(harness, prompt) {
  switch (harness) {
    case "claude":
      // Claude Code: `claude -p` is print-and-exit non-interactive. Without
      // --dangerously-skip-permissions the agent stops at "needs approval"
      // and emits text instead of running tool calls — useless for a daemon.
      return { bin: resolveBin("claude"), args: ["-p", "--dangerously-skip-permissions", prompt] }
    case "codex":
      // Codex: `codex exec` is non-interactive. Approvals + sandbox would
      // block tool calls without a human at the keyboard.
      return { bin: resolveBin("codex"), args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt] }
    case "hermes":
      // Hermes: `-z` is one-shot prompt mode; `--yolo` bypasses approvals.
      return { bin: resolveBin("hermes"), args: ["--yolo", "-z", prompt] }
    default:
      return null
  }
}

// Internal helper used by 'none' harness AND exposed for direct notification calls.
export function showNotification(message, log) {
  const isMac = process.platform === "darwin"
  const cmd = isMac
    ? { bin: "osascript", args: ["-e", `display notification "${escapeApplescript(message)}" with title "Agent Bridge"`] }
    : { bin: "notify-send", args: ["Agent Bridge", message] }
  return spawnCapture(cmd.bin, cmd.args, { timeout_ms: 5000, log, harness: "notify" })
}

function runNotification(prompt, log) {
  const message = prompt.split("\n")[0].slice(0, 180)
  log?.(`[harness:none] notify: ${message}`)
  return showNotification(message, log)
}

function escapeApplescript(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")
}

/**
 * Spawn a process, capture stdout/stderr, expose cancellation.
 * Returns { pid, promise, cancel } — promise resolves with stdout on exit 0,
 * rejects on non-zero or SIGTERM/SIGKILL. cancel() sends SIGTERM, escalating
 * to SIGKILL after 2 seconds.
 */
function spawnCapture(bin, args, { timeout_ms, log, harness }) {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env })
  let stdout = ""
  let stderr = ""
  let killed = false

  const timer = setTimeout(() => {
    log?.(`[harness:${harness}] timeout — killing pid ${child.pid}`)
    cancel()
  }, timeout_ms)

  child.stdout.on("data", (b) => { stdout += b.toString() })
  child.stderr.on("data", (b) => { stderr += b.toString() })

  const promise = new Promise((resolve, reject) => {
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(new Error(`spawn ${bin} failed: ${e.message}`))
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        log?.(`[harness:${harness}] exit 0 (${stdout.length} chars stdout)`)
        resolve(stdout.trim())
      } else {
        log?.(`[harness:${harness}] exit ${code} sig=${signal} stderr=${stderr.slice(0, 300)}`)
        reject(new Error(`${bin} exited ${code}${signal ? " (" + signal + ")" : ""}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`))
      }
    })
  })

  function cancel() {
    if (killed) return
    killed = true
    try { child.kill("SIGTERM") } catch {}
    setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 2000)
  }

  return { pid: child.pid, promise, cancel }
}
