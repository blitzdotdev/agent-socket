#!/usr/bin/env node
// Imports the bundled site profiles (chrome-extension/tools-lib/) into the
// registry via POST /admin/api/import. Idempotent: re-running skips content
// that is already live and reuses identical pending submissions.
//
// By default everything lands as a PENDING submission for review (several
// X/Reddit tools post, reply or send DMs). --approve-trusted additionally
// publishes the low-risk read-mostly profiles directly.
//
// Usage:
//   node scripts/seed.mjs [--url http://localhost:8795] [--approve-trusted] [--dry-run]
// Against a deployed registry, authenticate with a Cloudflare Access service token:
//   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... node scripts/seed.mjs --url https://registry.agentsocket.dev
import {readFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const TRUSTED = ['github.com', 'news.ycombinator.com', 'docs.google.com', '*']

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, def) => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] ? args[i + 1] : def
}
if (flag('--help') || flag('-h')) {
    console.log('usage: node scripts/seed.mjs [--url <registry>] [--approve-trusted] [--dry-run] [--lib <tools-lib dir>]')
    process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const libDir = resolve(opt('--lib', join(here, '..', '..', 'chrome-extension', 'tools-lib')))
const url = opt('--url', 'http://localhost:8795').replace(/\/+$/, '')

const index = JSON.parse(readFileSync(join(libDir, '_index.json'), 'utf8'))
const byFile = new Map()
for (const entry of index.profiles ?? []) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, [])
    byFile.get(entry.file).push(entry.host_match)
}

const profiles = []
for (const [file, hostMatches] of byFile) {
    const p = JSON.parse(readFileSync(join(libDir, file), 'utf8'))
    // Any other host_match pointing at the same file becomes an alias (twitter.com -> x.com).
    const aliases = hostMatches.filter(h => h !== p.host && h !== '*' && !h.startsWith('*.'))
    profiles.push({host: p.host, notes: p.notes ?? '', tools: p.tools ?? [], aliases})
}

const approveHosts = flag('--approve-trusted') ? TRUSTED : []
console.log(`tools-lib: ${libDir}`)
for (const p of profiles) {
    console.log(`  ${p.host.padEnd(22)} ${String(p.tools.length).padStart(2)} tools${p.aliases.length ? `  aliases: ${p.aliases.join(', ')}` : ''}${approveHosts.includes(p.host) ? '  [approve]' : ''}`)
}
if (flag('--dry-run')) process.exit(0)

const headers = {'Content-Type': 'application/json'}
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET
}

const res = await fetch(`${url}/admin/api/import`, {method: 'POST', headers, body: JSON.stringify({profiles, approve_hosts: approveHosts})})
const text = await res.text()
if (!res.ok) {
    console.error(`import failed: HTTP ${res.status}\n${text}`)
    process.exit(1)
}
const {results} = JSON.parse(text)
let failed = false
console.log(`\n${url}`)
for (const r of results) {
    const detail = r.result === 'approved' ? `v${r.version}` : r.result === 'pending' ? (r.existing ? 'already pending' : 'queued for review') : r.result === 'invalid' ? JSON.stringify(r.issues) : r.message ?? ''
    if (r.result === 'invalid' || r.result === 'error') failed = true
    console.log(`  ${r.host.padEnd(22)} ${r.result.padEnd(9)} ${detail}`)
}
process.exit(failed ? 1 : 0)
