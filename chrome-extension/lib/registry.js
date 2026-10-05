// Client for the site-profile registry (registry/ in this repo; default
// https://registry.agentsocket.dev) and the AI tools that use it.
//
// The registry is the only source of shared site profiles. Its public API is
// JSON with CORS `*`, so these fetches work from the service worker.

import { GENERIC_HOST, isRegistryLookupHost, normalizeRegistryHost, validateProfile } from "./profiles.js"

export const DEFAULT_REGISTRY_BASE = "https://registry.agentsocket.dev"
// Connect waits at most this long for the registry, then goes on without it.
export const REGISTRY_TIMEOUT_MS = 3000

const trimBase = (base) => String(base || DEFAULT_REGISTRY_BASE).replace(/\/+$/, "")

async function getJson(url, signal) {
  const r = await fetch(url, { signal, headers: { accept: "application/json" }, credentials: "omit" })
  let body = null
  try { body = await r.json() } catch {}
  return { status: r.status, body }
}

// Keeps only well-formed tools from a registry response.
function cleanProfile(body) {
  if (!body || typeof body !== "object" || typeof body.host !== "string" || !Array.isArray(body.tools)) return null
  return {
    host: body.host,
    version: Number.isInteger(body.version) ? body.version : null,
    updated: body.updated ?? null,
    notes: typeof body.notes === "string" ? body.notes : "",
    tools: body.tools.filter((t) => t && typeof t === "object" && typeof t.path === "string" && typeof t.code === "string"),
  }
}

/**
 * The profile to load for a tab on `hostname`: the site's own, else the
 * generic one ("*"). Hostnames that can't be in the registry (IPs, localhost,
 * LAN names) are never sent; those tabs get the generic profile. One shared
 * deadline for both requests.
 *
 * Returns { status: "ok" | "generic" | "none" | "unreachable", profile?, error? }.
 */
export async function fetchSiteProfile(base, hostname, timeoutMs = REGISTRY_TIMEOUT_MS) {
  const root = `${trimBase(base)}/v1/sites/`
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    if (isRegistryLookupHost(hostname)) {
      const r = await getJson(root + encodeURIComponent(normalizeRegistryHost(hostname)), signal)
      if (r.status === 200) {
        const profile = cleanProfile(r.body)
        if (profile) return { status: "ok", profile }
      }
      if (r.status !== 404 && r.status !== 200 && r.status !== 400) return { status: "unreachable", error: `HTTP ${r.status}` }
    }
    const g = await getJson(root + GENERIC_HOST, signal)
    if (g.status === 200) {
      const profile = cleanProfile(g.body)
      if (profile) return { status: "generic", profile }
    }
    if (g.status === 404) return { status: "none" }
    return { status: "unreachable", error: `HTTP ${g.status}` }
  } catch (e) {
    return { status: "unreachable", error: e?.name === "TimeoutError" ? `no answer in ${timeoutMs} ms` : (e?.message ?? String(e)) }
  }
}

// ── AI tools ───────────────────────────────────────────────────────────

function parseBody(body) {
  if (!body) return {}
  try { const v = JSON.parse(body); return v && typeof v === "object" ? v : {} } catch { return null }
}
const bad = (message, extra) => ({ status: 400, body: { error: { code: "bad_input", message, ...(extra ?? {}) } } })
const unreachable = (base, e) => ({
  status: 502,
  body: { error: { code: "registry_unreachable", message: `could not reach the registry at ${base}: ${e?.name === "TimeoutError" ? "timed out" : (e?.message ?? e)}` } },
})
// Passes a registry error through with its status, so the AI sees the reason.
const registryError = (r) => ({
  status: r.status >= 400 && r.status <= 599 ? r.status : 502,
  body: { error: { code: r.body?.error?.code ?? "registry_error", message: r.body?.error?.message ?? `registry answered HTTP ${r.status}`, ...(r.body?.error?.issues ? { issues: r.body.error.issues } : {}) } },
})

/**
 * /registry_search, /registry_get, /registry_submit.
 * deps: getBase() → registry base URL; getHostname() → bound tab's hostname
 * (default host); loadedHost() → host of the registry profile in this
 * session; basePaths: Set of built-in tool paths; extVersion.
 */
export function buildRegistryTools({ getBase, getHostname, loadedHost, basePaths, extVersion }) {
  const toolSchema = {
    type: "object",
    required: ["path", "description", "code"],
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "POST" },
      path: { type: "string", description: "URL path starting with /, e.g. /list_issues. Can't reuse a built-in tool's path." },
      description: { type: "string", description: "What it does and what it returns." },
      input_schema: { type: "object", description: "JSON Schema of the body; the code sees it as `args`." },
      code: { type: "string", description: "JS function body run in the page's main world. Use args.<param>; `return` the result." },
    },
  }
  return [
    {
      path: "/registry_search",
      description: "Search the shared site-profile registry (hosts, notes, tool names and descriptions). Do this BEFORE exploring a site: someone may already have written tools for it. Returns compact hits { host, version, tool_count, summary, matched_tools }; then use /registry_get for details.",
      input_schema: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string", minLength: 2, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (!args || typeof args.q !== "string" || args.q.trim().length < 2 || args.q.length > 200) return bad("expected { q: string (2-200 chars) }")
        const limit = Math.min(Math.max(Number.parseInt(args.limit ?? 10, 10) || 10, 1), 50)
        const base = trimBase(await getBase())
        try {
          const r = await getJson(`${base}/v1/search?q=${encodeURIComponent(args.q.trim())}&limit=${limit}`, AbortSignal.timeout(8000))
          if (r.status !== 200) return registryError(r)
          return {
            query: r.body?.query ?? args.q,
            results: (r.body?.results ?? []).map((x) => ({
              host: x.host, version: x.version, tool_count: x.tool_count, summary: x.summary,
              matched_tools: x.matched_tools ?? [],
              ...(Array.isArray(x.tools) && x.tools.length <= 20 ? { tools: x.tools } : {}),
            })),
          }
        } catch (e) { return unreachable(base, e) }
      },
    },
    {
      path: "/registry_get",
      description: "Get a site's approved profile from the shared registry: notes and tools (method, path, description, input_schema). Code is left out unless include_code:true. host defaults to the connected tab's hostname; \"*\" is the generic profile. `loaded` says whether these tools are already live in this session.",
      input_schema: {
        type: "object",
        properties: { host: { type: "string", description: "e.g. github.com" }, include_code: { type: "boolean", default: false } },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (!args) return bad("body must be JSON")
        const host = normalizeRegistryHost(args.host ?? (await getHostname()))
        if (!host) return bad("host must be a public hostname like \"github.com\" (no scheme, port or path), or \"*\"")
        const base = trimBase(await getBase())
        try {
          const r = await getJson(`${base}/v1/sites/${encodeURIComponent(host)}`, AbortSignal.timeout(8000))
          if (r.status === 404) return { found: false, host, hint: "No approved profile. Explore with /eval, then /save_site_profile and /registry_submit." }
          if (r.status !== 200) return registryError(r)
          const p = r.body ?? {}
          return {
            found: true,
            host: p.host,
            requested_host: p.requested_host,
            version: p.version,
            updated: p.updated,
            loaded: !!p.host && p.host === loadedHost(),
            notes: p.notes,
            tools: (p.tools ?? []).map((t) => ({
              method: t.method, path: t.path, description: t.description,
              ...(t.input_schema ? { input_schema: t.input_schema } : {}),
              ...(args.include_code ? { code: t.code } : {}),
            })),
          }
        } catch (e) { return unreachable(base, e) }
      },
    },
    {
      path: "/registry_submit",
      description: "Share a site profile with everyone: sends { host, notes, tools } to the registry as a submission. Maintainers review it (code included) before it is published, so it is NOT live right away and won't change this session; use /save_site_profile for tools you need now. Submit only tools you have tested. host defaults to the connected tab's hostname and must be a public hostname. The registry stores the profile, the extension version and the browser's user agent.",
      input_schema: {
        type: "object",
        required: ["tools"],
        properties: {
          host: { type: "string", description: "e.g. github.com (no scheme/port/path)" },
          notes: { type: "string", description: "Markdown notes about the site: layout, gotchas, how the tools fit together." },
          tools: { type: "array", maxItems: 50, items: toolSchema },
        },
      },
      handler: async ({ body }) => {
        const args = parseBody(body)
        if (!args) return bad("body must be JSON")
        const unknown = Object.keys(args).filter((k) => !["host", "notes", "tools"].includes(k))
        if (unknown.length) return bad(`unknown field(s): ${unknown.join(", ")}`)
        const host = normalizeRegistryHost(args.host ?? (await getHostname()))
        if (!host || host === GENERIC_HOST || !isRegistryLookupHost(host)) {
          return bad("host must be a public hostname like \"github.com\" (no scheme, port, path, IP or local name)")
        }
        const v = validateProfile({ notes: args.notes, tools: args.tools }, basePaths)
        if (!v.ok) return bad("profile failed validation; nothing was sent", { issues: v.issues.slice(0, 50) })
        if (!v.tools.length && !v.notes.trim()) return bad("empty profile: give notes or tools")
        const base = trimBase(await getBase())
        let r
        try {
          const res = await fetch(`${base}/v1/submissions`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            credentials: "omit",
            body: JSON.stringify({ host, notes: v.notes, tools: v.tools, ext_version: extVersion }),
            signal: AbortSignal.timeout(10000),
          })
          r = { status: res.status, body: await res.json().catch(() => null) }
        } catch (e) { return unreachable(base, e) }
        if (r.status !== 200 && r.status !== 201) return registryError(r)
        return {
          submitted: true,
          id: r.body?.id,
          status: r.body?.status ?? "pending",
          ...(r.body?.duplicate ? { duplicate: true } : {}),
          host,
          tool_count: v.tools.length,
          message: "Pending review by the registry maintainers; it goes live for everyone once approved. It does not change this session.",
        }
      },
    },
  ]
}
