// Cloudflare Access verification for /admin (defense in depth: Access already
// sits in front of /admin; the worker re-checks the JWT Access adds).
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
//
// The `Cf-Access-Jwt-Assertion` header is an RS256 JWT signed by one of the
// keys at https://<team>/cdn-cgi/access/certs. We check signature, `iss`,
// `aud` (the Access application's AUD tag), `exp` and `nbf`.

export interface AccessIdentity {
    /** Email for user logins, or the service token's common_name / client id. */
    who: string
    claims: Record<string, unknown>
}

export type AccessResult = {ok: true, identity: AccessIdentity} | {ok: false, status: 401 | 403 | 500, reason: string}

export interface AccessEnv {
    ACCESS_TEAM_DOMAIN?: string
    ACCESS_AUD?: string
    DEV_BYPASS_ACCESS?: string
}

const CLOCK_SKEW_S = 60
const JWKS_TTL_MS = 10 * 60 * 1000
/** Don't hammer the certs endpoint when a token carries an unknown kid. */
const JWKS_MIN_REFRESH_MS = 30 * 1000

interface Jwk extends JsonWebKey { kid?: string }
type JwksCache = {keys: Map<string, CryptoKey>, fetchedAt: number}
// Per-isolate cache, keyed by certs URL. Holds only public keys.
const jwksCache = new Map<string, JwksCache>()

/** Exposed for tests. */
export function _resetJwksCache() { jwksCache.clear() }

export function normalizeTeamDomain(d: string): string {
    return d.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}
function decodeJson(seg: string): Record<string, unknown> | null {
    try {
        const v = JSON.parse(new TextDecoder().decode(b64urlDecode(seg)))
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch { return null }
}

async function loadKeys(certsUrl: string, force: boolean): Promise<Map<string, CryptoKey>> {
    const cached = jwksCache.get(certsUrl)
    const now = Date.now()
    if (cached && (now - cached.fetchedAt < (force ? JWKS_MIN_REFRESH_MS : JWKS_TTL_MS))) return cached.keys
    const res = await fetch(certsUrl, {headers: {accept: 'application/json'}})
    if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`)
    const body = await res.json() as {keys?: Jwk[]}
    const keys = new Map<string, CryptoKey>()
    for (const jwk of body.keys ?? []) {
        if (!jwk.kid || jwk.kty !== 'RSA') continue
        keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']))
    }
    jwksCache.set(certsUrl, {keys, fetchedAt: now})
    return keys
}

/** Dev bypass is only honoured on loopback / *.localhost hosts, so a stray env var can't open prod. */
export function isLocalHostname(hostname: string): boolean {
    const h = hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')
}

export async function verifyAccess(req: Request, env: AccessEnv): Promise<AccessResult> {
    if (env.DEV_BYPASS_ACCESS === '1' && isLocalHostname(new URL(req.url).hostname)) {
        return {ok: true, identity: {who: 'dev-bypass', claims: {}}}
    }
    const team = env.ACCESS_TEAM_DOMAIN ? normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN) : ''
    const aud = env.ACCESS_AUD?.trim() ?? ''
    if (!team || !aud) return {ok: false, status: 500, reason: 'ACCESS_TEAM_DOMAIN / ACCESS_AUD not configured'}

    const token = req.headers.get('Cf-Access-Jwt-Assertion')
    if (!token) return {ok: false, status: 401, reason: 'missing Cf-Access-Jwt-Assertion'}
    const parts = token.split('.')
    if (parts.length !== 3) return {ok: false, status: 401, reason: 'malformed token'}
    const header = decodeJson(parts[0])
    const claims = decodeJson(parts[1])
    if (!header || !claims) return {ok: false, status: 401, reason: 'malformed token'}
    if (header.alg !== 'RS256') return {ok: false, status: 401, reason: 'unexpected alg'}
    const kid = typeof header.kid === 'string' ? header.kid : ''

    const certsUrl = `https://${team}/cdn-cgi/access/certs`
    let key: CryptoKey | undefined
    try {
        key = (await loadKeys(certsUrl, false)).get(kid)
        if (!key) key = (await loadKeys(certsUrl, true)).get(kid) // key rotation
    } catch (e) {
        console.error('access: could not load certs', e)
        return {ok: false, status: 500, reason: 'could not load Access certs'}
    }
    if (!key) return {ok: false, status: 401, reason: 'unknown signing key'}

    let valid = false
    try {
        valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]),
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    } catch { valid = false }
    if (!valid) return {ok: false, status: 401, reason: 'bad signature'}

    const now = Math.floor(Date.now() / 1000)
    if (claims.iss !== `https://${team}`) return {ok: false, status: 403, reason: 'wrong issuer'}
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!auds.includes(aud)) return {ok: false, status: 403, reason: 'wrong audience'}
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) return {ok: false, status: 401, reason: 'token expired'}
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) return {ok: false, status: 401, reason: 'token not yet valid'}

    const who = typeof claims.email === 'string' && claims.email
        ? claims.email
        : typeof claims.common_name === 'string' && claims.common_name
            ? `service:${claims.common_name}`
            : typeof claims.sub === 'string' && claims.sub ? `sub:${claims.sub}` : 'unknown'
    return {ok: true, identity: {who, claims}}
}
