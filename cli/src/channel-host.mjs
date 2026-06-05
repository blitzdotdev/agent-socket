// `agent-socket channel host` — connects to a relay as an app, mints one
// shared token for the chat, prints the URL. Watches outbox/ for messages
// from the local CLI. Mirrors all messages to log.jsonl for local recv.

import { connect } from "@agent-socket/sdk"
import fs from "node:fs"
import { PATHS, resetChannelRoot } from "./paths.mjs"
import { createChannelTools } from "./channel-core.mjs"
import { renderJoinScript } from "./join-sh-template.mjs"

const DEFAULT_WAIT_CAP_MS = 25_000
const DEFAULT_RELAY = process.env.AGENT_SOCKET_RELAY ?? "http://localhost:8787"

function parseArgs(argv) {
  const out = {
    name: process.env.USER ?? process.env.LOGNAME ?? "host",
    relay: DEFAULT_RELAY,
    waitCapMs: DEFAULT_WAIT_CAP_MS,
    quietCapMs: null,   // null = inherit waitCapMs
    publicBase: null,   // null = use relay-side base (info.url's origin)
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") out.name = argv[++i]
    else if (argv[i] === "--relay") out.relay = argv[++i]
    else if (argv[i] === "--wait-cap-ms") out.waitCapMs = parseInt(argv[++i], 10)
    else if (argv[i] === "--quiet-wait-cap-ms") out.quietCapMs = parseInt(argv[++i], 10)
    else if (argv[i] === "--public-base") out.publicBase = argv[++i].replace(/\/+$/, "")
    else if (argv[i] === "-h" || argv[i] === "--help") { out.help = true; break }
    else { console.error(`channel host: unknown arg "${argv[i]}"`); process.exit(2) }
  }
  if (!Number.isFinite(out.waitCapMs) || out.waitCapMs < 100) {
    console.error("channel host: --wait-cap-ms must be a positive integer >= 100"); process.exit(2)
  }
  if (out.quietCapMs == null) out.quietCapMs = out.waitCapMs
  if (!Number.isFinite(out.quietCapMs) || out.quietCapMs < out.waitCapMs) {
    console.error(`channel host: --quiet-wait-cap-ms must be >= --wait-cap-ms (${out.waitCapMs})`); process.exit(2)
  }
  return out
}

const HELP = `agent-socket channel host — start a chat host

Usage:
  agent-socket channel host [--name N] [--relay URL] [--wait-cap-ms MS]

Options:
  --name N                  host's own name in the chat (default: \$USER or "host")
  --relay URL               relay base URL (default: \$AGENT_SOCKET_RELAY or http://localhost:8787)
  --wait-cap-ms MS          max ms for /recv long-polls during active state (default 25000).
                            Must fit under the relay's MAX_SYNC_TOOL_MS.
  --quiet-wait-cap-ms MS    max ms for /recv when channel is quiet (no message in
                            last 30s AND no peer in an open long-poll). Lets idle
                            peers sit longer without spamming the host with retries.
                            Must be >= --wait-cap-ms. Default: inherits --wait-cap-ms.
  --public-base URL         public base URL that maps to the relay's root, used to
                            construct share-URLs (paste-link + curl|bash one-liner).
                            e.g. --public-base https://anontun-v0.you.workers.dev/t/ABC
                            Default: use --relay (local-only — friends can't reach).
`

export default async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) { console.log(HELP); return }

  resetChannelRoot()
  const logFd = fs.openSync(PATHS.log, "a")
  const persist = (msg) => fs.writeSync(logFd, JSON.stringify(msg) + "\n")

  const { store, tools, agentsMd } = createChannelTools({
    waitCapMs: args.waitCapMs,
    quietCapMs: args.quietCapMs,
    onAppend: persist,
  })

  // Defer rendering the join script until after token mint so we can bake
  // the full public URL into it.
  // Tool registered now; handler closes over `joinScript` set after mint.
  let joinScript = ""
  tools.push({
    method: "GET",
    path: "/join.sh",
    description: "Returns a bash client script. Friend joins via `bash <(curl -s URL/join.sh) \"\" \"<name>\"`.",
    handler: async () => ({
      status: 200,
      headers: { "content-type": "text/x-shellscript" },
      body: joinScript,
    }),
  })

  // Watch outbox/ for files dropped by the local `channel send` command.
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
  ingestOutbox()  // drain anything stale before fs.watch attaches
  fs.watch(PATHS.outbox, { persistent: true }, ingestOutbox)

  let session
  try {
    session = await connect({
      appId: "as_app_anon",
      baseUrl: args.relay,
      appDescription: "agent-socket channel — multi-participant chat for AIs and humans.",
      agentsMd,
      tools,
    })
  } catch (err) {
    console.error(`channel host: failed to connect to relay at ${args.relay}: ${err?.message ?? err}`)
    process.exit(1)
  }

  const link = await session.mintAgentToken({ label: "channel-public" })

  // Resolve the public token URL — used for the share-link banner AND
  // baked into the served join.sh script. If --public-base is set, use
  // it; otherwise fall back to the relay-side URL (only reachable locally).
  const relayBase = args.relay.replace(/\/+$/, "")
  const tokenPath = link.url.replace(/^https?:\/\/[^/]+/, "").replace(/\/agents\.md$/, "")
  const publicTokenUrl = args.publicBase
    ? `${args.publicBase}${tokenPath}`
    : link.url.replace(/\/agents\.md$/, "")

  // Now render the join script with the URL baked in.
  joinScript = renderJoinScript({ bakedUrl: publicTokenUrl })

  const info = {
    name: args.name,
    url: link.url,
    publicTokenUrl,
    token: link.token,
    sessionId: session.sessionId,
    relay: args.relay,
    started_at: new Date().toISOString(),
    pid: process.pid,
  }
  fs.writeFileSync(PATHS.info, JSON.stringify(info, null, 2))

  printBanner(info, args.publicBase)

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

  setInterval(() => {}, 1 << 30)  // hold event loop alive
}

function printBanner(info, publicBase) {
  const userPart = info.name ? ` as "${info.name}"` : ""
  // info.publicTokenUrl was resolved (either from --public-base or local).
  const shareBase = info.publicTokenUrl
  console.log()
  console.log(`  agent-socket channel host${userPart}`)
  console.log(`  session: ${info.sessionId}`)
  console.log()
  console.log("  Share — paste into an AI chat:")
  console.log()
  console.log(`    You're in a chat with others. Pick a name (e.g. "claude"),`)
  console.log(`    then poll ${shareBase}/agents.md for the protocol.`)
  console.log()
  console.log("  Share — for a human friend (CLI, zero install, needs bash + curl):")
  console.log()
  console.log(`    bash <(curl -s ${shareBase}/join.sh) "" "<your-name>"`)
  console.log()
  console.log("  (Process substitution preserves the friend's terminal stdin so they")
  console.log("   can actually type. The simpler-looking `curl | bash` pattern")
  console.log("   doesn't work — bash consumes stdin for the script itself.)")
  console.log()
  if (!publicBase) {
    console.log("  (tip: pass --public-base <YOUR-TUNNEL-BASE> at startup so the")
    console.log("   share URLs above embed your public host instead of localhost.")
    console.log("   e.g. --public-base https://anontun-v0.YOURNAME.workers.dev/t/XYZ)")
    console.log()
  }
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
