import {Hono, type Context} from 'hono'
import {raw} from 'hono/html'
import type {$Env} from 'teenybase/worker'
import {verifyAccess} from '../access'
import {compareProfiles, type ProfileLike} from '../compare'
import {summarize} from '../risk'
import {normalizeHost, type Profile} from '../rules'
import {
    addAlias, approveSubmission, getSiteByHost, getSubmission, getTools, listAliases, listAllSites, listSubmissions,
    profileAt, rejectSubmission, removeAlias, setSiteStatus, setToolDisabled, siteHistory, submissionCounts,
    type SiteRow, type SubmissionRow,
} from '../store'
import {importProfiles, type ImportItem} from '../importer'
import {Layout} from './layout'
import {anchor, DiffStat, DiffTable, RiskChips, ToolChangeCard, ToolView, When} from './components'

type AdminEnv = $Env & {Bindings: CloudflareBindings, Variables: $Env['Variables'] & {reviewer: string}}
type C = Context<AdminEnv>

export const admin = new Hono<AdminEnv>()

// region auth + CSRF

admin.use('*', async (c, next) => {
    const res = await verifyAccess(c.req.raw, c.env)
    if (!res.ok) {
        if (res.status === 500) console.error('admin access misconfigured:', res.reason)
        const msg = res.status === 500 ? 'Admin is not configured (Cloudflare Access settings missing).' : 'Not authorized. This area requires Cloudflare Access.'
        return c.req.path.startsWith('/admin/api/')
            ? c.json({error: {code: res.status === 500 ? 'server_misconfigured' : 'unauthorized', message: msg}}, res.status)
            : c.text(msg, res.status)
    }
    // Access' cookie authenticates browsers, so state-changing requests must
    // come from our own pages. Browsers always send Origin on cross-site POSTs;
    // non-browser clients (the seed script) send none.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        const origin = c.req.header('Origin')
        if (origin && origin !== new URL(c.req.url).origin) return c.text('Cross-origin request rejected', 403)
        if (c.req.header('Sec-Fetch-Site') === 'cross-site') return c.text('Cross-site request rejected', 403)
    }
    c.set('reviewer', res.identity.who)
    c.header('Cache-Control', 'no-store')
    c.header('X-Frame-Options', 'DENY')
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    c.header('Referrer-Policy', 'same-origin')
    await next()
})

// endregion

const db = (c: C) => c.get('$db')

function flashFrom(c: C) {
    const ok = c.req.query('ok'), e = c.req.query('err')
    return ok ? {kind: 'ok' as const, text: ok.slice(0, 300)} : e ? {kind: 'err' as const, text: e.slice(0, 300)} : null
}
const back = (c: C, path: string, kind: 'ok' | 'err', text: string) =>
    c.redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`, 303)

async function page(c: C, title: string, nav: 'queue' | 'all' | 'sites' | undefined, body: any) {
    const counts = await submissionCounts(db(c))
    return c.html(<>{raw('<!doctype html>')}<Layout title={title} nav={nav} who={c.get('reviewer')} pending={counts.pending} flash={flashFrom(c)}>{body}</Layout></>)
}

async function formField(c: C, name: string, max = 2000): Promise<string> {
    const body = await c.req.parseBody()
    const v = body[name]
    return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** Live profile of a host (all tools of the current version), or null if the site doesn't exist. */
async function currentProfile(c: C, site: SiteRow | undefined): Promise<ProfileLike | null> {
    if (!site) return null
    return {notes: site.notes, tools: await getTools(db(c), site.id, site.version, true)}
}

admin.get('/', (c) => c.redirect('/admin/submissions?status=pending'))

// region submissions

const STATUSES = ['pending', 'approved', 'rejected', 'all'] as const
const PAGE = 50

admin.get('/submissions', async (c) => {
    const status = (STATUSES as readonly string[]).includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'pending'
    const host = normalizeHost(c.req.query('host') ?? '') ?? ''
    const pageNo = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1)
    const {items, total} = await listSubmissions(db(c), {status: status === 'all' ? undefined : status, host: host || undefined, limit: PAGE, offset: (pageNo - 1) * PAGE})
    const counts = await submissionCounts(db(c))

    // Diff stats vs the live version, per distinct host on this page.
    const live = new Map<string, ProfileLike | null>()
    for (const h of new Set(items.map(i => i.host))) live.set(h, await currentProfile(c, await getSiteByHost(db(c), h)))

    const qs = (s: string) => `/admin/submissions?status=${s}${host ? `&host=${encodeURIComponent(host)}` : ''}`
    const all = counts.pending + counts.approved + counts.rejected
    return page(c, 'Submissions', status === 'pending' ? 'queue' : 'all', <>
        <div class="row">
            <h1>{status === 'pending' ? 'Review queue' : 'Submissions'}</h1>
            <span class="sp"/>
            <form method="get" action="/admin/submissions" class="row" style="gap:6px">
                <input type="hidden" name="status" value={status}/>
                <input type="text" name="host" placeholder="filter by host" value={host} style="width:220px"/>
                <button type="submit">Filter</button>
                {host && <a href={qs(status)}>clear</a>}
            </form>
        </div>
        <div class="tabs">
            {STATUSES.map(s => <a href={qs(s)} class={s === status ? 'on' : ''}>
                {s[0].toUpperCase() + s.slice(1)}<span class="n">{s === 'all' ? all : counts[s]}</span>
            </a>)}
        </div>
        {!items.length ? <div class="panel empty">{status === 'pending' ? 'Nothing to review.' : 'No submissions.'}</div> :
            <table class="list">
                <thead><tr>
                    <th>Host</th><th>Kind</th><th>Status</th><th>Changes vs live</th><th>Risk</th><th>Submitted</th><th>Submitter</th>
                </tr></thead>
                <tbody>
                {items.map(s => <SubmissionRowView s={s} live={live.get(s.host) ?? null}/>)}
                </tbody>
            </table>}
        {total > PAGE && <div class="pager">
            {pageNo > 1 ? <a href={`${qs(status)}&page=${pageNo - 1}`}>← newer</a> : <span/>}
            <span>page {pageNo} of {Math.ceil(total / PAGE)} · {total} total</span>
            {pageNo * PAGE < total ? <a href={`${qs(status)}&page=${pageNo + 1}`}>older →</a> : <span/>}
        </div>}
    </>)
})

function SubmissionRowView({s, live}: {s: SubmissionRow, live: ProfileLike | null}) {
    const p = JSON.parse(s.payload) as Profile
    const cmp = compareProfiles(live, p)
    const risk = summarize(p.tools)
    const href = `/admin/submissions/${s.id}`
    return <tr class="click">
        <td><a class="host" href={href}>{s.host}</a><div class="sub mono" style="font-size:11px">{s.id.slice(0, 10)}</div></td>
        <td><span class={`badge ${live ? 'update' : 'new'}`}>{live ? 'update' : 'new site'}</span></td>
        <td><span class={`badge ${s.status}`}>{s.status}</span>{s.approved_version ? <span class="sub"> v{s.approved_version}</span> : ''}</td>
        <td class="mono" style="font-size:12px">
            {p.tools.length} tools
            {cmp.summary.added > 0 && <span class="stat-add"> +{cmp.summary.added}</span>}
            {cmp.summary.removed > 0 && <span class="stat-del"> −{cmp.summary.removed}</span>}
            {cmp.summary.changed > 0 && <span class="stat-chg"> ~{cmp.summary.changed}</span>}
            {cmp.notesChanged && <span class="sub"> · notes</span>}
            {!cmp.notesChanged && !cmp.summary.added && !cmp.summary.removed && !cmp.summary.changed && <span class="sub"> · same as live</span>}
        </td>
        <td><RiskChips s={risk} compact/></td>
        <td><When ts={s.created}/></td>
        <td class="sub" style="font-size:12px">
            {s.source === 'import' ? 'seed import' : <>
                {s.ext_version ? `ext ${s.ext_version} · ` : ''}
                <span title={s.user_agent ?? ''}>{shortUa(s.user_agent)}</span>
                {s.ip_hash && <span class="mono" title="HMAC of submitter IP"> · {s.ip_hash.slice(0, 8)}</span>}
            </>}
        </td>
    </tr>
}

function shortUa(ua: string | null) {
    if (!ua) return 'no UA'
    const m = ua.match(/(Chrome|Firefox|Safari|Edg|curl|node|python[\w-]*)\/[\d.]+/i)
    return m ? m[0] : ua.slice(0, 24)
}

admin.get('/submissions/:id', async (c) => {
    const s = await getSubmission(db(c), c.req.param('id'))
    if (!s) return c.notFound()
    const p = JSON.parse(s.payload) as Profile
    const site = await getSiteByHost(db(c), s.host)

    // Pending: compare to what's live now. Decided: compare to what it replaced.
    let baseVersion: number | null = null
    if (site) {
        if (s.status === 'pending') baseVersion = site.version
        else if (s.status === 'approved' && s.approved_version) baseVersion = s.approved_version > 1 ? s.approved_version - 1 : null
        else baseVersion = s.base_version || null
    }
    const base = site && baseVersion ? await profileAt(db(c), site, baseVersion) : null
    const cmp = compareProfiles(base, p)
    const risk = summarize(p.tools)
    const stale = s.status === 'pending' && site && site.version !== s.base_version
    const changedTools = cmp.tools.filter(t => t.status !== 'unchanged')
    const unchangedTools = cmp.tools.filter(t => t.status === 'unchanged')

    return page(c, `${s.host} submission`, s.status === 'pending' ? 'queue' : 'all', <>
        <div class="row" style="margin-bottom:4px">
            <a href={`/admin/submissions?status=${s.status}`}>← {s.status === 'pending' ? 'queue' : s.status}</a>
        </div>
        <div class="row">
            <h1>{s.host}</h1>
            <span class={`badge ${base ? 'update' : 'new'}`}>{base ? `update of v${baseVersion}` : 'new site'}</span>
            <span class={`badge ${s.status}`}>{s.status}</span>
            {site && <a href={`/admin/sites/${encodeURIComponent(site.host)}`}>view live site (v{site.version}, {site.status})</a>}
        </div>
        {stale && <div class="warnbox">The site changed since this was submitted (submitted against v{s.base_version}, live is v{site!.version}). The diff below is against the live version; approving replaces it.</div>}
        <div class="grid2" style="margin-top:12px">
            <div>
                <h2 style="margin-top:0">Notes <DiffStat ops={cmp.notes}/></h2>
                <div class="panel"><DiffTable ops={cmp.notes} full={!base} context={4}/></div>

                <h2>Tools <span class="sub" style="font-weight:400">
                    {p.tools.length} proposed ·
                    <span class="stat-add"> {cmp.summary.added} added</span> ·
                    <span class="stat-del"> {cmp.summary.removed} removed</span> ·
                    <span class="stat-chg"> {cmp.summary.changed} changed</span> ·
                    {' '}{cmp.summary.unchanged} unchanged</span></h2>
                {changedTools.map(ch => <ToolChangeCard ch={ch}/>)}
                {unchangedTools.length > 0 && <details style="margin-top:10px">
                    <summary>{unchangedTools.length} unchanged tool{unchangedTools.length === 1 ? '' : 's'}</summary>
                    {unchangedTools.map(ch => <ToolChangeCard ch={ch}/>)}
                </details>}
                {!cmp.tools.length && <div class="panel empty">No tools.</div>}
            </div>
            <aside class="sticky">
                {s.status === 'pending' ? <div class="panel pad">
                    <h3>Review</h3>
                    <form method="post" action={`/admin/submissions/${s.id}/approve`} style="margin-top:10px">
                        <textarea name="note" placeholder="Note (optional)"/>
                        <div class="row" style="margin-top:6px"><button class="approve" type="submit">Approve &amp; publish v{(site?.version ?? 0) + 1}</button></div>
                        {site?.status === 'unpublished' && <p class="sub" style="font-size:12px;margin:6px 0 0">The site is unpublished; the new version stays hidden until you republish it.</p>}
                    </form>
                    <form method="post" action={`/admin/submissions/${s.id}/reject`} style="margin-top:14px">
                        <textarea name="note" placeholder="Reason (required)" required/>
                        <div class="row" style="margin-top:6px"><button class="reject" type="submit">Reject</button></div>
                    </form>
                </div> : <div class="panel pad">
                    <h3>{s.status === 'approved' ? `Approved as v${s.approved_version}` : 'Rejected'}</h3>
                    <dl class="meta" style="margin-top:8px">
                        <dt>by</dt><dd>{s.reviewed_by}</dd>
                        <dt>at</dt><dd><When ts={s.reviewed_at}/></dd>
                        {s.review_note && <><dt>note</dt><dd style="white-space:pre-wrap">{s.review_note}</dd></>}
                    </dl>
                </div>}
                <div class="panel pad" style="margin-top:12px">
                    <h3>Risk</h3>
                    <div style="margin-top:8px"><RiskChips s={risk}/></div>
                    {risk.labels.length > 0 && <ul style="margin:6px 0 0;padding-left:18px;font-size:12px">{risk.labels.map(l => <li>{l}</li>)}</ul>}
                    <p class="sub" style="font-size:11.5px;margin:8px 0 0">Pattern flags are a review aid, not a guarantee. Highlighted in code below.</p>
                </div>
                <div class="panel pad" style="margin-top:12px">
                    <h3>Submission</h3>
                    <dl class="meta" style="margin-top:8px">
                        <dt>id</dt><dd class="mono">{s.id}</dd>
                        <dt>received</dt><dd><When ts={s.created}/> <span class="sub">({s.created} UTC)</span></dd>
                        <dt>source</dt><dd>{s.source}</dd>
                        <dt>base</dt><dd>{s.base_version ? `v${s.base_version}` : 'new site'}</dd>
                        <dt>ext</dt><dd>{s.ext_version ?? '—'}</dd>
                        <dt>UA</dt><dd>{s.user_agent ?? '—'}</dd>
                        <dt>IP hash</dt><dd class="mono">{s.ip_hash ?? '—'}</dd>
                    </dl>
                </div>
                {cmp.tools.length > 0 && <div class="panel pad" style="margin-top:12px">
                    <h3>Jump to</h3>
                    <ul class="toc" style="margin-top:6px">{[...changedTools, ...unchangedTools].map(t => <li>
                        <span class={`badge ${t.status}`} style="font-size:10px">{t.status[0]}</span> <a href={`#${anchor(t.key)}`}>{(t.next ?? t.base)!.path}</a>
                    </li>)}</ul>
                </div>}
            </aside>
        </div>
    </>)
})

admin.post('/submissions/:id/approve', async (c) => {
    const id = c.req.param('id')
    const note = await formField(c, 'note')
    const r = await approveSubmission(db(c), id, c.get('reviewer'), note || null)
    return r.ok ? back(c, `/admin/submissions/${id}`, 'ok', `Approved and published as v${r.version}.`)
        : back(c, `/admin/submissions/${id}`, 'err', r.message)
})

admin.post('/submissions/:id/reject', async (c) => {
    const id = c.req.param('id')
    const note = await formField(c, 'note')
    if (!note) return back(c, `/admin/submissions/${id}`, 'err', 'A rejection reason is required.')
    const r = await rejectSubmission(db(c), id, c.get('reviewer'), note)
    return r.ok ? back(c, `/admin/submissions/${id}`, 'ok', 'Rejected.') : back(c, `/admin/submissions/${id}`, 'err', r.message)
})

// endregion

// region sites

admin.get('/sites', async (c) => {
    const sites = await listAllSites(db(c))
    return page(c, 'Sites', 'sites', <>
        <div class="row"><h1>Sites</h1><span class="sub">{sites.length} total · {sites.filter(s => s.status === 'published').length} published</span></div>
        {!sites.length ? <div class="panel empty" style="margin-top:12px">No approved sites yet.</div> :
            <table class="list" style="margin-top:12px">
                <thead><tr><th>Host</th><th>Status</th><th class="num">Version</th><th class="num">Live tools</th><th>Aliases</th><th class="num">Pending</th><th class="num">Uses</th><th>Updated</th></tr></thead>
                <tbody>{sites.map(s => <tr class="click">
                    <td><a class="host" href={`/admin/sites/${encodeURIComponent(s.host)}`}>{s.host === '*' ? '* (generic fallback)' : s.host}</a></td>
                    <td><span class={`badge ${s.status}`}>{s.status}</span></td>
                    <td class="num">v{s.version}</td>
                    <td class="num">{s.tool_count}{s.disabled_tools > 0 && <span class="stat-del" title="disabled by admin"> (−{s.disabled_tools})</span>}</td>
                    <td class="sub">{s.aliases ?? '—'}</td>
                    <td class="num">{s.pending ? <a href={`/admin/submissions?status=pending&host=${encodeURIComponent(s.host)}`}>{s.pending}</a> : <span class="sub">0</span>}</td>
                    <td class="num">{s.use_count ?? 0}</td>
                    <td><When ts={s.updated}/></td>
                </tr>)}</tbody>
            </table>}
    </>)
})

async function siteOr404(c: C) {
    const host = normalizeHost(decodeURIComponent(c.req.param('host') ?? ''))
    return host ? getSiteByHost(db(c), host) : undefined
}

admin.get('/sites/:host', async (c) => {
    const site = await siteOr404(c)
    if (!site) return c.notFound()
    const v = Number.parseInt(c.req.query('v') ?? '', 10)
    const version = Number.isFinite(v) && v > 0 ? v : site.version
    const prof = await profileAt(db(c), site, version)
    if (!prof) return c.notFound()
    const history = await siteHistory(db(c), site.id)
    const aliases = await listAliases(db(c), site.host)
    const isLive = version === site.version
    const enc = encodeURIComponent(site.host)
    return page(c, site.host, 'sites', <>
        <div class="row" style="margin-bottom:4px"><a href="/admin/sites">← sites</a></div>
        <div class="row">
            <h1>{site.host}</h1>
            <span class={`badge ${site.status}`}>{site.status}</span>
            <span class="sub">live v{site.version} · viewing v{version}{isLive ? ' (live)' : ''}</span>
            <span class="sp"/>
            <a href={`/v1/sites/${enc}`} class="mono" style="font-size:12px">GET /v1/sites/{site.host}</a>
            <form method="post" action={`/admin/sites/${enc}/${site.status === 'published' ? 'unpublish' : 'publish'}`} class="inline">
                <button class={site.status === 'published' ? 'danger' : 'approve'} type="submit">{site.status === 'published' ? 'Unpublish site' : 'Publish site'}</button>
            </form>
        </div>
        <div class="grid2" style="margin-top:12px">
            <div>
                <h2 style="margin-top:0">Notes</h2>
                <div class="panel"><pre class="notes-pre">{prof.notes || '(none)'}</pre></div>
                <h2>Tools <span class="sub" style="font-weight:400">{prof.tools.length} in v{version}{isLive ? `, ${prof.tools.filter(t => !t.disabled).length} served` : ''}</span></h2>
                {prof.tools.map(t => <ToolView t={t} actions={isLive && <form method="post" class="inline"
                    action={`/admin/sites/${enc}/tools/${encodeURIComponent(t.id)}/${t.disabled ? 'enable' : 'disable'}`}>
                    <button class={`small ${t.disabled ? '' : 'danger'}`} type="submit">{t.disabled ? 'Re-enable' : 'Unpublish tool'}</button>
                </form>}/>)}
                {!prof.tools.length && <div class="panel empty">No tools.</div>}
            </div>
            <aside class="sticky">
                <div class="panel pad">
                    <h3>History</h3>
                    <table class="list" style="margin-top:8px;border:0">
                        <tbody>{history.map(h => <tr>
                            <td><a href={`/admin/sites/${enc}?v=${h.version}`} style={h.version === version ? 'font-weight:700' : ''}>v{h.version}</a>{h.version === site.version && <span class="sub"> live</span>}</td>
                            <td class="sub"><When ts={h.created}/></td>
                            <td class="num">{h.tool_count} tools</td>
                            <td>{h.version > 1 && <a href={`/admin/sites/${enc}/diff?from=${h.version - 1}&to=${h.version}`}>diff</a>}</td>
                            <td><a href={`/admin/submissions/${h.submission_id}`} title={`approved by ${h.approved_by}`}>sub</a></td>
                        </tr>)}</tbody>
                    </table>
                </div>
                <div class="panel pad" style="margin-top:12px">
                    <h3>Aliases</h3>
                    <p class="sub" style="font-size:12px;margin:4px 0 8px">Hosts that resolve to this profile. <code>www.</code> is stripped automatically.</p>
                    {aliases.map(a => <div class="row" style="justify-content:space-between;margin:3px 0">
                        <code>{a.alias}</code>
                        <form method="post" action={`/admin/sites/${enc}/aliases/${encodeURIComponent(a.alias)}/delete`} class="inline"><button class="small danger" type="submit">remove</button></form>
                    </div>)}
                    {site.host !== '*' && <form method="post" action={`/admin/sites/${enc}/aliases`} class="row" style="gap:6px;margin-top:8px;flex-wrap:nowrap">
                        <input type="text" name="alias" placeholder="twitter.com" required/>
                        <button type="submit">Add</button>
                    </form>}
                </div>
            </aside>
        </div>
    </>)
})

admin.get('/sites/:host/diff', async (c) => {
    const site = await siteOr404(c)
    if (!site) return c.notFound()
    const from = Number.parseInt(c.req.query('from') ?? '', 10), to = Number.parseInt(c.req.query('to') ?? '', 10)
    const a = Number.isFinite(from) ? await profileAt(db(c), site, from) : null
    const b = Number.isFinite(to) ? await profileAt(db(c), site, to) : null
    if (!a || !b) return c.notFound()
    const cmp = compareProfiles(a, b)
    const enc = encodeURIComponent(site.host)
    return page(c, `${site.host} v${from}→v${to}`, 'sites', <>
        <div class="row" style="margin-bottom:4px"><a href={`/admin/sites/${enc}`}>← {site.host}</a></div>
        <h1>{site.host} <span class="sub" style="font-weight:400">v{from} → v{to}</span></h1>
        <h2>Notes <DiffStat ops={cmp.notes}/></h2>
        <div class="panel"><DiffTable ops={cmp.notes}/></div>
        <h2>Tools <span class="sub" style="font-weight:400">+{cmp.summary.added} −{cmp.summary.removed} ~{cmp.summary.changed}</span></h2>
        {cmp.tools.filter(t => t.status !== 'unchanged').map(ch => <ToolChangeCard ch={ch}/>)}
        {!cmp.tools.some(t => t.status !== 'unchanged') && <div class="panel empty">No tool changes.</div>}
    </>)
})

admin.post('/sites/:host/:action{publish|unpublish}', async (c) => {
    const site = await siteOr404(c)
    if (!site) return c.notFound()
    const status = c.req.param('action') === 'publish' ? 'published' : 'unpublished'
    await setSiteStatus(db(c), site.host, status)
    return back(c, `/admin/sites/${encodeURIComponent(site.host)}`, 'ok', `Site ${status}.`)
})

admin.post('/sites/:host/tools/:toolId/:action{enable|disable}', async (c) => {
    const site = await siteOr404(c)
    if (!site) return c.notFound()
    const disabled = c.req.param('action') === 'disable'
    const ok = await setToolDisabled(db(c), site.host, c.req.param('toolId'), disabled)
    return back(c, `/admin/sites/${encodeURIComponent(site.host)}`, ok ? 'ok' : 'err', ok ? `Tool ${disabled ? 'unpublished' : 're-enabled'}.` : 'Tool not found in the live version.')
})

admin.post('/sites/:host/aliases', async (c) => {
    const site = await siteOr404(c)
    if (!site) return c.notFound()
    const alias = normalizeHost(await formField(c, 'alias', 260))
    const path = `/admin/sites/${encodeURIComponent(site.host)}`
    if (!alias) return back(c, path, 'err', 'Alias must be a hostname.')
    const r = await addAlias(db(c), alias, site.host)
    return r.ok ? back(c, path, 'ok', `${alias} now resolves to ${site.host}.`) : back(c, path, 'err', r.message)
})

admin.post('/sites/:host/aliases/:alias/delete', async (c) => {
    const site = await siteOr404(c)
    if (!site) return c.notFound()
    const alias = normalizeHost(decodeURIComponent(c.req.param('alias')))
    const ok = alias ? await removeAlias(db(c), alias) : false
    return back(c, `/admin/sites/${encodeURIComponent(site.host)}`, ok ? 'ok' : 'err', ok ? `Removed alias ${alias}.` : 'Alias not found.')
})

// endregion

// region JSON API (seed import)

admin.post('/api/import', async (c) => {
    let body: {profiles?: ImportItem[], approve_hosts?: string[]}
    try { body = await c.req.json() } catch { return c.json({error: {code: 'invalid_json', message: 'body is not JSON'}}, 400) }
    if (!Array.isArray(body.profiles) || body.profiles.length > 200) return c.json({error: {code: 'invalid_request', message: 'profiles must be an array of at most 200'}}, 400)
    const approve = new Set((body.approve_hosts ?? []).map(h => normalizeHost(h)).filter((h): h is string => !!h))
    const results = await importProfiles(db(c), body.profiles, approve, c.get('reviewer'))
    return c.json({results})
})

// endregion

admin.notFound((c) => c.text('Not found', 404))
