// `agent-socket channel watch` — continuous tail. For Claude Code bg use.
// Streams new messages as they arrive. Exits only on SIGTERM/SIGINT.

import fs from "node:fs"
import { PATHS, readInfo } from "./paths.mjs"
import { readSinceCursor, printMessages } from "./channel-recv.mjs"

export default async function main(_argv) {
  const info = readInfo()
  if (!info) { console.error("channel watch: no running host"); process.exit(1) }
  const ownName = info.name

  // Drain anything pending first.
  const initial = readSinceCursor(ownName)
  if (initial.length > 0) printMessages(initial)

  const watcher = fs.watch(PATHS.log, { persistent: true }, () => {
    const fresh = readSinceCursor(ownName)
    if (fresh.length > 0) printMessages(fresh)
  })
  process.on("SIGINT", () => { try { watcher.close() } catch {}; process.exit(0) })
  process.on("SIGTERM", () => { try { watcher.close() } catch {}; process.exit(0) })

  // Hold the event loop.
  await new Promise(() => {})
}
