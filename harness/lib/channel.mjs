// Harness helper: programmatically start an agent-socket channel host
// (no child process, no ~/.agent-socket/ files), register the channel
// tools via the SDK, mint one token, return URL + handle.

import { connect } from "@agent-socket/sdk"
import { createChannelTools } from "@agent-socket/cli/src/channel-core.mjs"
import { RELAY_HTTP } from "./relay.mjs"

const SCENARIO_WAIT_CAP_MS = 2500   // under relay dev MAX_SYNC_TOOL_MS=3000

/**
 * Start a channel host bound to the harness's wrangler-dev relay.
 *
 * @param {object} [opts]
 * @param {number} [opts.waitCapMs] override wait cap (default 2500)
 * @returns {{ session, store, tokenBase, agentsMdUrl, stop }}
 *   session     — the SDK session
 *   store       — the LogStore (for whitebox assertions if needed)
 *   tokenBase   — `${RELAY_HTTP}/v1/t/<token>` (no trailing slash, no path)
 *   agentsMdUrl — `${tokenBase}/agents.md`
 *   stop()      — closes the session
 */
export async function startChannelHost(opts = {}) {
  const { store, tools, agentsMd } = createChannelTools({
    waitCapMs: opts.waitCapMs ?? SCENARIO_WAIT_CAP_MS,
    quietCapMs: opts.quietCapMs,
    quietThresholdMs: opts.quietThresholdMs,
  })
  const session = await connect({
    appId: "as_app_anon",
    baseUrl: RELAY_HTTP,
    appDescription: "agent-socket channel — harness fixture",
    agentsMd,
    tools,
    autoReconnect: false,
  })
  const link = await session.mintAgentToken({ label: "scenario-channel" })
  // link.url ends with /agents.md; strip it to get the tool base.
  const tokenBase = link.url.replace(/\/agents\.md$/, "")
  return {
    session,
    store,
    tokenBase,
    agentsMdUrl: link.url,
    stop: () => session.close(),
  }
}
