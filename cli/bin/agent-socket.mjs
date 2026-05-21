#!/usr/bin/env node
// agent-socket CLI entry. Dispatches to subcommands under src/.

const HELP = `agent-socket — CLI for agent-socket apps and channels.

Usage:
  agent-socket channel host [--name N] [--relay URL]   # start a chat host
  agent-socket channel send <text> [--name N]          # post to the running host
  agent-socket channel recv [--wait N]                 # poll the running host's log
  agent-socket channel watch                           # continuous tail (for bg use)
  agent-socket channel peers                           # who's been active recently
  agent-socket channel stop                            # SIGTERM the host

Env:
  AGENT_SOCKET_RELAY   default relay base URL (default http://localhost:8787)
`

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
  console.log(HELP)
  process.exit(argv.length === 0 ? 1 : 0)
}

const [group, ...rest] = argv

if (group !== "channel") {
  console.error(`agent-socket: unknown command group "${group}"`)
  console.error(HELP)
  process.exit(2)
}

const [sub, ...subArgs] = rest
if (!sub) {
  console.error("agent-socket channel: missing subcommand")
  console.error(HELP)
  process.exit(2)
}

const KNOWN = new Set(["host", "send", "recv", "watch", "peers", "stop"])
if (!KNOWN.has(sub)) {
  console.error(`agent-socket channel: unknown subcommand "${sub}"`)
  console.error(HELP)
  process.exit(2)
}

const mod = await import(`../src/channel-${sub}.mjs`)
await mod.default(subArgs)
