import {Hono, type Context} from 'hono'
import {cors} from 'hono/cors'
import type {$Env} from 'teenybase/worker'
import {LIMITS, normalizeHost, parseSubmission} from './rules'
import {createSubmission, getTools, listPublishedSites, recordUse, resolvePublishedSite, searchSites} from './store'
import {hashIp} from './hash'

export type Env = $Env & {Bindings: CloudflareBindings}

export const api = new Hono<Env>()

// Public, read-mostly JSON API: any origin, no credentials.
api.use('*', cors({origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'], maxAge: 86400}))

function err(c: Context<Env>, status: number, code: string, message: string, extra?: Record<string, unknown>) {
    return c.json({error: {code, message, ...extra}}, status as 400)
}

/** Positive integer env var with a default. */
function envInt(v: string | undefined, def: number) {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : def
}

api.get('/sites', async (c) => {
    const rows = await listPublishedSites(c.get('$db'))
    c.header('Cache-Control', 'public, max-age=60')
    return c.json({sites: rows.map(r => ({host: r.host, version: r.version, tool_count: r.tool_count, updated: r.updated, aliases: r.aliases ? r.aliases.split(',') : []}))})
})

api.get('/sites/:host', async (c) => {
    const requested = normalizeHost(decodeURIComponent(c.req.param('host')))
    if (!requested) return err(c, 400, 'invalid_host', 'host must be a hostname like "example.com", or "*" for the generic profile')
    const db = c.get('$db')
    const found = await resolvePublishedSite(db, requested)
    if (!found) return err(c, 404, 'not_found', `no approved profile for ${requested}`)
    const {site} = found
    const tools = await getTools(db, site.id, site.version, false)
    c.executionCtx.waitUntil(recordUse(db, site.id).catch(e => console.error('recordUse failed', e)))
    c.header('Cache-Control', 'public, max-age=60')
    return c.json({
        host: site.host,
        requested_host: requested,
        version: site.version,
        updated: site.updated,
        notes: site.notes,
        tools: tools.map(t => ({
            method: t.method,
            path: t.path,
            description: t.description,
            ...(t.input_schema ? {input_schema: t.input_schema} : {}),
            code: t.code,
        })),
    })
})

api.get('/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (q.length < 2 || q.length > 200) return err(c, 400, 'invalid_query', 'q must be 2-200 characters')
    const limit = Math.min(envInt(c.req.query('limit'), 20), 50)
    const results = await searchSites(c.get('$db'), q, limit)
    c.header('Cache-Control', 'public, max-age=60')
    return c.json({query: q, results})
})

/** Reads the body with a hard byte cap (Content-Length can be absent or wrong). */
async function readCapped(req: Request, cap: number): Promise<string | null> {
    const len = Number(req.headers.get('content-length') ?? NaN)
    if (Number.isFinite(len) && len > cap) return null
    if (!req.body) return ''
    const reader = req.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const {done, value} = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > cap) { await reader.cancel(); return null }
        chunks.push(value)
    }
    const buf = new Uint8Array(total)
    let o = 0
    for (const ch of chunks) { buf.set(ch, o); o += ch.byteLength }
    return new TextDecoder().decode(buf)
}

api.post('/submissions', async (c) => {
    const env = c.env
    if (!env.IP_HASH_SECRET) {
        console.error('IP_HASH_SECRET is not set')
        return err(c, 500, 'server_misconfigured', 'submissions are temporarily unavailable')
    }
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const ipHash = await hashIp(env.IP_HASH_SECRET, ip)

    // Burst limit first: cheapest check, before reading/parsing anything.
    if (env.SUBMIT_LIMITER) {
        const {success} = await env.SUBMIT_LIMITER.limit({key: `submit:${ipHash}`})
        if (!success) return err(c, 429, 'rate_limited', 'too many submissions, slow down')
    }

    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
        return err(c, 415, 'unsupported_media_type', 'send Content-Type: application/json')
    }
    const raw = await readCapped(c.req.raw, LIMITS.bodyBytes)
    if (raw === null) return err(c, 413, 'payload_too_large', `body larger than ${LIMITS.bodyBytes} bytes`)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return err(c, 400, 'invalid_json', 'body is not valid JSON') }

    const parsed = parseSubmission(body)
    if (!parsed.ok) return err(c, 400, 'invalid_submission', 'submission failed validation', {issues: parsed.issues.slice(0, 50)})
    if (!parsed.value.profile.tools.length && !parsed.value.profile.notes.trim()) {
        return err(c, 400, 'invalid_submission', 'empty profile', {issues: [{path: '', message: 'notes or tools required'}]})
    }

    const res = await createSubmission(c.get('$db'), parsed.value.profile, {
        source: 'api',
        ipHash,
        userAgent: (c.req.header('User-Agent') ?? '').slice(0, LIMITS.userAgentChars) || null,
        extVersion: parsed.value.extVersion,
    }, {
        perIpPerDay: envInt(env.SUBMISSIONS_PER_IP_PER_DAY, 20),
        maxPending: envInt(env.MAX_PENDING_SUBMISSIONS, 500),
    })
    if (!res.ok) {
        const status = res.code === 'no_changes' ? 409 : res.code === 'rate_limited' ? 429 : 503
        return err(c, status, res.code, res.message)
    }
    return c.json({id: res.id, status: 'pending', ...(res.duplicate ? {duplicate: true} : {})}, res.duplicate ? 200 : 201)
})

api.notFound((c) => err(c, 404, 'not_found', 'no such endpoint'))
