import {describe, expect, test} from 'vitest'
import {adminPost, call, freshIp, postJson, publish, sql, submit, tool} from './helpers'

const json = async (r: Response) => r.json() as Promise<any>

describe('GET /v1/sites/:host', () => {
    test('returns the approved notes + tools', async () => {
        await publish({host: 'example.com', notes: 'Example notes', tools: [tool('/ex_a'), tool('/ex_b', {method: 'GET'})]})
        const res = await call('/v1/sites/example.com')
        expect(res.status).toBe(200)
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
        const body = await json(res)
        expect(body).toMatchObject({host: 'example.com', requested_host: 'example.com', version: 1, notes: 'Example notes'})
        expect(body.tools.map((t: any) => `${t.method} ${t.path}`)).toEqual(['POST /ex_a', 'GET /ex_b'])
        expect(body.tools[0]).toEqual({method: 'POST', path: '/ex_a', description: 'Tool /ex_a', input_schema: {type: 'object', properties: {}}, code: 'return { ok: true, path: "/ex_a" }'})
    })

    test('resolves aliases and www.', async () => {
        await publish({host: 'x.com', notes: 'X', tools: [tool('/x_me')]})
        expect((await adminPost('/admin/sites/x.com/aliases', {alias: 'twitter.com'})).status).toBe(303)
        const viaAlias = await json(await call('/v1/sites/twitter.com'))
        expect(viaAlias).toMatchObject({host: 'x.com', requested_host: 'twitter.com'})
        expect(viaAlias.tools[0].path).toBe('/x_me')
        expect(await json(await call('/v1/sites/www.x.com'))).toMatchObject({host: 'x.com'})
        expect(await json(await call('/v1/sites/WWW.Twitter.com'))).toMatchObject({host: 'x.com'})
    })

    test('404 for unknown and unpublished, 400 for invalid host', async () => {
        expect((await call('/v1/sites/nope.example')).status).toBe(404)
        await publish({host: 'gone.example', tools: [tool('/g')]})
        expect((await call('/v1/sites/gone.example')).status).toBe(200)
        await adminPost('/admin/sites/gone.example/unpublish')
        const r = await call('/v1/sites/gone.example')
        expect(r.status).toBe(404)
        expect((await json(r)).error.code).toBe('not_found')
        expect((await call('/v1/sites/not_a_host')).status).toBe(400)
    })

    test('serves the generic "*" profile', async () => {
        await publish({host: '*', notes: 'fallback hints', tools: []})
        expect(await json(await call('/v1/sites/*'))).toMatchObject({host: '*', notes: 'fallback hints', tools: []})
    })

    test('counts uses', async () => {
        await publish({host: 'count.example', tools: [tool('/c')]})
        await call('/v1/sites/count.example')
        await call('/v1/sites/count.example')
        const [row] = await sql('SELECT st.use_count FROM site_stats st JOIN sites s ON s.id = st.site_id WHERE s.host = ?', 'count.example')
        expect(row.use_count).toBe(2)
    })
})

describe('GET /v1/search', () => {
    test('full-text search over hosts, notes, tool paths and descriptions', async () => {
        await publish({host: 'docs.google.com', notes: 'Google Sheets canvas grid; use the name box.', tools: [tool('/sheets_write_range', {description: 'Paste an HTML table into the selection'})]})
        await publish({host: 'news.ycombinator.com', notes: 'Hacker News front page', tools: [tool('/hn_top_stories', {description: 'List the visible stories'})]})

        const byPath = await json(await call('/v1/search?q=sheets'))
        expect(byPath.results.map((r: any) => r.host)).toEqual(['docs.google.com'])
        expect(byPath.results[0]).toMatchObject({version: 1, tool_count: 1, tools: ['/sheets_write_range'], matched_tools: ['/sheets_write_range']})

        expect((await json(await call('/v1/search?q=html%20table'))).results[0].host).toBe('docs.google.com')
        expect((await json(await call('/v1/search?q=hacker'))).results[0].host).toBe('news.ycombinator.com')
        expect((await json(await call('/v1/search?q=ycombinator'))).results[0].host).toBe('news.ycombinator.com')
        // porter stemming: "stories" ~ "story"
        expect((await json(await call('/v1/search?q=story'))).results[0].host).toBe('news.ycombinator.com')
        expect((await json(await call('/v1/search?q=zzzunmatched'))).results).toEqual([])
    })

    test('FTS syntax in the query is inert; unpublished sites are hidden', async () => {
        await publish({host: 'hidden.example', notes: 'secret sauce', tools: [tool('/h')]})
        expect((await json(await call('/v1/search?q=sauce'))).results).toHaveLength(1)
        await adminPost('/admin/sites/hidden.example/unpublish')
        expect((await json(await call('/v1/search?q=sauce'))).results).toEqual([])
        const weird = await call('/v1/search?q=' + encodeURIComponent('"a" OR NEAR(b c) * ^ -'))
        expect(weird.status).toBe(200)
        expect((await call('/v1/search?q=a')).status).toBe(400)
    })

    test('disabled tools drop out of the profile and the index', async () => {
        await publish({host: 'tools.example', tools: [tool('/keep_me'), tool('/drop_me', {description: 'unique zebra words'})]})
        expect((await json(await call('/v1/search?q=zebra'))).results).toHaveLength(1)
        const [t] = await sql(`SELECT id FROM tools WHERE path = '/drop_me'`)
        expect((await adminPost(`/admin/sites/tools.example/tools/${t.id}/disable`)).status).toBe(303)
        const prof = await json(await call('/v1/sites/tools.example'))
        expect(prof.tools.map((x: any) => x.path)).toEqual(['/keep_me'])
        expect((await json(await call('/v1/search?q=zebra'))).results).toEqual([])
    })
})

describe('POST /v1/submissions validation', () => {
    const base = {host: 'valid.example', notes: 'n', tools: [tool('/ok_tool')]}
    const expectInvalid = async (body: unknown, pathRe: RegExp, msgRe?: RegExp) => {
        const res = await submit(body)
        expect(res.status).toBe(400)
        const e = (await json(res)).error
        expect(e.code).toBe('invalid_submission')
        const hit = e.issues.find((i: any) => pathRe.test(i.path))
        expect(hit, JSON.stringify(e.issues)).toBeTruthy()
        if (msgRe) expect(hit.message).toMatch(msgRe)
    }

    test('accepts a valid profile as pending (never auto-approved)', async () => {
        const res = await submit(base)
        expect(res.status).toBe(201)
        const body = await json(res)
        expect(body).toEqual({id: expect.any(String), status: 'pending'})
        const [row] = await sql('SELECT status, kind, source, ip_hash, user_agent FROM submissions WHERE id = ?', body.id)
        expect(row).toMatchObject({status: 'pending', kind: 'new', source: 'api', user_agent: 'vitest'})
        expect(row.ip_hash).toMatch(/^[0-9a-f]{32}$/)
        expect((await call('/v1/sites/valid.example')).status).toBe(404)
    })

    test('rejects bad paths', async () => {
        await expectInvalid({...base, tools: [tool('no_slash')]}, /tools\[0\]\.path/, /must match/)
        await expectInvalid({...base, tools: [tool('/has space')]}, /tools\[0\]\.path/, /must match/)
        await expectInvalid({...base, tools: [tool('/ok'), tool('/ok')]}, /tools\[1\]\.path/, /duplicate/)
    })

    test('rejects reserved paths', async () => {
        for (const p of ['/agents.md', '/tools.json', '/tools.json/x', '/_as_ping', '/eval']) {
            await expectInvalid({...base, tools: [tool(p)]}, /tools\[0\]\.path/, /reserved|built-in/)
        }
    })

    test('rejects oversize notes, code, tool counts and bodies', async () => {
        await expectInvalid({...base, notes: 'x'.repeat(16 * 1024 + 1)}, /^notes$/, /longer/)
        await expectInvalid({...base, tools: [tool('/big', {code: 'x'.repeat(32 * 1024 + 1)})]}, /tools\[0\]\.code/, /longer/)
        await expectInvalid({...base, tools: Array.from({length: 51}, (_, i) => tool(`/t${i}`))}, /^tools$/, /at most 50/)
        const huge = await submit({...base, notes: 'y'.repeat(300 * 1024)})
        expect(huge.status).toBe(413)
        expect((await json(huge)).error.code).toBe('payload_too_large')
    })

    test('rejects bad hosts, unknown fields, non-JSON', async () => {
        await expectInvalid({...base, host: 'https://valid.example/'}, /^host$/)
        await expectInvalid({...base, host: 'localhost'}, /^host$/)
        await expectInvalid({...base, host: '10.0.0.1'}, /^host$/)
        await expectInvalid({...base, status: 'approved'}, /^status$/, /unknown/)
        expect((await submit('{not json')).status).toBe(400)
        const wrongType = await postJson('/v1/submissions', 'x=1', {'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': freshIp()})
        expect(wrongType.status).toBe(415)
    })

    test('dedupes identical pending payloads and refuses no-op updates', async () => {
        const a = await json(await submit(base))
        const b = await submit(base, freshIp())
        expect(b.status).toBe(200)
        expect(await json(b)).toEqual({id: a.id, status: 'pending', duplicate: true})
        expect((await sql(`SELECT count(*) AS n FROM submissions WHERE host = 'valid.example'`))[0].n).toBe(1)

        await adminPost(`/admin/submissions/${a.id}/approve`)
        const same = await submit(base)
        expect(same.status).toBe(409)
        expect((await json(same)).error.code).toBe('no_changes')
    })

    test('burst rate limit (SUBMIT_LIMITER binding, 5/min per IP)', async () => {
        const ip = freshIp()
        const statuses: number[] = []
        for (let i = 0; i < 7; i++) statuses.push((await submit({host: 'bad host'}, ip)).status)
        expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400])
        expect(statuses.slice(5)).toEqual([429, 429])
        // other IPs are unaffected
        expect((await submit({host: 'bad host'}, freshIp())).status).toBe(400)
    })

    test('per-IP daily cap (D1 counter) and queue cap', async () => {
        const ip = freshIp()
        const env = {SUBMISSIONS_PER_IP_PER_DAY: '2'}
        expect((await submit({...base, host: 'cap1.example'}, ip, env)).status).toBe(201)
        expect((await submit({...base, host: 'cap2.example'}, ip, env)).status).toBe(201)
        const third = await submit({...base, host: 'cap3.example'}, ip, env)
        expect(third.status).toBe(429)
        expect((await json(third)).error.message).toMatch(/per day/)

        const full = await submit({...base, host: 'cap4.example'}, freshIp(), {MAX_PENDING_SUBMISSIONS: '2'})
        expect(full.status).toBe(503)
        expect((await json(full)).error.code).toBe('queue_full')
    })

    test('fails closed without IP_HASH_SECRET', async () => {
        const res = await submit(base, freshIp(), {IP_HASH_SECRET: ''})
        expect(res.status).toBe(500)
    })
})

describe('generic teenybase CRUD is locked down', () => {
    test('anonymous cannot read submissions or write sites', async () => {
        await submit({host: 'private.example', tools: [tool('/p')]})
        expect((await call('/api/v1/table/submissions/select')).status).toBe(403)
        expect((await call('/api/v1/table/tools/select')).status).toBe(403)
        const ins = await postJson('/api/v1/table/sites/insert', {values: {id: 'x', host: 'evil.example'}})
        expect(ins.status).toBe(403)
    })
})
