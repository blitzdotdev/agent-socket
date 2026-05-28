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

  // Restart detection lives in createResilientWatcher (stat-based: inode
  // change OR size decrease). Don't try to detect restarts here from the
  // content; doing so creates a feedback loop (cursor keeps resetting on
  // every read).
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
      handle.close()
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, waitMs)
    const handle = createResilientWatcher({
      ownName,
      persistent: false,
      onMessages: (msgs) => { printMessages(msgs); finish() },
    })
  })
}

/**
 * Watch ~/.agent-socket/current/log.jsonl for new messages. Survives host
 * restart (which `rm -rf`s the channel root and recreates everything with
 * new inodes).
 *
 * Bug history (2026-05-28): the original used a plain `fs.watch(PATHS.log)`
 * bound to the file's inode. When `resetChannelRoot()` ran, the watcher's
 * inode disappeared and it went silent forever. Three subagents reproduced
 * + confirmed this on Linux. A first-pass fix added a parent-dir watcher
 * — that survived ONE restart but died on the SECOND, because the parent
 * dir itself is unlinked and recreated each restart, taking its watcher
 * with it.
 *
 * Final design: fs.watch is best-effort for low-latency wakeups; a 250ms
 * inode-stat poll is the safety net. Each poll, if log.jsonl's inode
 * changed, the host restarted — reset cursor, rearm file watcher, drain.
 * Idempotent: harmless if fs.watch fires too, since drain reads from
 * cursor.
 */
export function createResilientWatcher({ ownName, onMessages, persistent = true, pollIntervalMs = 250 }) {
  let closed = false
  let fileWatcher = null
  let lastInode = null
  let lastSize = 0
  let seenAnyFile = false

  const drain = () => {
    if (closed) return
    const fresh = readSinceCursor(ownName)
    if (fresh.length > 0) {
      try { onMessages(fresh) } catch (e) { console.error("watcher onMessages error:", e?.message ?? e) }
    }
  }

  const armFileWatcher = () => {
    try { fileWatcher?.close() } catch {}
    fileWatcher = null
    if (!fs.existsSync(PATHS.log)) return
    try {
      fileWatcher = fs.watch(PATHS.log, { persistent }, () => drain())
      fileWatcher.on?.("error", () => { /* poll will catch up */ })
    } catch {}
  }

  // Stat-poll. Three signals:
  //   • inode change OR size decrease → host restart → reset cursor + drain
  //   • size grew OR mtime changed    → content appended → drain
  //   • nothing changed               → idle, no work
  // Pure stat-based — no content-based loops, no fs.watch dependence
  // (fs.watch is a fast-path optimization; poll is the source of truth).
  let lastMtimeMs = 0
  const pollOnce = () => {
    if (closed) return
    let stat
    try { stat = fs.statSync(PATHS.log) } catch { return }
    if (!seenAnyFile) {
      seenAnyFile = true
      lastInode = stat.ino
      lastSize = stat.size
      lastMtimeMs = stat.mtimeMs
      if (process.env.AS_DEBUG_WATCHER) console.error("[watcher] first sighting, ino=" + stat.ino)
      armFileWatcher()
      drain()
      return
    }
    const restart = stat.ino !== lastInode || stat.size < lastSize
    const changed = stat.size !== lastSize || stat.mtimeMs !== lastMtimeMs
    if (restart) {
      if (process.env.AS_DEBUG_WATCHER) console.error("[watcher] restart detected, ino " + lastInode + "→" + stat.ino + " size " + lastSize + "→" + stat.size)
      try { fs.writeFileSync(PATHS.cursor, "0") } catch {}
      armFileWatcher()    // rearm even if inode reused — old watcher is dead either way
      drain()
    } else if (changed) {
      drain()
    }
    lastInode = stat.ino
    lastSize = stat.size
    lastMtimeMs = stat.mtimeMs
  }

  pollOnce()
  const pollTimer = setInterval(pollOnce, pollIntervalMs)
  if (!persistent) pollTimer.unref?.()

  return {
    close: () => {
      if (closed) return
      closed = true
      clearInterval(pollTimer)
      try { fileWatcher?.close() } catch {}
    },
  }
}
