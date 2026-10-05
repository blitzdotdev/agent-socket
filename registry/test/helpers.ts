import {createExecutionContext, env, waitOnExecutionContext} from 'cloudflare:test'
import worker from '../src/index'

export const PROD = 'https://registry.agentsocket.dev'
export const TEAM = 'test-team.cloudflareaccess.com'
export const AUD = 'test-aud-tag'

let ipCounter = 0
/** A fresh client IP, so the per-IP limits of one test don't leak into another. */
export const freshIp = () => { ipCounter++; return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.7` }

/** Calls the worker directly (lets a test override env vars). */
export async function call(path: string, init: RequestInit = {}, envOverrides: Record<string, unknown> = {}, base = PROD) {
    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request(base + path, init), {...env, ...envOverrides} as any, ctx)
    await waitOnExecutionContext(ctx)
    return res
}

export function postJson(path: string, body: unknown, headers: Record<string, string> = {}, envOverrides: Record<string, unknown> = {}) {
    return call(path, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)}, envOverrides)
}

export function submit(profile: unknown, ip = freshIp(), envOverrides: Record<string, unknown> = {}) {
    return postJson('/v1/submissions', profile, {'CF-Connecting-IP': ip, 'User-Agent': 'vitest'}, envOverrides)
}

export const tool = (path: string, extra: Record<string, unknown> = {}) => ({
    path, description: `Tool ${path}`, input_schema: {type: 'object', properties: {}}, code: `return { ok: true, path: ${JSON.stringify(path)} }`, ...extra,
})

// region admin (dev bypass on localhost)

export const BYPASS = {DEV_BYPASS_ACCESS: '1'}

export function adminGet(path: string) {
    return call(path, {}, BYPASS, 'http://localhost:8795')
}

export function adminPost(path: string, form: Record<string, string> = {}) {
    return call(path, {method: 'POST', body: new URLSearchParams(form), headers: {'Content-Type': 'application/x-www-form-urlencoded'}}, BYPASS, 'http://localhost:8795')
}

/** Submits a profile and approves it via the admin route. Returns the submission id. */
export async function publish(profile: {host: string, notes?: string, tools: unknown[]}) {
    const res = await submit(profile)
    const body = await res.json() as {id: string}
    if (res.status !== 201 && res.status !== 200) throw new Error(`submit failed ${res.status} ${JSON.stringify(body)}`)
    const ap = await adminPost(`/admin/submissions/${body.id}/approve`, {note: 'ok'})
    if (ap.status !== 303 || !(ap.headers.get('Location') ?? '').includes('ok=')) throw new Error(`approve failed ${ap.status} ${ap.headers.get('Location')}`)
    return body.id
}

export async function sql<T = any>(q: string, ...v: unknown[]): Promise<T[]> {
    return (await env.PRIMARY_DB.prepare(q).bind(...v).all<T>()).results
}

// endregion

// region Cloudflare Access test keys

const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
function b64url(bytes: Uint8Array) {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface TestKey { kid: string, privateKey: CryptoKey, jwk: JsonWebKey & {kid: string} }

export async function makeKey(kid: string): Promise<TestKey> {
    const pair = await crypto.subtle.generateKey(
        {name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'},
        true, ['sign', 'verify']) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
    return {kid, privateKey: pair.privateKey, jwk: {...jwk, kid, alg: 'RS256', use: 'sig'}}
}

export async function signJwt(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
    const h = enc({alg: 'RS256', kid: key.kid, typ: 'JWT', ...header})
    const p = enc(claims)
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${h}.${p}`))
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`
}

export function accessClaims(extra: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000)
    return {aud: [AUD], email: 'owner@example.com', iss: `https://${TEAM}`, iat: now, nbf: now, exp: now + 600, sub: 'user-1', type: 'app', ...extra}
}

// endregion
