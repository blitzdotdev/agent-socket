// Token + session-id generation. Format defined in design doc §6:
//   session-id: 8 chars Crockford base32 (no I/L/O/U)
//   verifier:   16 random bytes encoded as 22 chars base64url
//   agent-token: as_<sessionId>_<verifier>
//
// What a session keeps in Durable Object storage is derived so that a copy of
// that storage can't be used on its own (see relay-do.ts "Storage layout"):
//   - each token as the SHA-256 of its verifier (enough to check a request)
//     plus the full token sealed with AES-256-GCM (only `list` needs it back);
//   - the resume secret as an HKDF-derived check value, never the secret.
// The sealing key is derived from the resume secret too, so only the app that
// holds the secret (and the relay while that app is connected) can unseal.
//
// node:crypto (nodejs_compat) rather than crypto.subtle: these run inside
// frame handlers, and keeping them synchronous keeps frame handling in order.

import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto"

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

export interface ResumeKeys {
  /** Stored in place of the secret; a presented secret must derive the same value. */
  check: string
  /** Seals the session's tokens. Lives with the app's open socket, never in storage. */
  tokenKey: string
}

/** Derive the stored check value and the token-sealing key from a resume secret. */
export function deriveResumeKeys(secret: string): ResumeKeys {
  const ikm = new TextEncoder().encode(secret)
  const derive = (info: string) => base64url(new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), info, 32)))
  return { check: derive("agent-socket/v1/resume-check"), tokenKey: derive("agent-socket/v1/token-seal") }
}

/**
 * Constant-time check of a presented resume secret against the stored check
 * value. Returns the derived keys on a match, null otherwise.
 */
export function matchResumeSecret(presented: unknown, check: string): ResumeKeys | null {
  if (typeof presented !== "string" || !RESUME_SECRET_RE.test(presented)) return null
  const keys = deriveResumeKeys(presented)
  const enc = new TextEncoder()
  const a = enc.encode(keys.check)
  const b = enc.encode(check)
  // Both are 43 ASCII bytes; timingSafeEqual throws on a length mismatch.
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b) ? keys : null
}

/** Storage id of a token: base64url SHA-256 of its verifier (43 chars). */
export function verifierId(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest())
}

/** AES-256-GCM seal of a token under the session's token key: base64url(iv | ciphertext | tag). */
export function sealToken(token: string, tokenKey: string): string {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const c = createCipheriv("aes-256-gcm", fromBase64url(tokenKey), iv)
  return base64url(concat(iv, c.update(new TextEncoder().encode(token)), c.final(), c.getAuthTag()))
}

/** Inverse of sealToken; null if the key is wrong or the value was tampered with. */
export function openToken(sealed: string, tokenKey: string): string | null {
  try {
    const raw = fromBase64url(sealed)
    if (raw.byteLength < 12 + 16) return null
    const d = createDecipheriv("aes-256-gcm", fromBase64url(tokenKey), raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(raw.byteLength - 16))
    return new TextDecoder().decode(concat(d.update(raw.subarray(12, raw.byteLength - 16)), d.final()))
  } catch {
    return null
  }
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

function fromBase64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.byteLength }
  return out
}
