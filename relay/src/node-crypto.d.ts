// Types for the part of node:crypto the relay uses (nodejs_compat provides the
// module at runtime). @types/node isn't used because its globals clash with
// @cloudflare/workers-types.
declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash
    digest(): Uint8Array
  }
  interface CipherGCM {
    update(data: Uint8Array): Uint8Array
    final(): Uint8Array
    getAuthTag(): Uint8Array
  }
  interface DecipherGCM {
    update(data: Uint8Array): Uint8Array
    final(): Uint8Array
    setAuthTag(tag: Uint8Array): DecipherGCM
  }
  export function createHash(algorithm: "sha256"): Hash
  export function hkdfSync(digest: "sha256", ikm: Uint8Array, salt: Uint8Array, info: string, keylen: number): ArrayBuffer
  export function createCipheriv(algorithm: "aes-256-gcm", key: Uint8Array, iv: Uint8Array): CipherGCM
  export function createDecipheriv(algorithm: "aes-256-gcm", key: Uint8Array, iv: Uint8Array): DecipherGCM
}
