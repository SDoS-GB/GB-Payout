import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

const SCRYPT_KEYLEN = 64

/** Hash a technician PIN or admin password with a per-record salt. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString("hex")
  const derived = scryptSync(secret, salt, SCRYPT_KEYLEN).toString("hex")
  return `scrypt$${salt}$${derived}`
}

export function verifySecret(secret: string, stored: string): boolean {
  const [scheme, salt, derivedHex] = stored.split("$")
  if (scheme !== "scrypt" || !salt || !derivedHex) return false
  const expected = Buffer.from(derivedHex, "hex")
  const actual = scryptSync(secret, salt, SCRYPT_KEYLEN)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Opaque session token returned to the browser; only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url")
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** Constant-time comparison for shared secrets such as webhook and cron tokens. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
