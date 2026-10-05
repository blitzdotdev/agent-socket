// Harness entry point. Runs scenarios in numbered order.
//
// Usage:
//   node harness/run.mjs <scenarioId>     # one scenario
//   node harness/run.mjs <range>          # e.g. 10-19
//   node harness/run.mjs all              # all, stop on first failure
//   node harness/run.mjs all --continue   # all, keep going on failures
//
// scenarioId can be the leading number ("01"), the full filename
// ("01-relay-boots"), or a range "10-29".
//
// Without RELAY_URL, boots its own `wrangler dev` (with the vars below) on
// HARNESS_PORT, or a free port, with Durable Object storage in a fresh temp
// dir, and tears it down at the end. HARNESS_INSPECTOR_PORT pins wrangler's
// inspector port. With RELAY_URL, uses that relay.
// A scenario can return { skip: "reason" } to report SKIP.

import { readdirSync, openSync, mkdtempSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import net from "node:net"
import { HarnessFailure } from "./lib/assert.mjs"
import { sliceSince } from "./lib/logs.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCENARIOS_DIR = join(__dirname, "scenarios")
const RELAY_DIR = join(__dirname, "..", "relay")
const WRANGLER_BIN = join(__dirname, "..", "node_modules", ".bin", "wrangler")
// Short timeouts so 28-tool-timeout, 51-app-liveness and the resume-expiry
// scenarios run fast. HEARTBEAT_TIMEOUT_MS stays above workerd's ~10 s idle
// time before it hibernates an object, so 61 can see a liveness alarm wake a
// hibernated session.
const BOOT_VARS = { DEBUG: "1", MAX_SYNC_TOOL_MS: "3000", HEARTBEAT_TIMEOUT_MS: "15000", RESUME_GRACE_MS: "3000" }

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function bootRelay() {
  const port = process.env.HARNESS_PORT ? parseInt(process.env.HARNESS_PORT, 10) : await freePort()
  const log = process.env.WRANGLER_LOG ?? `/tmp/as-harness-wrangler-${port}.log`
  const out = openSync(log, "w")
  const vars = Object.entries(BOOT_VARS).flatMap(([k, v]) => ["--var", `${k}:${v}`])
  // Sessions persist in DO storage; a fresh dir keeps runs independent.
  const state = mkdtempSync(join(tmpdir(), "as-harness-state-"))
  const inspector = process.env.HARNESS_INSPECTOR_PORT ? ["--inspector-port", process.env.HARNESS_INSPECTOR_PORT] : []
  const child = spawn(WRANGLER_BIN, ["dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, ...inspector, ...vars], {
    cwd: RELAY_DIR,
    stdio: ["ignore", out, out],
    detached: true,  // own process group, so teardown also kills workerd
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  const url = `http://127.0.0.1:${port}`
  const stop = () => {
    try { process.kill(-child.pid, "SIGTERM") } catch {}
    try { rmSync(state, { recursive: true, force: true }) } catch {}
  }
  process.on("exit", stop)
  process.on("SIGINT", () => process.exit(130))
  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early; see ${log}`)
    try { if ((await fetch(`${url}/_debug/health`)).ok) break } catch {}
    if (Date.now() > deadline) throw new Error(`wrangler dev not ready after 60 s; see ${log}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  Object.assign(process.env, { RELAY_URL: url, WRANGLER_LOG: log }, BOOT_VARS)
  console.log(`relay: wrangler dev on ${url} (log: ${log})`)
}

function loadScenarios() {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => /^\d{2}-/.test(f))
    .sort()
  return files.map((f) => ({
    file: f,
    id: f.match(/^(\d{2})/)[1],
    fullId: f.replace(/\.mjs$/, ""),
    path: join(SCENARIOS_DIR, f),
  }))
}

function selectScenarios(arg, all) {
  if (arg === "all") return all
  // Range: "10-29"
  const range = arg.match(/^(\d{2})-(\d{2})$/)
  if (range) {
    const lo = range[1], hi = range[2]
    return all.filter((s) => s.id >= lo && s.id <= hi)
  }
  // Exact id ("01") or fullId ("01-relay-boots")
  return all.filter((s) => s.id === arg || s.fullId === arg)
}

async function run(scenario) {
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  let mod
  try {
    mod = await import(scenario.path)
  } catch (e) {
    return { ok: false, scenario, error: e, durationMs: Date.now() - startedAt, startedAtIso }
  }
  if (typeof mod.default !== "function") {
    return {
      ok: false,
      scenario,
      error: new Error("scenario must export a default async function"),
      durationMs: Date.now() - startedAt,
      startedAtIso,
    }
  }
  try {
    const result = await mod.default()
    return { ok: true, scenario, result, durationMs: Date.now() - startedAt, startedAtIso }
  } catch (e) {
    return { ok: false, scenario, error: e, durationMs: Date.now() - startedAt, startedAtIso }
  }
}

function formatPass(s, ms) {
  console.log(`PASS  ${s.fullId.padEnd(28)}  (${(ms / 1000).toFixed(1)}s)`)
}

function formatSkip(s, reason) {
  console.log(`SKIP  ${s.fullId.padEnd(28)}  (${reason})`)
}

function formatFail(r) {
  const ms = r.durationMs
  console.log(`FAIL  ${r.scenario.fullId.padEnd(28)}  (${(ms / 1000).toFixed(1)}s)`)
  const e = r.error
  if (e instanceof HarnessFailure) {
    console.log(`  step: ${e.stepName}`)
    if (e.extra && Object.keys(e.extra).length) {
      for (const [k, v] of Object.entries(e.extra)) {
        const formatted = typeof v === "string" ? v : JSON.stringify(v, null, 2)
        console.log(`  ${k}: ${formatted}`)
      }
    }
  } else {
    console.log(`  error: ${e?.message ?? e}`)
    if (e?.stack) {
      const lines = e.stack.split("\n").slice(1, 6)
      for (const l of lines) console.log(`    ${l}`)
    }
  }
  // Wrangler log slice
  const slice = sliceSince(r.startedAtIso)
  if (slice.length) {
    console.log(`  wrangler.log (since scenario start):`)
    for (const l of slice.slice(-12)) console.log(`    ${l}`)
  }
}

async function main() {
  const arg = process.argv[2] ?? "all"
  const continueFlag = process.argv.includes("--continue")
  const all = loadScenarios()
  const selected = selectScenarios(arg, all)

  if (selected.length === 0) {
    console.error(`No scenarios match: ${arg}`)
    console.error(`Available: ${all.map((s) => s.fullId).join(", ")}`)
    process.exit(2)
  }

  if (!process.env.RELAY_URL) await bootRelay()

  let passed = 0, failed = 0, skipped = 0
  let firstFailureIdx = -1
  const totalStart = Date.now()

  for (let i = 0; i < selected.length; i++) {
    const s = selected[i]
    if (firstFailureIdx >= 0 && !continueFlag) {
      console.log(`SKIP  ${s.fullId.padEnd(28)}  (dependency)`)
      skipped++
      continue
    }
    const r = await run(s)
    if (r.ok && r.result?.skip) {
      formatSkip(s, r.result.skip)
      skipped++
    } else if (r.ok) {
      formatPass(s, r.durationMs)
      passed++
    } else {
      formatFail(r)
      failed++
      if (firstFailureIdx < 0) firstFailureIdx = i
    }
  }

  const totalMs = Date.now() - totalStart
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped in ${(totalMs / 1000).toFixed(1)}s`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
