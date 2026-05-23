// Pure channel logic — LogStore wiring + /send + /recv + /peers handlers.
// Used by:
//   - channel-host.mjs (CLI: wraps with banner, file persistence, outbox)
//   - harness scenarios (instantiate handlers directly, drive via HTTP)
//
// No I/O, no SDK calls. Caller wires it into `connect({...})` from the SDK.

import { LogStore } from "./log-store.mjs"
import { buildAgentsMd } from "./agents-md.mjs"

const DEFAULT_WAIT_CAP_MS  = 25_000      // active state: max wait honored
const DEFAULT_QUIET_CAP_MS = 25_000      // quiet state: same as active by default
const QUIET_THRESHOLD_MS   = 30_000      // no message + no waiter for this long → quiet
const MAX_TEXT_BYTES = 64 * 1024

export function createChannelTools(opts = {}) {
  const waitCapMs      = opts.waitCapMs ?? DEFAULT_WAIT_CAP_MS
  const quietCapMs     = opts.quietCapMs ?? DEFAULT_QUIET_CAP_MS
  const quietThresholdMs = opts.quietThresholdMs ?? QUIET_THRESHOLD_MS
  const store = new LogStore()
  const onAppend = opts.onAppend ?? null   // optional hook for file persistence

  // Pick the cap that applies right now. Channel is "quiet" when no peer
  // is in an open long-poll AND no message has been posted in the threshold.
  const isQuiet = () => {
    if (store.hasAnyWaiter()) return false
    const lastTs = store.latestMessageTs()
    if (lastTs > 0 && Date.now() - lastTs < quietThresholdMs) return false
    return true
  }
  const currentCapMs = () => (isQuiet() ? quietCapMs : waitCapMs)

  // Wrap append so callers (e.g. host) can persist each new message.
  if (onAppend) {
    const inner = store.append.bind(store)
    store.append = (rec) => { const msg = inner(rec); onAppend(msg); return msg }
  }

  const tools = [
    {
      path: "/send",
      description: "Broadcast a message. Fire-and-forget.",
      handler: async ({ body }) => {
        let p = {}
        try { p = JSON.parse(body || "{}") } catch {}
        if (typeof p.name !== "string" || !p.name.trim()) return err400("bad_input", "name is required")
        if (typeof p.text !== "string") return err400("bad_input", "text is required")
        if (Buffer.byteLength(p.text, "utf8") > MAX_TEXT_BYTES) return err400("message_too_large", `text > ${MAX_TEXT_BYTES} bytes`)
        const activeBefore = countActiveWaiters(store, p.name)
        const msg = store.append({ from: p.name, text: p.text })
        return { ok: true, seq: msg.seq, delivered_to_active: activeBefore }
      },
    },
    {
      path: "/recv",
      description: "Long-poll for new messages, optionally broadcast first.",
      handler: async ({ body }) => {
        let p = {}
        try { p = JSON.parse(body || "{}") } catch {}
        const name = typeof p.name === "string" && p.name.trim() ? p.name : null
        const since = Number.isFinite(p.since) ? p.since : null
        const wait = clampWait(p.wait, currentCapMs())
        const message = typeof p.message === "string" && p.message.length > 0 ? p.message : null

        if (message != null && !name) return err400("bad_input", "name is required when sending a message via /recv")
        if (message != null && Buffer.byteLength(message, "utf8") > MAX_TEXT_BYTES) {
          return err400("message_too_large", `message > ${MAX_TEXT_BYTES} bytes`)
        }

        // Reserve wait slot BEFORE broadcasting, so recipients see awaiting:true.
        const waitHandle = wait > 0 ? store.wait({ name, maxMs: wait }) : null

        if (message != null) store.append({ from: name, text: message })
        if (name) store.touch(name)

        if (since === null) {
          if (waitHandle) waitHandle.cancel()
          return store.scrollback(name)
        }

        const drained = store.drain({ since, senderName: name })
        if (drained.messages.length > 0 || wait <= 0) {
          if (waitHandle) waitHandle.cancel()
          return drained
        }

        const messages = await waitHandle.promise
        return { messages, latest_seq: store.nextSeq - 1 }
      },
    },
    {
      path: "/peers",
      description: "Roster of recently-active participants.",
      handler: async () => store.peers(),
    },
  ]

  return { store, tools, agentsMd: buildAgentsMd() }
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
