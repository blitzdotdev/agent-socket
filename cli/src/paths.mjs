// Resolve and provision ~/.agent-socket/current/ for the channel CLI.

import os from "node:os"
import path from "node:path"
import fs from "node:fs"

export const CHANNEL_ROOT = path.join(os.homedir(), ".agent-socket", "current")

export const PATHS = {
  root: CHANNEL_ROOT,
  log: path.join(CHANNEL_ROOT, "log.jsonl"),
  outbox: path.join(CHANNEL_ROOT, "outbox"),
  cursor: path.join(CHANNEL_ROOT, "cursor"),
  info: path.join(CHANNEL_ROOT, "info.json"),
}

/** Wipe + recreate the channel root. Called by `channel host` on start. */
export function resetChannelRoot() {
  fs.rmSync(CHANNEL_ROOT, { recursive: true, force: true })
  fs.mkdirSync(PATHS.outbox, { recursive: true })
  fs.writeFileSync(PATHS.log, "")
  fs.writeFileSync(PATHS.cursor, "0")
}

/** Read info.json or null if no host is running. */
export function readInfo() {
  try { return JSON.parse(fs.readFileSync(PATHS.info, "utf8")) }
  catch { return null }
}
