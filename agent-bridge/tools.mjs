// Generic prompt-executor surface. The bridge has zero knowledge of any
// particular campaign — every caller (Blitz worker, CLI, whatever) is
// responsible for constructing the prompt that defines what should happen.
// The bridge spawns the configured local harness with that prompt and
// returns immediately; the agent works in the background.
//
// Tools:
//   POST /run    { prompt, tag?, timeout_ms? }  → spawn harness, return run_id
//   POST /cancel { run_id }                     → kill a running invocation
//   GET  /health                                → status + active run count

import { randomUUID } from "node:crypto"
import { startHarness } from "./harness.mjs"

const HEALTH_VERSION = "0.1.0"
const STARTED_AT = Date.now()

// In-flight runs by id. Each entry: { tag, harness, started_at, cancel, pid }
const runs = new Map()

export function buildTools({ harness, log }) {
  return [
    {
      method: "GET",
      path: "/health",
      description: "Status: version, configured harness, uptime, active run count.",
      handler: async () => ({
        ok: true,
        version: HEALTH_VERSION,
        harness,
        uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
        active_runs: runs.size,
      }),
    },

    {
      path: "/run",
      description:
        "Spawn the configured local AI harness with the supplied prompt. " +
        "Body: { prompt: string, tag?: string, timeout_ms?: number }. " +
        "Returns immediately with a run_id; the harness runs in the background. " +
        "If you want the result, instruct the agent (in your prompt) to POST it back to your own endpoint.",
      input_schema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "The full text passed to the harness. Embed any URLs, tokens, instructions, and context the agent needs." },
          tag: { type: "string", description: "Short label for logs/grep. e.g. 'send_now', 'rescue_engagement'." },
          timeout_ms: { type: "integer", description: "Per-call timeout override. Default 900000 (15 min)." },
        },
      },
      handler: async ({ body }) => {
        const args = parse(body)
        const prompt = String(args.prompt || "")
        if (!prompt) return { ok: false, error: "prompt required" }
        const run_id = randomUUID()
        const tag = (args.tag || "untagged").slice(0, 64)
        const started_at = Date.now()
        const { pid, promise, cancel } = startHarness({
          harness,
          prompt,
          timeout_ms: args.timeout_ms,
          log: (m) => log?.(`[run ${run_id.slice(0, 8)} tag=${tag}] ${m}`),
        })
        runs.set(run_id, { tag, harness, started_at, cancel, pid })

        // Detach: log the outcome, clean up the map, never throw out of here.
        promise
          .then((stdout) => {
            const ms = Date.now() - started_at
            log?.(`[run ${run_id.slice(0, 8)} tag=${tag}] OK after ${ms}ms (${stdout?.length ?? 0} chars)`)
            const banner = `─── run ${run_id.slice(0, 8)} tag=${tag} response ───`
            log?.(`${banner}\n${stdout}\n${"─".repeat(banner.length)}`)
          })
          .catch((e) => {
            const ms = Date.now() - started_at
            log?.(`[run ${run_id.slice(0, 8)} tag=${tag}] FAIL after ${ms}ms: ${String(e.message).slice(0, 500)}`)
          })
          .finally(() => runs.delete(run_id))

        return {
          ok: true,
          accepted: true,
          run_id,
          tag,
          harness,
          pid,
          started_at: new Date(started_at).toISOString(),
        }
      },
    },

    {
      path: "/cancel",
      description: "Kill a running invocation. Body: { run_id }.",
      input_schema: { type: "object", required: ["run_id"] },
      handler: async ({ body }) => {
        const args = parse(body)
        const run_id = String(args.run_id || "")
        const r = runs.get(run_id)
        if (!r) return { ok: false, error: "run_id not found (already finished or never existed)", run_id }
        r.cancel()
        runs.delete(run_id)
        return { ok: true, cancelled: run_id, tag: r.tag, was_running_ms: Date.now() - r.started_at }
      },
    },
  ]
}

function parse(body) {
  if (!body) return {}
  if (typeof body === "object") return body
  try { return JSON.parse(body) } catch { return {} }
}
