// `agent-socket channel stop` — SIGTERM the running host process by pid.

import { readInfo } from "./paths.mjs"

export default async function main(_argv) {
  const info = readInfo()
  if (!info) { console.error("channel stop: no running host (no info.json)"); process.exit(1) }
  try {
    process.kill(info.pid, "SIGTERM")
    console.log(`Sent SIGTERM to host pid ${info.pid}.`)
  } catch (err) {
    console.error(`channel stop: kill failed: ${err.message}`)
    process.exit(1)
  }
}
