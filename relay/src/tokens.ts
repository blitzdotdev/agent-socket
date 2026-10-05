// Token + session-id generation. Format defined in design doc §6:
//   session-id: 8 chars Crockford base32 (no I/L/O/U)
//   verifier:   16 random bytes encoded as 22 chars base64url
//   agent-token: as_<sessionId>_<verifier>

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  // 32 chars, no I/L/O/U

/** Generate an 8-char Crockford base32 session-id (40 bits of entropy). */
export function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let s = ""
  for (let i = 0; i < 8; i++) {
    s += CROCKFORD_ALPHABET[bytes[i]! % 32]
  }
  return s
}

/** Generate a 22-char base64url verifier (16 random bytes). */
export function generateVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return base64url(bytes)
}

/** Generate a 43-char base64url resume secret (32 random bytes). */
export function generateResumeSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

const RESUME_SECRET_RE = /^[A-Za-z0-9_-]{43}$/

/** Constant-time check of a presented resume secret against the session's. */
export function resumeSecretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || !RESUME_SECRET_RE.test(presented)) return false
  const enc = new TextEncoder()
  const a = enc.encode(presented)
  const b = enc.encode(expected)
  // Both are 43 ASCII bytes here; timingSafeEqual throws on a length mismatch.
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b)
}

/** Compose a full agent-token. */
export function makeAgentToken(sessionId: string, verifier: string): string {
  return `as_${sessionId}_${verifier}`
}

export const SESSION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/
const TOKEN_RE = /^as_([0-9A-HJKMNP-TV-Z]{8})_([A-Za-z0-9_-]{22})$/

/** Parse a token. Returns null if malformed (session-id 8 chars, verifier 22). */
export function parseAgentToken(token: string): { sessionId: string; verifier: string } | null {
  const m = TOKEN_RE.exec(token)
  if (!m) return null
  return { sessionId: m[1]!, verifier: m[2]! }
}

/** base64url encode raw bytes. */
function base64url(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
