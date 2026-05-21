// `agent-socket channel peers` — synthesize roster from log.jsonl.
// Looks for distinct sender names in the last 5 minutes.

import fs from "node:fs"
import { PATHS, readInfo } from "./paths.mjs"

const WINDOW_MS = 5 * 60 * 1000

export default async function main(_argv) {
  const info = readInfo()
  if (!info) { console.error("channel peers: no running host"); process.exit(1) }
  if (!fs.existsSync(PATHS.log)) { console.log("(no messages yet)"); return }
  const raw = fs.readFileSync(PATHS.log, "utf8")
  const now = Date.now()
  const lastSeen = new Map()
  for (const line of raw.split("\n")) {
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (typeof m.from !== "string" || typeof m.ts !== "number") continue
    if (now - m.ts > WINDOW_MS) continue
    lastSeen.set(m.from, Math.max(lastSeen.get(m.from) ?? 0, m.ts))
  }
  if (lastSeen.size === 0) { console.log("(nobody active in the last 5 min)"); return }
  const rows = [...lastSeen.entries()]
    .map(([name, ts]) => ({ name, ago_s: Math.round((now - ts) / 1000) }))
    .sort((a, b) => a.ago_s - b.ago_s)
  console.log("name              last sent")
  for (const r of rows) console.log(`${r.name.padEnd(18)}${r.ago_s}s ago`)
}
