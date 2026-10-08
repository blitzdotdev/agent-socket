// Activity log: one entry per AI tool call (and per session event, like
// Connect or Stop) so the user can see what the AI did in their tab.
//
// Kept in chrome.storage.local, on this computer only, for 7 days; the user
// can delete single entries, a session's entries, or everything from
// activity.html. How much of each call is kept is a setting (LEVELS).
//
// describeCall() is pure; createActivityStore() takes the storage area as a
// parameter, so both are unit-tested without Chrome.

export const LEVELS = {
  summary: "Summary (typed text hidden)",
  full: "Full detail",
  minimal: "Tool + result only",
}
export const DEFAULT_LEVEL = "summary"
export const levelOf = (v) => (Object.hasOwn(LEVELS, v) ? v : DEFAULT_LEVEL)

export const RETENTION_MS = 7 * 24 * 3_600_000
export const MAX_ENTRIES = 1500
export const ENTRY_MAX_BYTES = 4096  // 1500 × 4 KiB ≈ 6 MiB, under storage.local's 10 MiB with room for profiles
export const KEY_PREFIX = "act:"

// `act:<ms, 15 digits>-<rand>`: sorts by time as a string.
export const entryKey = (at, rand) => `${KEY_PREFIX}${String(Math.floor(at)).padStart(15, "0")}-${rand}`
export const keyTime = (key) => Number(key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 15))
export const isEntryKey = (k) => typeof k === "string" && k.startsWith(KEY_PREFIX)

// ── formatting one call ──────────────────────────────────────────────

// Args that say WHERE or HOW the AI acted, not what it typed: shown as is at
// the summary level. Any other string becomes "<N chars>".
const LOCATOR_KEYS = new Set([
  "selector", "url", "nth", "query", "q", "host", "hostname", "absent", "timeout_ms", "include_code",
  "append", "submit", "direction", "x", "y", "dx", "dy", "by", "block", "behavior", "full_page",
  "limit", "attrs", "text_max", "max_chars", "index", "method", "path",
])
// Values under these keys are masked even at the full level.
const SECRET_KEY = /pass(word|wd|code)?$|secret|token|otp|^pin$|cvv|cvc|card.?number/i

const LOCATOR_MAX = 120
const EVAL_SUMMARY_MAX = 200
const REPLY_MAX = 1000

export const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s)
const oneLine = (s) => s.replace(/\s+/g, " ").trim()
const chars = (s) => `<${s.length} chars>`

// The tool call's JSON body as an object ({} if empty; { _body } if not JSON).
export function parseArgs(body) {
  if (body == null || body === "") return {}
  if (typeof body === "object") return body
  try {
    const v = JSON.parse(body)
    return v && typeof v === "object" && !Array.isArray(v) ? v : { _body: v }
  } catch { return { _body: String(body) } }
}

// Same rule as the SDK's normalizeResult: an object with a numeric `status`
// is a full reply, anything else is a 200 body.
export function replyOf(result) {
  if (result && typeof result === "object" && typeof result.status === "number") return { status: result.status, body: result.body }
  return { status: 200, body: result }
}

export const errorCodeOf = (body) => (body && typeof body === "object" && typeof body.error?.code === "string" ? body.error.code : null)

// data: URLs (screenshots) → "[image 312 KB]"; long strings cut.
function shrinkValue(v, max) {
  if (typeof v === "string") {
    const m = /^data:([\w/+.-]+);base64,/.exec(v)
    if (m) return `[${m[1].startsWith("image/") ? "image" : m[1]} ${Math.round((v.length - m[0].length) * 3 / 4 / 1024)} KB]`
    return trunc(v, max)
  }
  if (Array.isArray(v)) return v.map((x) => shrinkValue(x, max))
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrinkValue(x, max)]))
  return v
}

function maskSummaryArgs(args, path) {
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (path === "/eval" && k === "code" && typeof v === "string") out[k] = trunc(v, EVAL_SUMMARY_MAX)
    else if (LOCATOR_KEYS.has(k) && !SECRET_KEY.test(k)) out[k] = typeof v === "string" ? trunc(v, LOCATOR_MAX) : shrinkValue(v, LOCATOR_MAX)
    else if (typeof v === "string") out[k] = chars(v)
    else if (typeof v === "boolean" || v == null) out[k] = v
    else if (Array.isArray(v)) out[k] = `<${v.length} items>`
    else out[k] = typeof v === "number" ? "<number>" : "<object>"
  }
  return out
}

function maskSecrets(v, password) {
  if (Array.isArray(v)) return v.map((x) => maskSecrets(x, false))
  if (!v || typeof v !== "object") return v
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
    (SECRET_KEY.test(k) || (password && (k === "value" || k === "value_now"))) && typeof x === "string" ? `<hidden: ${x.length} chars>`
      : maskSecrets(x, false)]))
}

// A short one-line description of the call, for the list.
function summaryLine(path, args, reply, level, password) {
  const tool = path.replace(/^\//, "")
  if (level === "minimal") return tool
  const b = reply.body && typeof reply.body === "object" ? reply.body : {}
  const sel = typeof args.selector === "string" ? trunc(oneLine(args.selector), 60) : ""
  const typed = (v) => level === "full" && !password ? `"${trunc(oneLine(v), 60)}"` : `(${v.length} chars${password ? ", password" : ""})`
  switch (path) {
    case "/click":
      if (b.clicked && b.text) return `click "${trunc(oneLine(b.text), 60)}"`
      return `click ${sel}${b.clicked === false && b.reason ? ` (${trunc(b.reason, 60)})` : ""}`
    case "/fill":
      return `fill ${sel} ${typeof args.value === "string" ? typed(args.value) : ""}${args.submit ? " and submit" : ""}`.replace(/\s+$/, "")
    case "/navigate": return `navigate ${typeof args.url === "string" ? trunc(args.url, 100) : ""}`.trim()
    case "/eval": return `eval: ${typeof args.code === "string" ? trunc(oneLine(args.code), 80) : ""}`
    case "/wait_for": return `wait_for ${sel}${args.absent ? " (gone)" : ""}`
    case "/save_site_profile":
    case "/registry_submit": {
      const n = Array.isArray(args.tools) ? args.tools.length : 0
      return `${tool} ${typeof args.host === "string" ? trunc(args.host, 60) : ""} (${n} tool${n === 1 ? "" : "s"})`
    }
    case "/registry_search": return `registry_search "${typeof args.q === "string" ? trunc(args.q, 60) : typeof args.query === "string" ? trunc(args.query, 60) : ""}"`
    case "/registry_get": return `registry_get ${typeof args.host === "string" ? trunc(args.host, 60) : "(this site)"}`
  }
  // Generic: the locator args, then the size of the rest.
  const parts = []
  for (const [k, v] of Object.entries(args)) {
    if (LOCATOR_KEYS.has(k) && !SECRET_KEY.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      parts.push(k === "selector" ? sel : `${k}=${trunc(oneLine(String(v)), 40)}`)
    } else if (typeof v === "string") parts.push(level === "full" && !SECRET_KEY.test(k) ? `${k}="${trunc(oneLine(v), 40)}"` : `${k}: ${v.length} chars`)
  }
  return trunc([tool, ...parts].join(" "), 160)
}

// Shrinks a detail object until its JSON fits in `max` bytes.
function fitDetail(detail, max) {
  for (const n of [1000, 400, 120, 40]) {
    if (new TextEncoder().encode(JSON.stringify(detail)).length <= max) return detail
    detail = shrinkValue(detail, n)
  }
  return new TextEncoder().encode(JSON.stringify(detail)).length <= max ? detail : { truncated: true }
}

// → { tool, summary, status, error, detail } for one tool call.
// `password`: the call typed into a password field (from /fill's reply).
export function describeCall({ method = "POST", path, args = {}, result, status, error, level = DEFAULT_LEVEL }) {
  level = levelOf(level)
  const reply = error !== undefined
    ? { status: 500, body: { error: { code: "handler_error", message: String(error?.message ?? error) } } }
    : replyOf(result)
  if (status != null) reply.status = status
  const password = path === "/fill" && reply.body?.input_type === "password"
  const out = {
    tool: path.replace(/^\//, ""),
    method: String(method).toUpperCase(),
    summary: summaryLine(path, args, reply, level, password),
    status: reply.status,
    error: errorCodeOf(reply.body),
  }
  if (level === "summary") {
    out.detail = fitDetail({ args: maskSummaryArgs(args, path) }, ENTRY_MAX_BYTES - 600)
  } else if (level === "full") {
    const masked = maskSecrets(args, password)
    let body = maskSecrets(shrinkValue(reply.body, REPLY_MAX), password)
    const text = body === undefined ? "" : JSON.stringify(body)
    if (text.length > REPLY_MAX) body = trunc(text, REPLY_MAX)
    out.detail = fitDetail({ args: shrinkValue(masked, 2000), reply: body }, ENTRY_MAX_BYTES - 600)
  }
  if (out.error && reply.body?.error?.message && level !== "minimal") out.message = trunc(String(reply.body.error.message), 300)
  return out
}

// ── session events ───────────────────────────────────────────────────

export const SESSION_EVENTS = {
  connected: (e) => `Connected on ${e.host || "this tab"}`,
  link_changed: () => "The link changed: a new session started",
  stopped: () => "Stopped by the user",
  expired: () => "Session timer ran out: stopped",
  tab_closed: () => "Tab closed: session ended",
  origin_allowed: (e) => `Allowed ${e.site} for this session`,
  origin_removed: (e) => `Removed ${e.site} from the allowed sites`,
  any_origin: (e) => (e.on ? "Allowed other sites in this tab" : "Locked to the allowed sites"),
  timer_set: (e) => (e.minutes ? `Timer set: stops ${e.minutes} min from then` : "Timer removed"),
}
export const ENDING_EVENTS = new Set(["stopped", "expired", "tab_closed"])
export const eventSummary = (e) => SESSION_EVENTS[e.event]?.(e) ?? e.event

// ── listing helpers ──────────────────────────────────────────────────

// Keys to delete: older than the retention window, then the oldest beyond MAX.
export function keysToPrune(keys, now, { retentionMs = RETENTION_MS, max = MAX_ENTRIES } = {}) {
  const sorted = keys.filter(isEntryKey).sort()
  const cutoff = now - retentionMs
  const old = sorted.filter((k) => keyTime(k) < cutoff)
  const rest = sorted.slice(old.length)
  return [...old, ...rest.slice(0, Math.max(0, rest.length - max))]
}

// Newest first, grouped by session: [{ session, host, start, end, ending, entries }].
export function groupBySession(entries) {
  const groups = new Map()
  for (const e of [...entries].sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1))) {
    const k = e.session ?? "-"
    if (!groups.has(k)) groups.set(k, { session: e.session ?? null, entries: [] })
    groups.get(k).entries.push(e)
  }
  return [...groups.values()].map((g) => {
    const first = g.entries[g.entries.length - 1]
    const connected = g.entries.find((e) => e.kind === "session" && e.event === "connected")
    const ending = g.entries.find((e) => e.kind === "session" && ENDING_EVENTS.has(e.event))
    return { ...g, host: connected?.host || first.host || "", start: first.at, end: ending?.at ?? null, ending: ending?.event ?? null }
  })
}

export function matchesFilter(e, q) {
  q = q.trim().toLowerCase()
  if (!q) return true
  return [e.host, e.tool, e.summary, e.error, e.session].some((v) => typeof v === "string" && v.toLowerCase().includes(q))
}

// ── storage ──────────────────────────────────────────────────────────

// `area`: chrome.storage.local (get / set / remove / getKeys). Adds are
// serialized; each is written at once, since the service worker can stop any time.
export function createActivityStore(area, { now = Date.now, rand = () => Math.random().toString(36).slice(2, 8) } = {}) {
  let chain = Promise.resolve()
  let count = null  // entry count, known after the first list or prune
  const serial = (fn) => {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }
  async function keys() {
    const all = area.getKeys ? await area.getKeys() : Object.keys(await area.get(null))
    return all.filter(isEntryKey).sort()
  }
  async function prune() {
    const ks = await keys()
    const drop = keysToPrune(ks, now())
    if (drop.length) await area.remove(drop)
    count = ks.length - drop.length
    return drop.length
  }
  return {
    keys,
    add(entry) {
      return serial(async () => {
        const at = entry.at ?? now()
        const id = entryKey(at, rand())
        await area.set({ [id]: { ...entry, id, at } })
        if (count == null) count = (await keys()).length
        else count++
        if (count > MAX_ENTRIES) await prune()
        return id
      })
    },
    prune: () => serial(prune),
    // Newest `limit` entries (all if omitted), newest first.
    async list(limit) {
      const ks = await keys()
      const pick = limit ? ks.slice(-limit) : ks
      if (!pick.length) return []
      const got = await area.get(pick)
      return pick.map((k) => got[k]).filter(Boolean).reverse()
    },
    remove: (ids) => serial(async () => {
      ids = [ids].flat().filter(isEntryKey)
      if (ids.length) await area.remove(ids)
      count = null
    }),
    clear: () => serial(async () => {
      const ks = await keys()
      if (ks.length) await area.remove(ks)
      count = 0
    }),
  }
}
