// `agent-socket channel send <text> [--name N]` — drop a message file
// into outbox/ for the host process to pick up.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { PATHS, readInfo } from "./paths.mjs"

export default async function main(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log("Usage: agent-socket channel send <text> [--name NAME]")
    process.exit(argv.length === 0 ? 2 : 0)
  }
  let name = null
  const textParts = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i]
    else textParts.push(argv[i])
  }
  const text = textParts.join(" ")
  if (!text) { console.error("channel send: empty text"); process.exit(2) }

  const info = readInfo()
  if (!info) {
    console.error("channel send: no running host (no info.json). Start one with `agent-socket channel host`.")
    process.exit(1)
  }
  if (!name) name = info.name

  const id = crypto.randomBytes(8).toString("hex")
  const filename = path.join(PATHS.outbox, `${Date.now()}-${id}.json`)
  fs.writeFileSync(filename, JSON.stringify({ name, text }))
  // Host process picks it up and ingests.
}
