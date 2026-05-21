// `agent-socket channel recv [--wait N]` — read new messages from log.jsonl
// since the cursor. Optionally long-poll up to N seconds.

import fs from "node:fs"
import { PATHS, readInfo } from "./paths.mjs"

export default async function main(argv) {
  let wait = 25
  let onceOnly = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wait") wait = parseInt(argv[++i], 10)
    else if (argv[i] === "--once") onceOnly = true
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("Usage: agent-socket channel recv [--wait SECONDS] [--once]")
      return
    } else { console.error(`channel recv: unknown arg "${argv[i]}"`); process.exit(2) }
  }
  const info = readInfo()
  if (!info) { console.error("channel recv: no running host"); process.exit(1) }

  const ownName = info.name
  const newMsgs = readSinceCursor(ownName)
  if (newMsgs.length > 0) { printMessages(newMsgs); return }

  if (onceOnly || wait <= 0) return

  await tailUntil({ ownName, waitMs: wait * 1000 })
}

function readCursor() {
  try { return parseInt(fs.readFileSync(PATHS.cursor, "utf8"), 10) || 0 }
  catch { return 0 }
}
function writeCursor(seq) { fs.writeFileSync(PATHS.cursor, String(seq)) }

export function readSinceCursor(ownName) {
  const since = readCursor()
  if (!fs.existsSync(PATHS.log)) return []
  const raw = fs.readFileSync(PATHS.log, "utf8")
  if (!raw) return []
  const out = []
  let lastSeq = since
  for (const line of raw.split("\n")) {
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (typeof msg.seq !== "number") continue
    if (msg.seq <= since) continue
    lastSeq = msg.seq
    if (msg.from === ownName) continue   // don't echo own messages back to local user
    out.push(msg)
  }
  if (lastSeq !== since) writeCursor(lastSeq)
  return out
}

export function printMessages(msgs) {
  for (const m of msgs) {
    const tag = m.awaiting ? "*" : " "
    console.log(`[${tag}${m.from}]: ${m.text}`)
  }
}

async function tailUntil({ ownName, waitMs }) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try { watcher?.close() } catch {}
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, waitMs)
    const watcher = fs.watch(PATHS.log, { persistent: false }, () => {
      const fresh = readSinceCursor(ownName)
      if (fresh.length > 0) { printMessages(fresh); finish() }
    })
  })
}
