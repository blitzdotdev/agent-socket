// `agent-socket channel host` — connects to a relay as an app, mints one
// shared token for the chat, prints the URL.
//
// Phase 1: tools stubbed (echo only). Subsequent phases wire up real
// send/recv handlers backed by an in-memory log.

import { connect } from "@agent-socket/sdk"
import fs from "node:fs"
import os from "node:os"
import { PATHS, resetChannelRoot } from "./paths.mjs"
import { LogStore } from "./log-store.mjs"
import { buildAgentsMd } from "./agents-md.mjs"

const DEFAULT_WAIT_CAP_MS = 25_000
const MAX_TEXT_BYTES = 64 * 1024

const DEFAULT_RELAY = process.env.AGENT_SOCKET_RELAY ?? "http://localhost:8787"

function parseArgs(argv) {
  const out = {
    name: process.env.USER ?? process.env.LOGNAME ?? "host",
    relay: DEFAULT_RELAY,
    waitCapMs: DEFAULT_WAIT_CAP_MS,
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") out.name = argv[++i]
    else if (argv[i] === "--relay") out.relay = argv[++i]
    else if (argv[i] === "--wait-cap-ms") out.waitCapMs = parseInt(argv[++i], 10)
    else if (argv[i] === "-h" || argv[i] === "--help") { out.help = true; break }
    else { console.error(`channel host: unknown arg "${argv[i]}"`); process.exit(2) }
  }
  if (!Number.isFinite(out.waitCapMs) || out.waitCapMs < 100) {
    console.error("channel host: --wait-cap-ms must be a positive integer >= 100"); process.exit(2)
  }
  return out
}

const HELP = `agent-socket channel host — start a chat host

Usage:
  agent-socket channel host [--name N] [--relay URL]

Options:
  --name N      host's own name in the chat (default: \$USER or "host")
  --relay URL   relay base URL (default: \$AGENT_SOCKET_RELAY or http://localhost:8787)
`

export default async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) { console.log(HELP); return }

  resetChannelRoot()

  const store = new LogStore()
  const logFd = fs.openSync(PATHS.log, "a")
  const appendToLog = (msg) => {
    fs.writeSync(logFd, JSON.stringify(msg) + "\n")
  }

  // Hook the store's append to also persist to log.jsonl. Wrapping
  // append() lets us write-through without LogStore knowing about fs.
  const storeAppend = store.append.bind(store)
  store.append = (rec) => {
    const msg = storeAppend(rec)
    appendToLog(msg)
    return msg
  }

  const handleSend = async ({ body }) => {
    let p = {}
    try { p = JSON.parse(body || "{}") } catch {}
    if (typeof p.name !== "string" || !p.name.trim()) return err400("bad_input", "name is required")
    if (typeof p.text !== "string") return err400("bad_input", "text is required")
    if (Buffer.byteLength(p.text, "utf8") > MAX_TEXT_BYTES) return err400("message_too_large", `text > ${MAX_TEXT_BYTES} bytes`)
    const before = countActiveWaiters(store, p.name)
    const msg = store.append({ from: p.name, text: p.text })
    return { ok: true, seq: msg.seq, delivered_to_active: before }
  }

  const handleRecv = async ({ body }) => {
    let p = {}
    try { p = JSON.parse(body || "{}") } catch {}
    const name = typeof p.name === "string" && p.name.trim() ? p.name : null
    const since = Number.isFinite(p.since) ? p.since : null
    const wait = clampWait(p.wait, args.waitCapMs)
    const message = typeof p.message === "string" && p.message.length > 0 ? p.message : null

    if (message != null && !name) return err400("bad_input", "name is required when sending a message via /recv")
    if (message != null && Buffer.byteLength(message, "utf8") > MAX_TEXT_BYTES) return err400("message_too_large", `message > ${MAX_TEXT_BYTES} bytes`)

    // Reserve the wait slot FIRST so that any broadcast we do below
    // shows awaiting:true to recipients (our recv is already registered
    // as a waiter).
    const waitHandle = wait > 0 ? store.wait({ name, maxMs: wait }) : null

    // Broadcast the optional message. wakeWaiters will see this sender
    // as a waiter (from above), so recipients receive awaiting:true.
    if (message != null) store.append({ from: name, text: message })

    if (name) store.touch(name)

    // First call: scrollback (no since param). Cancel the wait.
    if (since === null) {
      if (waitHandle) waitHandle.cancel()
      const { messages, latest_seq } = store.scrollback(name)
      return { messages, latest_seq }
    }

    // Resume: try to drain immediately. If we have messages or no wait, return.
    const drained = store.drain({ since, senderName: name })
    if (drained.messages.length > 0 || wait <= 0) {
      if (waitHandle) waitHandle.cancel()
      return drained
    }

    // Block on the pre-reserved wait until messages arrive or timeout.
    const messages = await waitHandle.promise
    return { messages, latest_seq: store.nextSeq - 1 }
  }

  const handlePeers = async () => store.peers()

  // Watch outbox/ for files dropped by the local `channel send` command.
  // Each file is one outgoing message. After ingest, delete it.
  const ingestOutbox = () => {
    for (const file of fs.readdirSync(PATHS.outbox)) {
      const full = `${PATHS.outbox}/${file}`
      let parsed
      try { parsed = JSON.parse(fs.readFileSync(full, "utf8")) }
      catch { try { fs.unlinkSync(full) } catch {}; continue }
      try { fs.unlinkSync(full) } catch {}
      if (typeof parsed.name === "string" && typeof parsed.text === "string") {
        try { store.append({ from: parsed.name, text: parsed.text }) }
        catch (e) { console.error(`outbox ingest skipped: ${e?.message ?? e}`) }
      }
    }
  }
  ingestOutbox()  // drain anything left from before (shouldn't happen since we wiped, but defensive)
  fs.watch(PATHS.outbox, { persistent: true }, ingestOutbox)

  let session
  try {
    session = await connect({
      appId: "as_app_anon",
      baseUrl: args.relay,
      appDescription: "agent-socket channel — multi-participant chat for AIs and humans.",
      agentsMd: buildAgentsMd(),
      tools: [
        { path: "/send",  description: "Broadcast a message. Fire-and-forget.", handler: handleSend },
        { path: "/recv",  description: "Long-poll for new messages, optionally broadcast first.", handler: handleRecv },
        { path: "/peers", description: "Roster of recently-active participants.", handler: handlePeers },
      ],
    })
  } catch (err) {
    console.error(`channel host: failed to connect to relay at ${args.relay}: ${err?.message ?? err}`)
    process.exit(1)
  }

  const link = await session.mintAgentToken({ label: "channel-public" })

  const info = {
    name: args.name,
    url: link.url,
    token: link.token,
    sessionId: session.sessionId,
    relay: args.relay,
    started_at: new Date().toISOString(),
    pid: process.pid,
  }
  fs.writeFileSync(PATHS.info, JSON.stringify(info, null, 2))

  printBanner(info)

  // Trap SIGINT/SIGTERM for clean shutdown.
  let stopping = false
  const stop = (signal) => {
    if (stopping) return
    stopping = true
    console.log(`\n(${signal} — closing host)`)
    session.close()
    try { fs.unlinkSync(PATHS.info) } catch {}
    process.exit(0)
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))

  // Keep the process alive. The SDK's WS keeps a ref alive; this is belt+suspenders.
  setInterval(() => {}, 1 << 30)
}

function err400(code, message) {
  return { status: 400, body: { error: { code, message } } }
}

function clampWait(w, capMs) {
  if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return 0
  return Math.min(w * 1000, capMs)
}

function countActiveWaiters(store, excludeName) {
  let n = 0
  for (const [name, list] of store.waiters) {
    if (name === excludeName) continue
    n += list.length
  }
  return n
}

function printBanner(info) {
  const userPart = info.name ? ` as "${info.name}"` : ""
  console.log()
  console.log(`  agent-socket channel host${userPart}`)
  console.log(`  session: ${info.sessionId}`)
  console.log()
  console.log("  Paste this into any AI chat:")
  console.log()
  console.log(`    You're in a chat with others. Pick a name (e.g. "claude"),`)
  console.log(`    then poll ${info.url} for the protocol.`)
  console.log()
  console.log("  Local commands:")
  console.log("    agent-socket channel send \"<text>\"")
  console.log("    agent-socket channel recv [--wait 25]")
  console.log("    agent-socket channel watch")
  console.log("    agent-socket channel peers")
  console.log("    agent-socket channel stop      (or Ctrl-C)")
  console.log()
  console.log(`  Log: ${PATHS.log}`)
  console.log()
}
