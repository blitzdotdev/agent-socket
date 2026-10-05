// Session timer and site lock: pure helpers (no chrome.* calls), so
// test/limits.unit.mjs can run them in Node.
//
// Timer: a session ends `minutes` after Connect unless the user changes or
// removes it. Site lock: tools only run while the bound tab is on an allowed
// origin (scheme + host + port), unless the user lets the AI use any site.

export const DEFAULT_SESSION_MINUTES = 60
// Lengths offered in the popup's Change; Settings also offers 0 = no limit.
export const TIMER_CHOICES = [15, 30, 60, 120, 240, 480]

/** Deadline (ms epoch) for a timer of `minutes` started at `now`, or null for no limit. */
export function deadlineFor(minutes, now) {
  return Number.isFinite(minutes) && minutes > 0 ? now + minutes * 60_000 : null
}

/** Default session length from Settings: a TIMER_CHOICES value or 0 (no limit). */
export function sessionMinutes(stored) {
  return stored === 0 || TIMER_CHOICES.includes(stored) ? stored : DEFAULT_SESSION_MINUTES
}

/** ms left until `endsAt` (never negative), or null without a deadline. */
export function timeLeft(endsAt, now) {
  return endsAt == null ? null : Math.max(0, endsAt - now)
}

/** The pill's short form: "45 s left", "42 min left", "1 h 30 min left". */
export function shortLeft(ms) {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} s left`
  const m = Math.ceil(ms / 60_000)
  if (m <= 60) return `${m} min left`
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""} left`
}

/** The popup's countdown: "42:10", "1:02:03". */
export function clock(ms) {
  const s = Math.ceil(ms / 1000)
  const mm = String(Math.floor(s / 60) % 60), ss = String(s % 60).padStart(2, "0")
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`
}

/** "15 min", "1 h", or "No limit" for a timer length. */
export function lengthLabel(minutes) {
  return !minutes ? "No limit" : minutes < 60 ? `${minutes} min` : `${minutes / 60} h`
}

/**
 * The origin the site lock compares: scheme + host + port for http(s),
 * "file://" for local files; null for anything else (chrome://, about:,
 * data:, unparsable), which is never allowed unless any site is.
 */
export function originOf(url) {
  let u
  try { u = new URL(url) } catch { return null }
  if (u.protocol === "file:") return "file://"
  return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null
}

/** Whether a tool may act on a tab at `url`. */
export function originAllowed(url, { origins, any }) {
  if (any) return true
  const o = originOf(url)
  return o != null && origins.includes(o)
}

/** How an origin is shown to people: "github.com", "localhost:3000", "local files". */
export function originLabel(origin) {
  if (origin === "file://") return "local files"
  try { return new URL(origin).host } catch { return String(origin ?? "") }
}
