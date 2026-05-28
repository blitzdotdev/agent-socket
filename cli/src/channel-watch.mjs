// `agent-socket channel watch` — continuous tail. For Claude Code bg use.
// Streams new messages as they arrive. Survives host restart (unlink +
// recreate of log.jsonl via parent-directory rename events; see
// createResilientWatcher in channel-recv.mjs).

import { readInfo } from "./paths.mjs"
import { readSinceCursor, printMessages, createResilientWatcher } from "./channel-recv.mjs"

export default async function main(_argv) {
  const info = readInfo()
  if (!info) { console.error("channel watch: no running host"); process.exit(1) }
  const ownName = info.name

  // Drain anything pending first.
  const initial = readSinceCursor(ownName)
  if (initial.length > 0) printMessages(initial)

  const handle = createResilientWatcher({
    ownName,
    persistent: true,
    onMessages: printMessages,
  })

  process.on("SIGINT",  () => { handle.close(); process.exit(0) })
  process.on("SIGTERM", () => { handle.close(); process.exit(0) })

  // Hold the event loop.
  await new Promise(() => {})
}
