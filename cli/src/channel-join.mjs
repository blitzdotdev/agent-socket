// `agent-socket channel join <url> [--name N]` — connect to a remote
// channel as a human peer. Reads stdin lines, sends them via /send.
// Polls /recv continuously and prints incoming messages.
//
// No host process, no local files. Just a thin IRC-like client.

import readline from "node:readline"

function parseArgs(argv) {
  const out = { name: null, url: null, wait: 25 }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") out.name = argv[++i]
    else if (argv[i] === "--wait") out.wait = parseInt(argv[++i], 10)
    else if (argv[i] === "-h" || argv[i] === "--help") { out.help = true; break }
    else if (argv[i].startsWith("--")) {
      console.error(`channel join: unknown arg "${argv[i]}"`); process.exit(2)
    } else positional.push(argv[i])
  }
  out.url = positional[0]
  return out
}

const HELP = `agent-socket channel join — connect to a remote channel as a human

Usage:
  agent-socket channel join <url> [--name NAME] [--wait SECONDS]

Args:
  <url>          The channel URL (ends in /agents.md, or the token base).

Options:
  --name N       Your name in the chat. Prompts if omitted.
  --wait N       Long-poll seconds per /recv call (default 25, server-capped).

Once connected:
  - Lines you type become /send messages.
  - Incoming messages print as [name]: text. Asterisk on the name means
    the sender is waiting on a reply right now — answer promptly.
  - Ctrl-C exits.
`

export default async function main(argv) {
  const args = parseArgs(argv)
  if (args.help || !args.url) { console.log(HELP); process.exit(args.url ? 0 : 1) }

  // Normalize URL: accept the agents.md form or the token base.
  let base = args.url.replace(/\/agents\.md$/, "").replace(/\/+$/, "")
  if (!/^https?:\/\//.test(base)) {
    console.error("channel join: url must start with http:// or https://")
    process.exit(2)
  }

  // Name: prompt if not given.
  let name = args.name
  if (!name) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    name = (await new Promise((r) => rl.question("Your name: ", (v) => r(v)))).trim()
    rl.close()
    if (!name) { console.error("channel join: name is required"); process.exit(2) }
  }

  // Sanity check the URL by fetching agents.md.
  try {
    const r = await fetch(`${base}/agents.md`)
    if (r.status !== 200) {
      console.error(`channel join: ${base}/agents.md returned ${r.status}. Check the URL and that the host is up.`)
      process.exit(1)
    }
  } catch (e) {
    console.error(`channel join: failed to reach ${base}: ${e?.message ?? e}`)
    process.exit(1)
  }

  console.log(`\n  Joined as "${name}".`)
  console.log(`  Type to send. Lines are sent as you press Enter.`)
  console.log(`  Asterisk (*name) means the sender is waiting — answer promptly.`)
  console.log(`  Ctrl-C to leave.\n`)

  let cursor = 0
  let running = true

  // Poll loop: long-poll /recv, print messages, repeat. Runs in parallel
  // with the stdin reader.
  const pollLoop = (async () => {
    // First call: no `since`, get scrollback.
    while (running) {
      let body
      if (cursor === 0) body = JSON.stringify({ name, wait: args.wait })
      else            body = JSON.stringify({ name, since: cursor, wait: args.wait })

      let res
      try {
        res = await fetch(`${base}/recv`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      } catch (e) {
        if (!running) return
        printError(`network error: ${e?.message ?? e} — retrying in 3s`)
        await sleep(3000)
        continue
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        if (!running) return
        printError(`/recv → ${res.status}: ${text}`)
        if (res.status === 503) { printError("host appears to be down. exiting."); process.exit(1) }
        await sleep(3000)
        continue
      }
      const j = await res.json().catch(() => null)
      if (!j) { await sleep(500); continue }
      if (Array.isArray(j.messages)) {
        for (const m of j.messages) printMessage(m)
      }
      if (typeof j.latest_seq === "number") cursor = j.latest_seq
      if (typeof j.missed_messages === "number" && j.missed_messages > 0) {
        printSystem(`(skipped ${j.missed_messages} older messages — host's retention window exceeded)`)
      }
    }
  })().catch((e) => { printError(`poll loop crashed: ${e?.message ?? e}`); process.exit(1) })

  // Stdin reader: each line is a /send.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  rl.on("line", async (line) => {
    if (!line.trim()) return
    try {
      const r = await fetch(`${base}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, text: line }),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => "")
        printError(`/send → ${r.status}: ${text}`)
      }
    } catch (e) {
      printError(`/send network error: ${e?.message ?? e}`)
    }
  })

  const shutdown = () => {
    running = false
    rl.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // Hold event loop.
  await pollLoop
}

function printMessage(m) {
  const tag = m.awaiting ? "*" : " "
  process.stdout.write(`[${tag}${m.from}] ${m.text}\n`)
}
function printSystem(s) { process.stdout.write(`# ${s}\n`) }
function printError(s)  { process.stderr.write(`! ${s}\n`) }
function sleep(ms)      { return new Promise((r) => setTimeout(r, ms)) }
