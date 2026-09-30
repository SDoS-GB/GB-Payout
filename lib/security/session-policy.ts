/**
 * How long each kind of sign-in lasts. Pure so the rules can be tested with a simulated clock;
 * `lib/security/session.ts` applies them to the cookie, the database row and the validity check,
 * so no layer can expire earlier than another.
 *
 * - Admin: 180 days from sign-in, always (no "remember me" needed). The owner's phone reopening
 *   the app, restarting, or launching from the Home Screen keeps the same session until then.
 *   Sign Out, a password change (other sessions) or clearing browser data ends it sooner.
 * - Technician: 12 hours, or 30 days when they tick "stay logged in" (unchanged).
 */

export type SessionKind = "technician" | "admin"

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export const ADMIN_SESSION_DAYS = 180
export const ADMIN_SESSION_MS = ADMIN_SESSION_DAYS * DAY_MS
export const TECH_SESSION_SHORT_MS = 12 * HOUR_MS
export const TECH_SESSION_LONG_MS = 30 * DAY_MS

export function sessionTtlMs(kind: SessionKind, remember = false): number {
  if (kind === "admin") return ADMIN_SESSION_MS
  return remember ? TECH_SESSION_LONG_MS : TECH_SESSION_SHORT_MS
}

/** The single expiry instant written to the cookie and the database row. */
export function sessionExpiry(kind: SessionKind, remember: boolean, now: Date): Date {
  return new Date(now.getTime() + sessionTtlMs(kind, remember))
}

/** A session is live strictly before its expiry; at or after it, the user must sign in again. */
export function isSessionLive(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() > now.getTime()
}
