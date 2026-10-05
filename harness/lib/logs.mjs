// Read recent wrangler.log lines for failure messages.
// Wrangler's log location: WRANGLER_LOG env var (we set it via npm run dev),
// or default /tmp/as-wrangler.log used by the README's recipe.

import { readFileSync, existsSync } from "node:fs"

export function tail(n = 20) {
  // Read lazily: run.mjs sets WRANGLER_LOG after import when it boots wrangler.
  const logPath = process.env.WRANGLER_LOG ?? "/tmp/as-wrangler.log"
  if (!existsSync(logPath)) return []
  const text = readFileSync(logPath, "utf8")
  return text.split("\n").filter(Boolean).slice(-n)
}

/**
 * Return log lines whose timestamp is at or after `sinceIso`.
 * Wrangler doesn't always prefix lines with timestamps, so this is best-effort:
 * we just return the last N lines (where N grows with how recent sinceIso is).
 * For now, return last 30 lines — refine if needed.
 */
export function sliceSince(_sinceIso) {
  return tail(30)
}
