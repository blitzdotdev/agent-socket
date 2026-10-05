import type {DiffOp, Range} from '../diff'
import {diffStats, hunks, withIntraLine} from '../diff'
import {findRisks, isActionTool, summarize, type RiskHit, type RiskSummary} from '../risk'
import type {ToolChange} from '../compare'
import {prettyJson} from '../compare'
import type {ToolLike} from '../compare'

/**
 * One diff line: risky patterns as <mark>, word-level changes as <span class="wd">.
 * Both are character ranges over the same text, so cut at every boundary.
 */
export function LineText({text, risk, changed}: {text: string, risk: boolean, changed?: Range[]}) {
    const hits: RiskHit[] = risk ? findRisks(text) : []
    if (!hits.length && !changed?.length) return <>{text}</>
    const cuts = new Set([0, text.length])
    for (const h of hits) { cuts.add(h.index); cuts.add(h.index + h.length) }
    for (const [a, b] of changed ?? []) { cuts.add(a); cuts.add(b) }
    const pts = [...cuts].sort((x, y) => x - y)
    const groups: {hit?: RiskHit, parts: any[]}[] = []
    for (let i = 0; i < pts.length - 1; i++) {
        const [p, q] = [pts[i], pts[i + 1]]
        const piece = text.slice(p, q)
        const hit = hits.find(h => h.index <= p && p < h.index + h.length)
        const isChanged = changed?.some(([a, b]) => a <= p && p < b)
        const node = isChanged ? <span class="wd">{piece}</span> : piece
        const last = groups[groups.length - 1]
        if (last && last.hit === hit) last.parts.push(node)
        else groups.push({hit, parts: [node]})
    }
    return <>{groups.map(g => g.hit
        ? <mark class={`risk ${g.hit.rule.severity}`} title={`${g.hit.rule.severity}: ${g.hit.rule.label}`}>{g.parts}</mark>
        : g.parts)}</>
}

export function DiffTable({ops: rawOps, risk = false, context = 3, full = false}: {ops: DiffOp[], risk?: boolean, context?: number, full?: boolean}) {
    if (!rawOps.length) return <div class="empty" style="padding:8px">(empty)</div>
    const ops = withIntraLine(rawOps)
    const {hunks: hs, skippedAfter} = full ? {hunks: [{ops, skippedBefore: 0}], skippedAfter: 0} : hunks(ops, context)
    if (!hs.length) return <div class="sub" style="padding:6px 12px">No changes ({ops.length} lines)</div>
    return <table class="diff">
        <tbody>
        {hs.map(h => <>
            {h.skippedBefore > 0 && <tr class="skip"><td colspan={4}>⋯ {h.skippedBefore} unchanged line{h.skippedBefore === 1 ? '' : 's'}</td></tr>}
            {h.ops.map(o => <tr class={o.type}>
                <td class="ln">{o.a ?? ''}</td>
                <td class="ln">{o.b ?? ''}</td>
                <td class="sg">{o.type === 'add' ? '+' : o.type === 'del' ? '−' : ' '}</td>
                <td class="tx"><LineText text={o.text} risk={risk && o.type !== 'del'} changed={(o as {changed?: Range[]}).changed}/></td>
            </tr>)}
        </>)}
        {skippedAfter > 0 && <tr class="skip"><td colspan={4}>⋯ {skippedAfter} unchanged line{skippedAfter === 1 ? '' : 's'}</td></tr>}
        </tbody>
    </table>
}

export function RiskChips({s, compact = false}: {s: RiskSummary, compact?: boolean}) {
    const none = !s.high && !s.medium && !s.low && !s.actions
    if (none) return <span class="sub">—</span>
    return <span>
        {s.actions && <span class="chip act" title="tool names/descriptions suggest it acts on the user's behalf (post, send, delete...)">acts for user</span>}
        {s.high > 0 && <span class="chip high">{s.high} high</span>}
        {s.medium > 0 && <span class="chip medium">{s.medium} med</span>}
        {!compact && s.low > 0 && <span class="chip low">{s.low} low</span>}
    </span>
}

export function DiffStat({ops}: {ops: DiffOp[]}) {
    const {add, del} = diffStats(ops)
    if (!add && !del) return <span class="sub">no change</span>
    return <span class="mono"><span class="stat-add">+{add}</span> <span class="stat-del">−{del}</span></span>
}

/** "2026-10-05 12:00:00" (UTC, SQLite CURRENT_TIMESTAMP) → relative label with exact title. */
export function When({ts}: {ts: string | null | undefined}) {
    if (!ts) return <span class="sub">—</span>
    const t = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
    if (Number.isNaN(t)) return <span>{ts}</span>
    const s = Math.round((Date.now() - t) / 1000)
    const rel = s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : s < 86400 * 30 ? `${Math.floor(s / 86400)}d ago` : ts.slice(0, 10)
    return <span title={`${ts} UTC`}>{rel}</span>
}

const anchor = (key: string) => 't-' + key.replace(/[^a-zA-Z0-9]+/g, '-')

export function ToolChangeCard({ch}: {ch: ToolChange}) {
    const t = ch.next ?? ch.base!
    const s = summarize([t])
    return <div class="panel tool" id={anchor(ch.key)}>
        <div class="th">
            <span class="method">{t.method}</span>
            <span class="path">{t.path}</span>
            <span class={`badge ${ch.status}`}>{ch.status}</span>
            {ch.base?.disabled && <span class="badge disabled" title="currently unpublished by an admin">disabled now</span>}
            <span class="sp"/>
            <RiskChips s={s}/>
            {ch.status !== 'added' && ch.status !== 'removed' && <span class="sub mono">code <DiffStat ops={ch.code}/></span>}
        </div>
        {ch.method && <div class="sec"><div class="lbl">Method</div><DiffTable ops={ch.method} full/></div>}
        <div class="sec"><div class="lbl">Description</div><DiffTable ops={ch.description} full={ch.status !== 'changed'} context={20}/></div>
        <div class="sec"><div class="lbl">input_schema</div><DiffTable ops={ch.schema} full={ch.status !== 'changed'}/></div>
        <div class="sec"><div class="lbl">Code {isActionTool(t) && <span class="chip act" style="margin-left:6px">acts for user</span>}</div>
            <DiffTable ops={ch.code} risk full={ch.status === 'added'}/></div>
    </div>
}

/** Read-only view of one tool (site pages). */
export function ToolView({t, actions}: {t: ToolLike, actions?: any}) {
    const s = summarize([t])
    const codeOps: DiffOp[] = t.code.split('\n').map((text, i) => ({type: 'eq', text, a: i + 1, b: i + 1}))
    const schema = prettyJson(t.input_schema)
    return <div class="panel tool" id={anchor(`${t.method} ${t.path}`)}>
        <div class="th">
            <span class="method">{t.method}</span>
            <span class="path">{t.path}</span>
            {t.disabled && <span class="badge disabled">disabled</span>}
            <span class="sp"/>
            <RiskChips s={s}/>
            {actions}
        </div>
        <div class="sec"><div class="lbl">Description</div><pre class="notes-pre" style="padding-top:0">{t.description}</pre></div>
        {schema && <div class="sec"><div class="lbl">input_schema</div><pre class="notes-pre" style="padding-top:0">{schema}</pre></div>}
        <div class="sec"><div class="lbl">Code</div><CodeBlock ops={codeOps}/></div>
    </div>
}

function CodeBlock({ops}: {ops: DiffOp[]}) {
    return <table class="diff"><tbody>
        {ops.map(o => <tr><td class="ln">{o.a}</td><td class="tx"><LineText text={o.text} risk/></td></tr>)}
    </tbody></table>
}

export {anchor}
