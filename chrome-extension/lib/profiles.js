// Site profiles: validation, merging and the agents.md briefing.
//
// Pure functions (no chrome.* calls) so test/profiles.unit.mjs can run them
// in Node. A profile is { host, notes, tools: [{ method, path, description,
// input_schema?, code }] }. Shared profiles come from the registry; local
// ones are saved by the AI with /save_site_profile and only load after the
// user clicks Keep in the popup.
//
// The validation rules MIRROR registry/src/rules.ts (normalizeHost,
// toolPathProblem, parseSubmission, LIMITS), so /registry_submit can explain
// a problem before the registry rejects it. Keep them in sync.

export const TOOL_PATH_RE = /^\/[a-zA-Z0-9_\-/.]+$/
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
export const GENERIC_HOST = "*"

export const LIMITS = {
  notesBytes: 16 * 1024,
  maxTools: 50,
  pathChars: 128,
  descriptionBytes: 4 * 1024,
  inputSchemaBytes: 16 * 1024,
  codeBytes: 32 * 1024,
  hostChars: 253,
}

// The relay's agents.md cap is 64 KB; stay under it with room to spare.
const MAX_AGENTS_MD_CHARS = 60_000

const utf8 = new TextEncoder()
const byteLength = (s) => utf8.encode(s).length
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * Registry host rules: a public DNS name (no scheme, port, IP, single label),
 * lowercased, or "*" for the generic profile. Returns null if not valid.
 */
export function normalizeRegistryHost(input) {
  if (typeof input !== "string") return null
  let h = input.trim().toLowerCase()
  if (h === GENERIC_HOST) return h
  if (h.endsWith(".")) h = h.slice(0, -1)
  if (!h || h.length > LIMITS.hostChars) return null
  const labels = h.split(".")
  if (labels.length < 2) return null
  if (!labels.every((l) => LABEL_RE.test(l))) return null
  if (!TLD_RE.test(labels[labels.length - 1])) return null
  return h
}

/**
 * Local profile key: a hostname, optionally with a port (local dev servers
 * like localhost:3000 are fine here; they just can't go to the registry).
 */
export function normalizeLocalHost(input) {
  if (typeof input !== "string") return null
  const h = input.trim().toLowerCase().replace(/\.$/, "")
  if (!h || h.length > LIMITS.hostChars + 6) return null
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(h)) return null
  return h
}

/** Hostnames that never go to the registry: IPs, localhost, LAN names. */
export function isRegistryLookupHost(hostname) {
  const h = normalizeRegistryHost(hostname)
  if (!h || h === GENERIC_HOST) return false
  return !/\.(localhost|local|lan|internal|home\.arpa)$/.test(h)
}

/** Why a site tool can't use `path`, or null. `basePaths`: the extension's built-in tools. */
export function toolPathProblem(path, basePaths) {
  if (path.length > LIMITS.pathChars) return `path longer than ${LIMITS.pathChars} chars`
  if (!TOOL_PATH_RE.test(path)) return "path must match ^/[a-zA-Z0-9_\\-/.]+$"
  const lower = path.toLowerCase()
  if (path.startsWith("/_as_") || lower === "/agents.md" || lower.startsWith("/agents.md/")
    || lower === "/tools.json" || lower.startsWith("/tools.json/")) {
    return "path is reserved by the relay"
  }
  if (basePaths?.has(path)) return "path collides with a built-in extension tool"
  return null
}

const TOOL_KEYS = new Set(["method", "path", "description", "input_schema", "code"])

/**
 * Validates a profile's notes + tools (the registry's submission rules).
 * Returns { ok: true, notes, tools } with normalized tools, or { ok: false, issues }.
 */
export function validateProfile({ notes, tools }, basePaths) {
  const issues = []
  let cleanNotes = ""
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string") issues.push({ path: "notes", message: "must be a string" })
    else if (byteLength(notes) > LIMITS.notesBytes) issues.push({ path: "notes", message: `longer than ${LIMITS.notesBytes} bytes` })
    else cleanNotes = notes.replace(/\r\n/g, "\n")
  }
  const out = []
  if (!Array.isArray(tools)) {
    issues.push({ path: "tools", message: "must be an array" })
  } else if (tools.length > LIMITS.maxTools) {
    issues.push({ path: "tools", message: `at most ${LIMITS.maxTools} tools` })
  } else {
    const seen = new Set()
    tools.forEach((t, i) => {
      const p = `tools[${i}]`
      if (!isPlainObject(t)) { issues.push({ path: p, message: "must be an object" }); return }
      for (const k of Object.keys(t)) if (!TOOL_KEYS.has(k)) issues.push({ path: `${p}.${k}`, message: "unknown field" })
      let method = "POST"
      if (t.method !== undefined && t.method !== null) {
        const m = typeof t.method === "string" ? t.method.toUpperCase() : ""
        if (!METHODS.includes(m)) issues.push({ path: `${p}.method`, message: `must be one of ${METHODS.join(", ")}` })
        else method = m
      }
      if (typeof t.path !== "string") issues.push({ path: `${p}.path`, message: "required string" })
      else {
        const problem = toolPathProblem(t.path, basePaths)
        if (problem) issues.push({ path: `${p}.path`, message: `${problem}: ${JSON.stringify(t.path.slice(0, 140))}` })
        else {
          const key = `${method} ${t.path}`
          if (seen.has(key)) issues.push({ path: `${p}.path`, message: `duplicate tool ${key}` })
          seen.add(key)
        }
      }
      if (typeof t.description !== "string" || !t.description.trim()) issues.push({ path: `${p}.description`, message: "required non-empty string" })
      else if (byteLength(t.description) > LIMITS.descriptionBytes) issues.push({ path: `${p}.description`, message: `longer than ${LIMITS.descriptionBytes} bytes` })
      if (t.input_schema !== undefined && t.input_schema !== null) {
        if (!isPlainObject(t.input_schema)) issues.push({ path: `${p}.input_schema`, message: "must be a JSON Schema object" })
        else if (byteLength(JSON.stringify(t.input_schema)) > LIMITS.inputSchemaBytes) issues.push({ path: `${p}.input_schema`, message: `larger than ${LIMITS.inputSchemaBytes} bytes` })
      }
      if (typeof t.code !== "string" || !t.code.trim()) issues.push({ path: `${p}.code`, message: "required non-empty string (JS function body)" })
      else if (byteLength(t.code) > LIMITS.codeBytes) issues.push({ path: `${p}.code`, message: `longer than ${LIMITS.codeBytes} bytes` })
      out.push({
        method,
        path: t.path,
        description: t.description,
        ...(isPlainObject(t.input_schema) ? { input_schema: t.input_schema } : {}),
        code: typeof t.code === "string" ? t.code.replace(/\r\n/g, "\n") : t.code,
      })
    })
  }
  if (issues.length) return { ok: false, issues }
  return { ok: true, notes: cleanNotes, tools: out }
}

const toolKey = (t) => `${(t.method ?? "POST").toUpperCase()} ${t.path}`

// A tool from a profile that is safe to register: right shape, valid path,
// no clash with a built-in. Profiles are validated when saved/approved; this
// is the backstop so one bad entry can't make Connect fail.
function usableTool(t, basePaths) {
  return isPlainObject(t) && typeof t.path === "string" && typeof t.code === "string"
    && (t.method === undefined || METHODS.includes(String(t.method).toUpperCase()))
    && !toolPathProblem(t.path, basePaths)
}

/**
 * Site tools for a connection: registry tools, then local (kept) tools; a
 * local tool replaces a registry tool with the same METHOD + path. Unusable
 * tools are dropped. Returns { tools, overridden: [keys], dropped: [keys] }.
 */
export function mergeSiteTools(registryTools, localTools, basePaths) {
  const byKey = new Map()
  const overridden = [], dropped = []
  for (const [list, local] of [[registryTools ?? [], false], [localTools ?? [], true]]) {
    for (const t of list) {
      if (!usableTool(t, basePaths)) { dropped.push(isPlainObject(t) ? toolKey(t) : String(t)); continue }
      const k = toolKey(t)
      if (byKey.has(k)) {
        if (!local) continue  // duplicate within the registry profile: first wins
        overridden.push(k)
      }
      byKey.set(k, {
        method: (t.method ?? "POST").toUpperCase(),
        path: t.path,
        description: typeof t.description === "string" ? t.description : "",
        ...(isPlainObject(t.input_schema) ? { input_schema: t.input_schema } : {}),
        code: t.code,
        source: local ? "local" : "registry",
      })
    }
  }
  return { tools: [...byKey.values()], overridden, dropped }
}

/** Kept local profile for a tab: exact host (with port) first, then hostname. */
export function findLocalProfile(profiles, host, hostname) {
  if (!profiles) return null
  return profiles[host] ?? (hostname !== host ? profiles[hostname] : null) ?? null
}

/** One-line description of where the bound tab's tools come from. */
export function sourceLabel(source) {
  if (!source) return ""
  const r = source.registry ?? {}
  const parts = []
  if (r.status === "ok") parts.push(`${r.host} v${r.version} from registry`)
  else if (r.status === "generic") parts.push("generic profile (none for this site)")
  else if (r.status === "unreachable") parts.push("base only (registry unreachable)")
  else parts.push("base only")
  if (source.local?.count) parts.push(`${source.local.count} local`)
  return parts.join(" · ")
}

function oneLine(s, max) {
  const l = String(s ?? "").split("\n")[0].trim()
  return l.length > max ? `${l.slice(0, max - 1)}…` : l
}

/**
 * agents.md for a connection. `registry`: { status, profile? } from the
 * registry fetch; `local`: the kept local profile or null; `tools`: every
 * registered tool (base + site).
 */
export function buildAgentsMd({ host, registry, local, tools }) {
  const profile = registry?.profile
  const loaded = []
  if (registry?.status === "ok") loaded.push(`the shared registry profile for **${profile.host}** (v${profile.version}, reviewed before publishing)`)
  else if (registry?.status === "generic") loaded.push("the registry's generic profile (no site-specific one exists yet)")
  if (local) loaded.push(`a profile saved on this computer for **${local.host}** (${local.tools?.length ?? 0} tools, approved by the user)`)
  const status = registry?.status === "unreachable"
    ? "The tool registry was unreachable when this session started, so only the built-in tools are loaded" + (local ? " plus the user's local profile." : ".")
    : loaded.length ? `Loaded: ${loaded.join("; ")}.` : "No site profile is loaded; only the built-in tools."

  const toolLines = tools.map((t) => `- \`${t.method ?? "POST"} ${t.path}\` — ${oneLine(t.description, 200)}`).join("\n")
  const notes = []
  if (profile?.notes?.trim()) notes.push(`## Site notes (${profile.host === GENERIC_HOST ? "generic" : `${profile.host}, registry v${profile.version}`})\n\n${profile.notes.trim()}\n`)
  if (local?.notes?.trim()) notes.push(`## Local notes (${local.host})\n\n${local.notes.trim()}\n`)

  const md = [
    `# Agent Socket — driving \`${host || "a browser tab"}\``,
    "",
    "You are connected to a Chrome extension that exposes one browser tab the",
    "user chose as a set of HTTPS tool endpoints. Each call runs in the page's",
    "main world (it sees the same JS globals as if you'd opened DevTools).",
    "",
    "**Start by calling `POST /page_info`** to see what's on screen. Then use",
    "`/dom_query` to find selectors, `/eval` to run arbitrary JS when you need",
    "to explore deeper, and `/click` / `/fill` / `/navigate` to drive.",
    "",
    status,
    "",
    "## Tools",
    "",
    toolLines,
    "",
    "## Site profiles: reuse before you explore",
    "",
    "1. Before exploring a site, check the shared registry: `POST /registry_search {\"q\": \"...\"}`",
    "   and `POST /registry_get {\"host\": \"...\"}` (notes + tool list).",
    "2. Explore with `/eval` and `/dom_query`; prefer stable selectors and test each tool's code.",
    "3. `POST /save_site_profile` saves tools for this site on the user's computer. They load only",
    "   after the user clicks **Keep** in the extension popup; then they appear in `tools.json` on",
    "   this same URL (re-fetch it). A save replaces the earlier local profile for that host.",
    "4. `POST /registry_submit` shares a profile with everyone. Maintainers review it before it",
    "   is published, so it won't be live right away.",
    "",
    "Each tool body is JSON. Errors come back as `{ error: { code, message } }`",
    "with non-2xx status. Keep results small; prefer targeted queries over",
    "wholesale DOM dumps.",
    "",
    "## Limits the user set",
    "",
    "Tools act only while the tab is on a site the user allowed (at first, the one it",
    "was on at Connect). Elsewhere they return 403 `origin_not_allowed` and do nothing:",
    "ask the user to click **Allow** in the extension, or to go back. The session also",
    "ends on the user's timer. `/page_info` shows `allowed_origins` and `session_ends_at`.",
    "",
    ...notes,
  ].join("\n")
  return md.length > MAX_AGENTS_MD_CHARS ? `${md.slice(0, MAX_AGENTS_MD_CHARS)}\n\n…(truncated)\n` : md
}
