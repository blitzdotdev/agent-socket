// Line diff (Myers O(ND)) + unified hunks for the admin review page.

export type DiffOp = {type: 'eq' | 'add' | 'del', text: string, a?: number, b?: number}

/** Diffs two line arrays. Falls back to "replace all" if the edit distance explodes. */
export function diffLines(a: string[], b: string[], maxD = 4000): DiffOp[] {
    // Trim common prefix/suffix first: cheap and keeps the core small.
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let endA = a.length, endB = b.length
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }

    const midA = a.slice(start, endA), midB = b.slice(start, endB)
    const core = myers(midA, midB, maxD) ?? [
        ...midA.map((text): Omit<DiffOp, 'a' | 'b'> => ({type: 'del', text})),
        ...midB.map((text): Omit<DiffOp, 'a' | 'b'> => ({type: 'add', text})),
    ]
    const ops: DiffOp[] = []
    let ia = 0, ib = 0
    const push = (type: DiffOp['type'], text: string) => {
        if (type === 'eq') ops.push({type, text, a: ++ia, b: ++ib})
        else if (type === 'del') ops.push({type, text, a: ++ia})
        else ops.push({type, text, b: ++ib})
    }
    for (let i = 0; i < start; i++) push('eq', a[i])
    for (const op of core) push(op.type, op.text)
    for (let i = endA; i < a.length; i++) push('eq', a[i])
    return ops
}

function myers(a: string[], b: string[], maxD: number): Omit<DiffOp, 'a' | 'b'>[] | null {
    const n = a.length, m = b.length
    if (!n) return b.map(text => ({type: 'add' as const, text}))
    if (!m) return a.map(text => ({type: 'del' as const, text}))
    const max = Math.min(n + m, maxD)
    const offset = max + 1
    const v = new Int32Array(2 * max + 3)
    const trace: Int32Array[] = []
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice())
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1
            let y = x - k
            while (x < n && y < m && a[x] === b[y]) { x++; y++ }
            v[offset + k] = x
            if (x >= n && y >= m) return backtrack(trace, a, b, offset, d)
        }
    }
    return null
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, dEnd: number) {
    const out: Omit<DiffOp, 'a' | 'b'>[] = []
    let x = a.length, y = b.length
    for (let d = dEnd; d > 0; d--) {
        const v = trace[d]
        const k = x - y
        const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? k + 1 : k - 1
        const prevX = v[offset + prevK]
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) { out.push({type: 'eq', text: a[x - 1]}); x--; y-- }
        if (x === prevX) out.push({type: 'add', text: b[y - 1]})
        else out.push({type: 'del', text: a[x - 1]})
        x = prevX; y = prevY
    }
    while (x > 0 && y > 0) { out.push({type: 'eq', text: a[x - 1]}); x--; y-- }
    return out.reverse()
}

export type Hunk = {ops: DiffOp[], skippedBefore: number}

/** Groups ops into hunks with `context` unchanged lines around each change. */
export function hunks(ops: DiffOp[], context = 3): {hunks: Hunk[], skippedAfter: number} {
    const changed = ops.map(o => o.type !== 'eq')
    const keep = new Array(ops.length).fill(false)
    changed.forEach((c, i) => {
        if (!c) return
        for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true
    })
    const out: Hunk[] = []
    let skipped = 0
    let cur: Hunk | null = null
    ops.forEach((op, i) => {
        if (keep[i]) {
            if (!cur) { cur = {ops: [], skippedBefore: skipped}; out.push(cur); skipped = 0 }
            cur.ops.push(op)
        } else { cur = null; skipped++ }
    })
    return {hunks: out, skippedAfter: skipped}
}

export const splitLines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'))

export function diffStats(ops: DiffOp[]) {
    let add = 0, del = 0
    for (const o of ops) { if (o.type === 'add') add++; else if (o.type === 'del') del++ }
    return {add, del}
}

export type Range = [start: number, end: number]

const tokenize = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []

/**
 * Word-level changes between two versions of one line, as character ranges
 * in each. Null when the lines share too little for highlighting to help.
 */
export function intraLine(a: string, b: string): {a: Range[], b: Range[]} | null {
    const ta = tokenize(a), tb = tokenize(b)
    if (ta.length * tb.length > 250_000) return null
    const ops = diffLines(ta, tb, 2000)
    const same = ops.filter(o => o.type === 'eq').reduce((n, o) => n + o.text.length, 0)
    if (same < 0.4 * Math.max(a.length, b.length)) return null
    const ra: Range[] = [], rb: Range[] = []
    let pa = 0, pb = 0
    const push = (rs: Range[], s: number, e: number) => {
        const last = rs[rs.length - 1]
        if (last && last[1] === s) last[1] = e; else rs.push([s, e])
    }
    for (const o of ops) {
        if (o.type === 'eq') { pa += o.text.length; pb += o.text.length }
        else if (o.type === 'del') { push(ra, pa, pa + o.text.length); pa += o.text.length }
        else { push(rb, pb, pb + o.text.length); pb += o.text.length }
    }
    return {a: ra, b: rb}
}

/** Annotates runs of deleted lines immediately followed by added lines with word-level ranges. */
export function withIntraLine(ops: DiffOp[]): (DiffOp & {changed?: Range[]})[] {
    const out: (DiffOp & {changed?: Range[]})[] = ops.map(o => ({...o}))
    for (let i = 0; i < out.length;) {
        if (out[i].type !== 'del') { i++; continue }
        let j = i
        while (j < out.length && out[j].type === 'del') j++
        let k = j
        while (k < out.length && out[k].type === 'add') k++
        const pairs = Math.min(j - i, k - j)
        for (let p = 0; p < pairs; p++) {
            const r = intraLine(out[i + p].text, out[j + p].text)
            if (r) { out[i + p].changed = r.a; out[j + p].changed = r.b }
        }
        i = k
    }
    return out
}
