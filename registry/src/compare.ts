import {diffLines, splitLines, type DiffOp} from './diff'
import type {ToolDef} from './rules'

export type ToolLike = ToolDef & {disabled?: boolean, id?: string}
export interface ProfileLike { notes: string, tools: ToolLike[] }

export type ToolChange = {
    key: string
    status: 'added' | 'removed' | 'changed' | 'unchanged'
    base?: ToolLike
    next?: ToolLike
    method: DiffOp[] | null
    description: DiffOp[]
    schema: DiffOp[]
    code: DiffOp[]
}

/** Pretty JSON with sorted keys so key order never shows up as a diff. */
export function prettyJson(v: unknown): string {
    const sort = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(sort)
        if (x && typeof x === 'object') {
            const o = x as Record<string, unknown>
            return Object.fromEntries(Object.keys(o).sort().map(k => [k, sort(o[k])]))
        }
        return x
    }
    return v == null ? '' : JSON.stringify(sort(v), null, 2)
}

const toolKey = (t: Pick<ToolDef, 'method' | 'path'>) => `${t.method} ${t.path}`
const lines = (s: string | undefined) => splitLines(s ?? '')

export function compareProfiles(base: ProfileLike | null, next: ProfileLike) {
    const notes = diffLines(lines(base?.notes), lines(next.notes))
    const baseByKey = new Map((base?.tools ?? []).map(t => [toolKey(t), t]))
    // Same path, different method: pair them up as a change rather than add+remove.
    const baseByPath = new Map((base?.tools ?? []).map(t => [t.path, t]))
    const used = new Set<string>()
    const tools: ToolChange[] = []

    for (const t of next.tools) {
        let b = baseByKey.get(toolKey(t))
        if (!b) {
            const samePath = baseByPath.get(t.path)
            if (samePath && !next.tools.some(o => toolKey(o) === toolKey(samePath))) b = samePath
        }
        if (b) used.add(toolKey(b))
        const description = diffLines(lines(b?.description), lines(t.description))
        const schema = diffLines(lines(prettyJson(b?.input_schema)), lines(prettyJson(t.input_schema)))
        const code = diffLines(lines(b?.code), lines(t.code))
        const methodChanged = !!b && b.method !== t.method
        const changed = methodChanged || [description, schema, code].some(ops => ops.some(o => o.type !== 'eq'))
        tools.push({
            key: toolKey(t),
            status: !b ? 'added' : changed ? 'changed' : 'unchanged',
            base: b, next: t,
            method: methodChanged ? diffLines([b!.method], [t.method]) : null,
            description, schema, code,
        })
    }
    for (const b of base?.tools ?? []) {
        if (used.has(toolKey(b))) continue
        tools.push({
            key: toolKey(b), status: 'removed', base: b,
            method: null,
            description: diffLines(lines(b.description), []),
            schema: diffLines(lines(prettyJson(b.input_schema)), []),
            code: diffLines(lines(b.code), []),
        })
    }
    const count = (s: ToolChange['status']) => tools.filter(t => t.status === s).length
    return {
        notes,
        notesChanged: notes.some(o => o.type !== 'eq'),
        tools,
        summary: {added: count('added'), removed: count('removed'), changed: count('changed'), unchanged: count('unchanged')},
    }
}
