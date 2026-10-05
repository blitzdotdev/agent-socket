// Data access for the registry. Reads/writes use teenybase's raw SQL API
// (`rawSQL` / `rawSQLTransaction`, the latter is a single D1 batch = one
// transaction) with bound parameters only. Public search goes through the
// teenybase query builder so the `sites` listRule and FTS (`@@`) apply.
import type {$Database} from 'teenybase/worker'
import {generateUid} from 'teenybase'
import {GENERIC_HOST, type Method, type Profile, type ToolDef} from './rules'
import {profileHash} from './hash'

type DB = $Database<any>
type Stmt = {q: string, v: unknown[]}

export async function all<T = Record<string, any>>(db: DB, q: string, ...v: unknown[]): Promise<T[]> {
    return ((await db.rawSQL<T>({q, v}).run()) ?? []) as T[]
}
export async function one<T = Record<string, any>>(db: DB, q: string, ...v: unknown[]): Promise<T | undefined> {
    return (await all<T>(db, q, ...v))[0]
}
async function tx(db: DB, stmts: Stmt[]) {
    return db.rawSQLTransaction(stmts.map(s => ({q: s.q, v: s.v}))).run()
}

/** Underlying SQLite message of a teenybase D1Error (or any error). */
export function sqlErrorText(e: unknown): string {
    const err = e as {errorMessage?: string, message?: string}
    return String(err?.errorMessage || err?.message || e)
}
const isConstraintError = (e: unknown) => /constraint failed/i.test(sqlErrorText(e))

// region types

export interface SiteRow {
    id: string
    host: string
    notes: string
    version: number
    status: 'published' | 'unpublished'
    tool_count: number
    tool_index: string
    created: string
    updated: string
}

export interface ToolRow {
    id: string
    site_id: string
    version: number
    position: number
    method: Method
    path: string
    description: string
    input_schema: string | null
    code: string
    disabled: number
}

export interface SubmissionRow {
    id: string
    created: string
    updated: string
    host: string
    kind: 'new' | 'update'
    payload: string
    payload_hash: string
    status: 'pending' | 'approved' | 'rejected'
    review_note: string | null
    reviewed_at: string | null
    reviewed_by: string | null
    base_version: number
    approved_version: number | null
    source: 'api' | 'import'
    ip_hash: string | null
    user_agent: string | null
    ext_version: string | null
}

export interface VersionRow {
    id: string
    site_id: string
    version: number
    notes: string
    tool_count: number
    payload_hash: string
    submission_id: string
    approved_by: string
    created: string
}

// endregion

export function toolFromRow(r: ToolRow): ToolDef & {disabled: boolean, id: string} {
    return {
        id: r.id,
        method: r.method,
        path: r.path,
        description: r.description,
        input_schema: r.input_schema ? JSON.parse(r.input_schema) : null,
        code: r.code,
        disabled: !!r.disabled,
    }
}

/** Search text for a site: one "path description" line per live tool. */
export function toolIndex(tools: Pick<ToolDef, 'path' | 'description'>[]): string {
    return tools.map(t => `${t.path} ${t.description}`).join('\n')
}

// region public reads

export async function getSiteByHost(db: DB, host: string): Promise<SiteRow | undefined> {
    return one<SiteRow>(db, 'SELECT * FROM sites WHERE host = ?', host)
}

/**
 * Resolves a requested host to a published site: exact host, then an alias,
 * then the same two lookups with a leading "www." stripped.
 * An unpublished exact match is treated as absent (no fall-through).
 */
export async function resolvePublishedSite(db: DB, host: string): Promise<{site: SiteRow, resolvedVia: 'host' | 'alias' | 'www'} | null> {
    const candidates: [string, 'host' | 'www'][] = [[host, 'host']]
    if (host.startsWith('www.') && host.split('.').length > 2) candidates.push([host.slice(4), 'www'])
    for (const [h, via] of candidates) {
        const site = await getSiteByHost(db, h)
        if (site) return site.status === 'published' ? {site, resolvedVia: via} : null
        const alias = await one<{host: string}>(db, 'SELECT host FROM site_aliases WHERE alias = ?', h)
        if (alias) {
            const target = await getSiteByHost(db, alias.host)
            return target && target.status === 'published' ? {site: target, resolvedVia: 'alias'} : null
        }
    }
    return null
}

export async function getTools(db: DB, siteId: string, version: number, includeDisabled: boolean) {
    const rows = await all<ToolRow>(db,
        `SELECT * FROM tools WHERE site_id = ? AND version = ?${includeDisabled ? '' : ' AND disabled = 0'} ORDER BY position, path`,
        siteId, version)
    return rows.map(toolFromRow)
}

export async function listPublishedSites(db: DB) {
    return all<{host: string, version: number, tool_count: number, updated: string, aliases: string | null}>(db,
        `SELECT s.host, s.version, s.tool_count, s.updated,
                (SELECT group_concat(a.alias, ',') FROM site_aliases a WHERE a.host = s.host) AS aliases
         FROM sites s WHERE s.status = 'published' ORDER BY s.host`)
}

/** Fire-and-forget use counter (kept outside `sites` so it doesn't touch the FTS index). */
export async function recordUse(db: DB, siteId: string) {
    await all(db, `INSERT INTO site_stats (site_id, use_count, last_used) VALUES (?, 1, CURRENT_TIMESTAMP)
                   ON CONFLICT(site_id) DO UPDATE SET use_count = use_count + 1, last_used = CURRENT_TIMESTAMP`, siteId)
}

const queryWords = (q: string) => (q.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map(w => w.slice(0, 64))

/**
 * Turns free text into a safe FTS5 query: each word becomes a quoted prefix
 * term (so FTS5 operators/syntax in user input are inert), terms are ORed and
 * results are ranked by how many words they match. Null if nothing searchable.
 */
export function ftsQuery(q: string): string | null {
    const words = queryWords(q)
    if (!words.length) return null
    return words.map(w => `"${w}"*`).join(' OR ')
}

export interface SearchResult {
    host: string
    version: number
    tool_count: number
    summary: string
    tools: string[]
    matched_tools: string[]
}

export async function searchSites(db: DB, q: string, limit: number): Promise<SearchResult[]> {
    const match = ftsQuery(q)
    if (!match) return []
    // Goes through the teenybase query builder: `sites @@ ...` compiles to the
    // FTS5 index and the table's listRule restricts to published sites.
    const rows = await db.table('sites').select({
        select: ['host', 'version', 'notes', 'tool_count', 'tool_index'],
        where: `sites @@ ${JSON.stringify(match)}`,
        limit: 100,
    }) as Pick<SiteRow, 'host' | 'version' | 'notes' | 'tool_count' | 'tool_index'>[]
    const words = queryWords(q)
    const scored = rows.map(r => {
        const lines = r.tool_index ? r.tool_index.split('\n') : []
        const paths = lines.map(l => l.split(' ', 1)[0])
        const lower = lines.map(l => l.toLowerCase())
        const notes = r.notes.toLowerCase()
        const matched = lines.filter((_, i) => words.some(w => lower[i].includes(w))).map(l => l.split(' ', 1)[0])
        // teenybase's @@ doesn't expose FTS5 rank (bm25) yet, so rank here:
        // distinct query words covered first, then host hits, then tool hits.
        const covered = words.filter(w => r.host.includes(w) || notes.includes(w) || lower.some(l => l.includes(w))).length
        const hostHits = words.filter(w => r.host.includes(w)).length
        const score = covered * 1000 + hostHits * 100 + matched.length
        const firstLine = r.notes.split('\n').find(l => l.trim()) ?? ''
        return {
            score,
            result: {
                host: r.host,
                version: r.version,
                tool_count: r.tool_count,
                summary: firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine,
                tools: paths,
                matched_tools: matched,
            },
        }
    })
    scored.sort((a, b) => b.score - a.score || a.result.host.localeCompare(b.result.host))
    return scored.slice(0, limit).map(s => s.result)
}

// endregion

// region submissions

export type CreateSubmissionResult =
    | {ok: true, id: string, duplicate: boolean}
    | {ok: false, code: 'no_changes' | 'rate_limited' | 'queue_full', message: string}

export interface SubmitterInfo {
    source: 'api' | 'import'
    ipHash: string | null
    userAgent: string | null
    extVersion: string | null
}

export interface SubmissionLimits {
    perIpPerDay: number
    maxPending: number
}

/** Hash + version currently live for a host (for "no changes" detection and the diff base). */
async function liveVersion(db: DB, host: string) {
    return one<{id: string, version: number, payload_hash: string | null}>(db,
        `SELECT s.id, s.version, v.payload_hash FROM sites s
         LEFT JOIN site_versions v ON v.site_id = s.id AND v.version = s.version
         WHERE s.host = ?`, host)
}

export async function createSubmission(db: DB, profile: Profile, who: SubmitterInfo, limits?: SubmissionLimits): Promise<CreateSubmissionResult> {
    const hash = await profileHash(profile)
    const live = await liveVersion(db, profile.host)
    if (live?.payload_hash === hash) return {ok: false, code: 'no_changes', message: 'identical to the currently approved version'}

    const findPending = () => one<{id: string}>(db, `SELECT id FROM submissions WHERE payload_hash = ? AND status = 'pending'`, hash)
    const dup = await findPending()
    if (dup) return {ok: true, id: dup.id, duplicate: true}

    if (limits) {
        if (who.ipHash) {
            const c = await one<{n: number}>(db,
                `SELECT count(*) AS n FROM submissions WHERE ip_hash = ? AND created > datetime('now', '-1 day')`, who.ipHash)
            if ((c?.n ?? 0) >= limits.perIpPerDay) return {ok: false, code: 'rate_limited', message: `at most ${limits.perIpPerDay} submissions per day`}
        }
        const p = await one<{n: number}>(db, `SELECT count(*) AS n FROM submissions WHERE status = 'pending'`)
        if ((p?.n ?? 0) >= limits.maxPending) return {ok: false, code: 'queue_full', message: 'review queue is full, try again later'}
    }

    const id = generateUid()
    try {
        await all(db,
            `INSERT INTO submissions (id, host, kind, payload, payload_hash, base_version, source, ip_hash, user_agent, ext_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, profile.host, live ? 'update' : 'new', JSON.stringify(profile), hash, live?.version ?? 0,
            who.source, who.ipHash, who.userAgent, who.extVersion)
    } catch (e) {
        // Lost a race with an identical pending submission (partial unique index).
        if (isConstraintError(e)) {
            const again = await findPending()
            if (again) return {ok: true, id: again.id, duplicate: true}
        }
        throw e
    }
    return {ok: true, id, duplicate: false}
}

export async function getSubmission(db: DB, id: string) {
    return one<SubmissionRow>(db, 'SELECT * FROM submissions WHERE id = ?', id)
}

export async function listSubmissions(db: DB, opts: {status?: string, host?: string, limit: number, offset: number}) {
    const where: string[] = []
    const v: unknown[] = []
    if (opts.status) { where.push('status = ?'); v.push(opts.status) }
    if (opts.host) { where.push('host = ?'); v.push(opts.host) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const items = await all<SubmissionRow>(db, `SELECT * FROM submissions ${w} ORDER BY created DESC, id LIMIT ? OFFSET ?`, ...v, opts.limit, opts.offset)
    const total = (await one<{n: number}>(db, `SELECT count(*) AS n FROM submissions ${w}`, ...v))?.n ?? 0
    return {items, total}
}

export async function submissionCounts(db: DB) {
    const rows = await all<{status: string, n: number}>(db, 'SELECT status, count(*) AS n FROM submissions GROUP BY status')
    const out: Record<string, number> = {pending: 0, approved: 0, rejected: 0}
    for (const r of rows) out[r.status] = r.n
    return out
}

export type ReviewResult = {ok: true, version?: number} | {ok: false, code: 'not_found' | 'not_pending' | 'conflict', message: string}

/**
 * Approves a pending submission: publishes it as version N+1 of its site in
 * ONE D1 batch (a transaction). Concurrency guards, all enforced by the schema:
 *  - sites.host UNIQUE: two "new site" approvals for the same host can't both commit;
 *  - site_versions (site_id, version) UNIQUE: two approvals racing on the same base version can't both commit;
 *  - site_versions.submission_id NOT NULL + guarded sub-select: if the submission
 *    stopped being pending (approved/rejected concurrently) the insert gets NULL and the batch aborts.
 */
export async function approveSubmission(db: DB, id: string, reviewer: string, note: string | null): Promise<ReviewResult> {
    const sub = await getSubmission(db, id)
    if (!sub) return {ok: false, code: 'not_found', message: 'submission not found'}
    if (sub.status !== 'pending') return {ok: false, code: 'not_pending', message: `submission is already ${sub.status}`}
    const profile = JSON.parse(sub.payload) as Profile
    const site = await getSiteByHost(db, sub.host)
    const version = (site?.version ?? 0) + 1
    const siteId = site?.id ?? generateUid()
    const index = toolIndex(profile.tools)

    const stmts: Stmt[] = [
        {
            q: `UPDATE submissions SET status = 'approved', kind = ?, approved_version = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, review_note = ?
                WHERE id = ? AND status = 'pending'`,
            v: [site ? 'update' : 'new', version, reviewer, note, id],
        },
        site ? {
            q: `UPDATE sites SET notes = ?, version = ?, tool_count = ?, tool_index = ? WHERE id = ? AND version = ?`,
            v: [profile.notes, version, profile.tools.length, index, siteId, site.version],
        } : {
            q: `INSERT INTO sites (id, host, notes, version, tool_count, tool_index) VALUES (?, ?, ?, ?, ?, ?)`,
            v: [siteId, sub.host, profile.notes, version, profile.tools.length, index],
        },
        {
            q: `INSERT INTO site_versions (id, site_id, version, notes, tool_count, payload_hash, approved_by, submission_id)
                SELECT ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM submissions WHERE id = ? AND status = 'approved' AND approved_version = ?)`,
            v: [generateUid(), siteId, version, profile.notes, profile.tools.length, sub.payload_hash, reviewer, id, version],
        },
        ...profile.tools.map((t, i): Stmt => ({
            q: `INSERT INTO tools (id, site_id, version, position, method, path, description, input_schema, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            v: [generateUid(), siteId, version, i, t.method, t.path, t.description, t.input_schema ? JSON.stringify(t.input_schema) : null, t.code],
        })),
    ]
    try {
        await tx(db, stmts)
    } catch (e) {
        if (isConstraintError(e)) return {ok: false, code: 'conflict', message: 'the site or submission changed concurrently; reload and retry'}
        throw e
    }
    return {ok: true, version}
}

export async function rejectSubmission(db: DB, id: string, reviewer: string, note: string | null): Promise<ReviewResult> {
    const res = await all<{id: string}>(db,
        `UPDATE submissions SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, review_note = ?
         WHERE id = ? AND status = 'pending' RETURNING id`, reviewer, note, id)
    if (res.length) return {ok: true}
    const sub = await getSubmission(db, id)
    if (!sub) return {ok: false, code: 'not_found', message: 'submission not found'}
    return {ok: false, code: 'not_pending', message: `submission is already ${sub.status}`}
}

// endregion

// region admin: sites

export async function listAllSites(db: DB) {
    return all<SiteRow & {use_count: number | null, last_used: string | null, aliases: string | null, pending: number, disabled_tools: number}>(db,
        `SELECT s.*, st.use_count, st.last_used,
                (SELECT group_concat(a.alias, ', ') FROM site_aliases a WHERE a.host = s.host) AS aliases,
                (SELECT count(*) FROM submissions p WHERE p.host = s.host AND p.status = 'pending') AS pending,
                (SELECT count(*) FROM tools t WHERE t.site_id = s.id AND t.version = s.version AND t.disabled = 1) AS disabled_tools
         FROM sites s LEFT JOIN site_stats st ON st.site_id = s.id
         ORDER BY s.host`)
}

export async function siteHistory(db: DB, siteId: string) {
    return all<VersionRow>(db, 'SELECT * FROM site_versions WHERE site_id = ? ORDER BY version DESC', siteId)
}

export async function getVersion(db: DB, siteId: string, version: number) {
    return one<VersionRow>(db, 'SELECT * FROM site_versions WHERE site_id = ? AND version = ?', siteId, version)
}

/** The full profile of a site at a version (all tools, disabled ones flagged). */
export async function profileAt(db: DB, site: SiteRow, version: number) {
    const v = await getVersion(db, site.id, version)
    if (!v) return null
    return {host: site.host, version, notes: v.notes, tools: await getTools(db, site.id, version, true)}
}

export async function setSiteStatus(db: DB, host: string, status: 'published' | 'unpublished') {
    return (await all(db, 'UPDATE sites SET status = ? WHERE host = ? RETURNING id', status, host)).length > 0
}

/** Enables/disables one tool of the live version and refreshes the site's count + search text atomically. */
export async function setToolDisabled(db: DB, host: string, toolId: string, disabled: boolean) {
    const site = await getSiteByHost(db, host)
    if (!site) return false
    const tools = await getTools(db, site.id, site.version, true)
    const target = tools.find(t => t.id === toolId)
    if (!target) return false
    const live = tools.filter(t => (t.id === toolId ? !disabled : !t.disabled))
    await tx(db, [
        {q: 'UPDATE tools SET disabled = ? WHERE id = ? AND site_id = ? AND version = ?', v: [disabled ? 1 : 0, toolId, site.id, site.version]},
        {q: 'UPDATE sites SET tool_count = ?, tool_index = ? WHERE id = ? AND version = ?', v: [live.length, toolIndex(live), site.id, site.version]},
    ])
    return true
}

export async function listAliases(db: DB, host: string) {
    return all<{id: string, alias: string, host: string}>(db, 'SELECT * FROM site_aliases WHERE host = ? ORDER BY alias', host)
}

export type AliasResult = {ok: true} | {ok: false, message: string}

export async function addAlias(db: DB, alias: string, host: string): Promise<AliasResult> {
    if (alias === host) return {ok: false, message: 'alias equals the host'}
    if (alias === GENERIC_HOST || host === GENERIC_HOST) return {ok: false, message: 'the generic profile cannot be aliased'}
    if (await getSiteByHost(db, alias)) return {ok: false, message: `${alias} is itself a site`}
    try {
        await all(db, 'INSERT INTO site_aliases (id, alias, host) VALUES (?, ?, ?)', generateUid(), alias, host)
    } catch (e) {
        if (isConstraintError(e)) return {ok: false, message: `${alias} is already an alias`}
        throw e
    }
    return {ok: true}
}

/** Idempotent: inserts the alias, or re-points an existing one at `host`. */
export async function upsertAlias(db: DB, alias: string, host: string) {
    await all(db, `INSERT INTO site_aliases (id, alias, host) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET host = excluded.host`,
        generateUid(), alias, host)
}

export async function removeAlias(db: DB, alias: string) {
    return (await all(db, 'DELETE FROM site_aliases WHERE alias = ? RETURNING id', alias)).length > 0
}

// endregion
