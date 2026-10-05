// Bulk import used by scripts/seed.mjs (POST /admin/api/import). Idempotent:
// identical content that is already live is skipped, an identical pending
// submission is reused instead of duplicated.
import type {$Database} from 'teenybase/worker'
import {normalizeHost, parseSubmission, type Issue} from './rules'
import {profileHash} from './hash'
import {approveSubmission, createSubmission, one, upsertAlias} from './store'

export interface ImportItem {
    host: string
    notes?: string
    tools: unknown[]
    aliases?: string[]
}

export type ImportOutcome =
    | {host: string, result: 'invalid', issues: Issue[]}
    | {host: string, result: 'unchanged'}
    | {host: string, result: 'pending', id: string, existing: boolean}
    | {host: string, result: 'approved', id: string, version: number}
    | {host: string, result: 'error', message: string}

export async function importProfiles(db: $Database<any>, items: ImportItem[], approveHosts: Set<string>, reviewer: string): Promise<ImportOutcome[]> {
    const out: ImportOutcome[] = []
    for (const item of items) {
        const parsed = parseSubmission({host: item.host, notes: item.notes, tools: item.tools})
        if (!parsed.ok) { out.push({host: String(item.host), result: 'invalid', issues: parsed.issues}); continue }
        const profile = parsed.value.profile

        for (const a of item.aliases ?? []) {
            const alias = normalizeHost(a)
            if (alias && alias !== profile.host && alias !== '*') await upsertAlias(db, alias, profile.host)
        }

        const hash = await profileHash(profile)
        const live = await one<{payload_hash: string | null}>(db,
            `SELECT v.payload_hash FROM sites s LEFT JOIN site_versions v ON v.site_id = s.id AND v.version = s.version WHERE s.host = ?`, profile.host)
        if (live?.payload_hash === hash) { out.push({host: profile.host, result: 'unchanged'}); continue }

        const created = await createSubmission(db, profile, {source: 'import', ipHash: null, userAgent: 'seed-import', extVersion: null})
        if (!created.ok) { out.push({host: profile.host, result: 'error', message: created.message}); continue }
        if (!approveHosts.has(profile.host)) { out.push({host: profile.host, result: 'pending', id: created.id, existing: created.duplicate}); continue }

        const approved = await approveSubmission(db, created.id, reviewer, 'imported from bundled chrome-extension/tools-lib')
        out.push(approved.ok
            ? {host: profile.host, result: 'approved', id: created.id, version: approved.version!}
            : {host: profile.host, result: 'error', message: approved.message})
    }
    return out
}
