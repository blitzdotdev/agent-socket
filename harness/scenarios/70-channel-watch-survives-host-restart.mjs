// 70-channel-watch-survives-host-restart — `agent-socket channel watch`
// keeps emitting messages after the host process is killed + restarted
// (which `rm -rf`'s ~/.agent-socket/current/ and recreates everything).
//
// Bug fixed in `createResilientWatcher` (2026-05-28): plain fs.watch on
// log.jsonl binds to the inode and goes silent after `rm + recreate`.
// Fix uses stat-polling (inode change OR size decrease) to detect restart,
// rearm the file watcher, and reset the cursor.
//
// This scenario spawns REAL host + watch processes via child_process so it
// exercises the fs path that the unit-y in-process scenarios can't.

import { Assert } from "../lib/assert.mjs"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")
const CLI_BIN = path.join(REPO_ROOT, "cli/bin/agent-socket.mjs")
const INFO_PATH = path.join(os.homedir(), ".agent-socket/current/info.json")
const RELAY_URL = process.env.RELAY_URL ?? "http://localhost:8787"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForInfoJson(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const txt = fs.readFileSync(INFO_PATH, "utf8")
      const j = JSON.parse(txt)
      if (j.publicTokenUrl) return j.publicTokenUrl.replace(/\/agents\.md$/, "")
    } catch {}
    await sleep(100)
  }
  throw new Error(`info.json never appeared at ${INFO_PATH}`)
}

async function waitForInfoGone(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(INFO_PATH)) return
    await sleep(80)
  }
}

function startHost() {
  const child = spawn("node", [CLI_BIN, "channel", "host",
    "--name", "watchtester",
    "--relay", RELAY_URL,
    "--wait-cap-ms", "2500",
    "--quiet-wait-cap-ms", "2500",
  ], { stdio: ["ignore", "ignore", "ignore"], detached: false })
  return child
}

async function sendMsg(urlBase, text) {
  const r = await fetch(`${urlBase}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "stranger", text }),
  })
  if (!r.ok) throw new Error(`/send failed: ${r.status} ${await r.text()}`)
}

export default async function () {
  const a = new Assert("70-channel-watch-survives-host-restart")

  // Wipe any stale state.
  try { fs.rmSync(path.join(os.homedir(), ".agent-socket/current"), { recursive: true, force: true }) } catch {}

  // Host 1
  let host = startHost()
  let urlBase = await waitForInfoJson()

  // Watch — captures stdout to memory
  const watch = spawn("node", [CLI_BIN, "channel", "watch"], { stdio: ["ignore", "pipe", "ignore"] })
  const watchLines = []
  watch.stdout.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) if (line) watchLines.push(line)
  })
  await sleep(800)  // let the watcher's initial poll settle

  // Pre-restart probe — watch SHOULD see it
  await sendMsg(urlBase, "before-restart")
  await sleep(800)
  a.ok(watchLines.some((l) => l.includes("before-restart")),
    "pre-restart message reached watch",
    { lines: watchLines })

  // Restart host (this triggers resetChannelRoot)
  host.kill("SIGTERM")
  await waitForInfoGone()
  host = startHost()
  urlBase = await waitForInfoJson()

  // Post-restart probe — this is the actual regression-bug case
  await sendMsg(urlBase, "after-restart-1")
  await sleep(800)
  a.ok(watchLines.some((l) => l.includes("after-restart-1")),
    "watch survived host restart and received post-restart message",
    { lines: watchLines })

  // One more restart — multi-restart resilience
  host.kill("SIGTERM")
  await waitForInfoGone()
  host = startHost()
  urlBase = await waitForInfoJson()
  await sendMsg(urlBase, "after-restart-2")
  await sleep(800)
  a.ok(watchLines.some((l) => l.includes("after-restart-2")),
    "watch survived a second consecutive host restart",
    { lines: watchLines })

  // No duplicates — each emitted message appears exactly once
  const emitted = watchLines.filter((l) => /\[ stranger\]/.test(l))
  const seen = new Set()
  let duplicates = 0
  for (const l of emitted) { if (seen.has(l)) duplicates++; seen.add(l) }
  a.equal(duplicates, 0, "no duplicate emissions", { emitted })

  // Cleanup
  try { watch.kill("SIGTERM") } catch {}
  try { host.kill("SIGTERM") } catch {}
  await waitForInfoGone()
}
