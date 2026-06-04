// agent-bridge — per-user Node process that exposes the local AI harness as
// agent-socket tools. One bridge serves N Blitz campaigns: on every session
// change (initial connect + reconnect after relay DO cycles) the bridge PUTs
// the freshly-minted URL into each campaign's bot_config.agent_bridge_url.
//
// Run:   node index.mjs
// Or:    npm start
// Or:    install as launchd service (see scripts/install-launchd.sh)

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "@agent-socket/sdk"
import { buildTools } from "./tools.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, "config.json")
const CAMPAIGNS_PATH = path.join(__dirname, "campaigns.json")
const LOG_TS = () => new Date().toISOString()

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback
  try { return JSON.parse(fs.readFileSync(p, "utf8")) }
  catch (e) {
    log("err", `failed to parse ${p}: ${e.message}`)
    return fallback
  }
}

const config = loadJson(CONFIG_PATH, {})
let campaigns = loadJson(CAMPAIGNS_PATH, [])

const HARNESS = config.harness || "claude"
const BASE_URL = config.base_url || "https://aisocket.dev"  // Min's existing relay; SDK default is agentsocket.dev
const APP_ID = config.app_id || "as_app_anon"
const LOG_PATH = config.log_path
  ? config.log_path.replace(/^~\//, process.env.HOME + "/")
  : path.join(process.env.HOME, "Library/Logs/agent-bridge.log")

// Ensure log dir exists.
try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }) } catch {}
function log(level, msg) {
  const line = `${LOG_TS()} [${level}] ${msg}\n`
  process.stdout.write(line)
  try { fs.appendFileSync(LOG_PATH, line) } catch {}
}
const toolLog = (m) => log("tool", m)

// ──────────────────────────────────────────────────────────────────
// URL fanout — push the freshly minted bridge URL into every campaign.
// TODO: why every? any risk of this invalidates existing session of old campaign
// ──────────────────────────────────────────────────────────────────

async function fanoutBridgeUrl(url) {
  if (!campaigns || campaigns.length === 0) {
    log("warn", "no campaigns in campaigns.json — bridge URL not fanned out")
    return
  }
  const results = await Promise.all(campaigns.map(async (c) => {
    if (!c.endpoint || !c.api_token) return { slug: c.slug, ok: false, reason: "missing endpoint/api_token" }
    try {
      const r = await fetch(`${c.endpoint}/api/bot-config/agent_bridge_url`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${c.api_token}`,
        },
        body: JSON.stringify({ value: url }),
      })
      if (!r.ok) return { slug: c.slug, ok: false, status: r.status, body: (await r.text()).slice(0, 200) }
      return { slug: c.slug, ok: true }
    } catch (e) {
      return { slug: c.slug, ok: false, error: e.message }
    }
  }))
  for (const r of results) {
    if (r.ok) log("info", `bot_config.agent_bridge_url updated for ${r.slug}`)
    else log("warn", `fanout failed for ${r.slug}: ${JSON.stringify(r)}`)
  }
}

// ──────────────────────────────────────────────────────────────────
// Connect + lifetime
// ──────────────────────────────────────────────────────────────────

const tools = buildTools({ harness: HARNESS, log: toolLog })
log("info", `harness=${HARNESS} base_url=${BASE_URL} campaigns=${campaigns.length} tools=${tools.length}`)

// Generic briefing — bridge holds zero campaign knowledge. Callers (Blitz
// apps, scripts, whatever) construct the prompt and pass it through /run.
const agentsMd = [
  `# Agent Bridge`,
  ``,
  `A remote-process executor on a user's machine. Configured local AI harness: \`${HARNESS}\`.`,
  ``,
  `Whatever you POST to /run becomes the spawned harness's prompt verbatim.`,
  `The bridge has no opinions about what work happens — that's entirely in your prompt.`,
  `Any URLs, tokens, instructions, and context the agent needs to do its job must be embedded in the prompt itself.`,
  ``,
  `## Tools`,
  ``,
  tools.map(t => `- \`${t.method || "POST"} ${t.path}\` — ${t.description}`).join("\n\n"),
  ``,
  `## Notes`,
  ``,
  `- /run is accept-and-detach: returns immediately with a run_id; the harness runs in the background.`,
  `- If you want the harness's result delivered somewhere, instruct the agent (in your prompt) to POST it back to your endpoint.`,
  `- Cancel a long-running invocation with POST /cancel { run_id }.`,
].join("\n")

const session = await connect({
  appId: APP_ID,
  baseUrl: BASE_URL,
  agentsMd,
  appDescription: "Outreach bridge — real-time agent triggers for Blitz campaigns.",
  tools,
  autoReconnect: true,
  onDisconnect: ({ reason, attempt, reconnect }) => {
    log("warn", `disconnected: ${reason} (attempt ${attempt}) — will retry`)
    setTimeout(reconnect, Math.min(60000, 1000 * Math.pow(2, attempt)))
  },
  onSessionChanged: async ({ sessionId, tokensRemapped }) => {
    log("info", `session changed → ${sessionId}; ${tokensRemapped.length} tokens remapped`)
    const fresh = tokensRemapped.find((t) => t.label === "outreach-bridge")
    if (fresh) await fanoutBridgeUrl(fresh.newUrl)
  },
})
log("info", `connected; sessionId=${session.sessionId}`)

const link = await session.mintAgentToken({ label: "outreach-bridge" })
log("info", `minted bridge URL: ${link.url}`)
await fanoutBridgeUrl(link.url)

// Keep alive until SIGTERM.
function shutdown() {
  log("info", "shutting down")
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
