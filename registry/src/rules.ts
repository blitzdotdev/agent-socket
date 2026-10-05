// Validation for submitted site profiles.
//
// The tool-path rules MIRROR relay/src/relay-do.ts (TOOL_PATH_RE,
// RESERVED_PATHS, RESERVED_PREFIX and the prefix-shadowing check in the
// register handler). They are copied rather than imported because relay-do.ts
// is the Durable Object module (imports partyserver etc.) and doesn't export
// them. If you change them there, change them here too — a profile the
// registry accepts but the relay rejects would break Connect for that site.

export const TOOL_PATH_RE = /^\/[a-zA-Z0-9_\-/.]+$/
export const RESERVED_PATHS = new Set(['/agents.md', '/tools.json'])
export const RESERVED_PREFIX = '_as_'

// The Chrome extension registers these base tools on every connection
// (chrome-extension/lib/tools-base.js, buildBaseTools). The relay rejects a
// registration with a duplicate METHOD+path, so a site tool reusing one of
// these paths would make Connect fail on that site. Keep in sync.
export const BASE_TOOL_PATHS = new Set([
    '/eval', '/page_info', '/dom_query', '/click', '/fill', '/wait_for', '/navigate', '/scroll',
    '/get_text', '/get_html', '/screenshot', '/tabs_list', '/tabs_switch', '/console_recent',
    '/configure_keybind', '/list_keybinds', '/save_site_profile',
])

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type Method = typeof METHODS[number]

/** Special host for the fallback profile used when no site-specific one exists. */
export const GENERIC_HOST = '*'

export const LIMITS = {
    /** Whole request body (bytes). The largest bundled profile (reddit.com) is ~40 KB. */
    bodyBytes: 256 * 1024,
    notesBytes: 16 * 1024,
    maxTools: 50,
    pathChars: 128,
    descriptionBytes: 4 * 1024,
    inputSchemaBytes: 16 * 1024,
    codeBytes: 32 * 1024,
    extVersionChars: 32,
    userAgentChars: 512,
    hostChars: 253,
} as const

export interface ToolDef {
    method: Method
    path: string
    description: string
    input_schema: Record<string, unknown> | null
    code: string
}

/** Canonical profile shape stored in submissions.payload. */
export interface Profile {
    host: string
    notes: string
    tools: ToolDef[]
}

export interface Issue {
    path: string
    message: string
}

const utf8 = new TextEncoder()
export const byteLength = (s: string) => utf8.encode(s).length

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * Lowercases and trims a hostname. Returns null if it isn't a public DNS name
 * (no ports, IPs, localhost, single labels, or userinfo). `*` is the generic profile.
 */
export function normalizeHost(input: unknown): string | null {
    if (typeof input !== 'string') return null
    let h = input.trim().toLowerCase()
    if (h === GENERIC_HOST) return h
    if (h.endsWith('.')) h = h.slice(0, -1)
    if (!h || h.length > LIMITS.hostChars) return null
    const labels = h.split('.')
    if (labels.length < 2) return null
    if (!labels.every(l => LABEL_RE.test(l))) return null
    if (!TLD_RE.test(labels[labels.length - 1])) return null
    return h
}

/** Returns a reason string if the path can't be used by a site tool, else null. */
export function toolPathProblem(path: string): string | null {
    if (path.length > LIMITS.pathChars) return `path longer than ${LIMITS.pathChars} chars`
    if (!TOOL_PATH_RE.test(path)) return 'path must match ^/[a-zA-Z0-9_\\-/.]+$'
    const lower = path.toLowerCase()
    if (RESERVED_PATHS.has(path) || path.startsWith(`/${RESERVED_PREFIX}`)
        || lower === '/agents.md' || lower.startsWith('/agents.md/')
        || lower === '/tools.json' || lower.startsWith('/tools.json/')) {
        return 'path is reserved by the relay'
    }
    if (BASE_TOOL_PATHS.has(path)) return 'path collides with a built-in extension tool'
    return null
}

const TOP_KEYS = new Set(['host', 'notes', 'tools', 'ext_version'])
const TOOL_KEYS = new Set(['method', 'path', 'description', 'input_schema', 'code'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface ParsedSubmission {
    profile: Profile
    extVersion: string | null
}

/**
 * Strictly validates an untrusted submission body. Unknown keys are rejected
 * so typos (e.g. `inputSchema`) surface instead of silently dropping data.
 */
export function parseSubmission(body: unknown): {ok: true, value: ParsedSubmission} | {ok: false, issues: Issue[]} {
    const issues: Issue[] = []
    if (!isPlainObject(body)) return {ok: false, issues: [{path: '', message: 'body must be a JSON object'}]}

    for (const k of Object.keys(body)) if (!TOP_KEYS.has(k)) issues.push({path: k, message: 'unknown field'})

    const host = normalizeHost(body.host)
    if (!host) issues.push({path: 'host', message: 'must be a public hostname like "example.com" (no scheme, port or path)'})

    let notes = ''
    if (body.notes !== undefined && body.notes !== null) {
        if (typeof body.notes !== 'string') issues.push({path: 'notes', message: 'must be a string'})
        else if (byteLength(body.notes) > LIMITS.notesBytes) issues.push({path: 'notes', message: `longer than ${LIMITS.notesBytes} bytes`})
        else notes = body.notes.replace(/\r\n/g, '\n')
    }

    let extVersion: string | null = null
    if (body.ext_version !== undefined && body.ext_version !== null) {
        if (typeof body.ext_version !== 'string' || !/^[0-9A-Za-z.+_-]{1,32}$/.test(body.ext_version)) {
            issues.push({path: 'ext_version', message: 'must be a short version string'})
        } else extVersion = body.ext_version
    }

    const tools: ToolDef[] = []
    if (!Array.isArray(body.tools)) {
        issues.push({path: 'tools', message: 'must be an array'})
    } else if (body.tools.length > LIMITS.maxTools) {
        issues.push({path: 'tools', message: `at most ${LIMITS.maxTools} tools`})
    } else {
        const seen = new Set<string>()
        body.tools.forEach((t, i) => {
            const p = `tools[${i}]`
            if (!isPlainObject(t)) { issues.push({path: p, message: 'must be an object'}); return }
            for (const k of Object.keys(t)) if (!TOOL_KEYS.has(k)) issues.push({path: `${p}.${k}`, message: 'unknown field'})

            let method: Method = 'POST'
            if (t.method !== undefined && t.method !== null) {
                const m = typeof t.method === 'string' ? t.method.toUpperCase() : ''
                if (!(METHODS as readonly string[]).includes(m)) issues.push({path: `${p}.method`, message: `must be one of ${METHODS.join(', ')}`})
                else method = m as Method
            }

            let path = ''
            if (typeof t.path !== 'string') issues.push({path: `${p}.path`, message: 'required string'})
            else {
                const problem = toolPathProblem(t.path)
                if (problem) issues.push({path: `${p}.path`, message: `${problem}: ${JSON.stringify(t.path.slice(0, 140))}`})
                else path = t.path
            }
            if (path) {
                const key = `${method} ${path}`
                if (seen.has(key)) issues.push({path: `${p}.path`, message: `duplicate tool ${key}`})
                seen.add(key)
            }

            let description = ''
            if (typeof t.description !== 'string' || !t.description.trim()) issues.push({path: `${p}.description`, message: 'required non-empty string'})
            else if (byteLength(t.description) > LIMITS.descriptionBytes) issues.push({path: `${p}.description`, message: `longer than ${LIMITS.descriptionBytes} bytes`})
            else description = t.description

            let inputSchema: Record<string, unknown> | null = null
            if (t.input_schema !== undefined && t.input_schema !== null) {
                if (!isPlainObject(t.input_schema)) issues.push({path: `${p}.input_schema`, message: 'must be a JSON Schema object'})
                else if (byteLength(JSON.stringify(t.input_schema)) > LIMITS.inputSchemaBytes) issues.push({path: `${p}.input_schema`, message: `larger than ${LIMITS.inputSchemaBytes} bytes`})
                else inputSchema = t.input_schema
            }

            let code = ''
            if (typeof t.code !== 'string' || !t.code.trim()) issues.push({path: `${p}.code`, message: 'required non-empty string (JS function body)'})
            else if (byteLength(t.code) > LIMITS.codeBytes) issues.push({path: `${p}.code`, message: `longer than ${LIMITS.codeBytes} bytes`})
            else code = t.code.replace(/\r\n/g, '\n')

            tools.push({method, path, description, input_schema: inputSchema, code})
        })
    }

    if (issues.length || !host) return {ok: false, issues}
    return {ok: true, value: {profile: {host, notes, tools}, extVersion}}
}
