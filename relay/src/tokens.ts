// Token + session-id generation. Format defined in design doc §6:
//   session-id: 8 chars Crockford base32 (no I/L/O/U)
//   verifier:   16 random bytes encoded as 22 chars base64url
//   agent-token: <prefix>_<sessionId>_<verifier>

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

/** Compose a full agent-token. */
export function makeAgentToken(prefix: string, sessionId: string, verifier: string): string {
  return `${prefix}_${sessionId}_${verifier}`
}

/**
 * Parse a token. Returns null if malformed. Validates prefix matches
 * (caller passes expected prefix); session-id length 8; verifier length 22.
 */
export function parseAgentToken(prefix: string, token: string): { sessionId: string; verifier: string } | null {
  // Validate prefix is regex-safe (caller's responsibility, but double-check).
  if (!/^[a-z0-9]{2,8}$/.test(prefix)) return null

  const re = new RegExp(`^${prefix}_([0-9A-HJKMNP-TV-Z]{8})_([A-Za-z0-9_-]{22})$`)
  const m = re.exec(token)
  if (!m) return null
  return { sessionId: m[1]!, verifier: m[2]! }
}

/** base64url encode raw bytes. */
function base64url(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Validate the TOKEN_PREFIX env var; throws on invalid. */
export function validateTokenPrefix(prefix: string): void {
  if (!/^[a-z0-9]{2,8}$/.test(prefix)) {
    throw new Error(`TOKEN_PREFIX must match /^[a-z0-9]{2,8}$/, got: ${JSON.stringify(prefix)}`)
  }
}
