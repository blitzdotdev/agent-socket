import type {Profile} from './rules'

/** JSON.stringify with object keys sorted recursively, so equal data hashes equally. */
export function canonicalJson(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(s: string): Promise<string> {
    return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Hash identifying a profile's content (host + notes + ordered tools). */
export function profileHash(p: Profile): Promise<string> {
    return sha256Hex(canonicalJson({host: p.host, notes: p.notes, tools: p.tools}))
}

/** HMAC-SHA256(secret, ip), truncated. The raw IP is never stored. */
export async function hashIp(secret: string, ip: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
    return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip))).slice(0, 32)
}
