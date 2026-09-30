import { and, eq, gt, lt, ne } from "drizzle-orm"
import { cookies } from "next/headers"
import { db } from "@/lib/db"
import { appSessions, technicianProfiles, type TechnicianProfile } from "@/lib/db/schema"
import { generateToken, sha256 } from "./crypto"
import { isSessionLive, sessionExpiry, type SessionKind } from "./session-policy"

export const SESSION_COOKIE = "gb_session"

export type { SessionKind } from "./session-policy"

export type CurrentSession =
  | { kind: "technician"; profile: TechnicianProfile; expiresAt: Date }
  | { kind: "admin"; expiresAt: Date }

async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // The v0 preview renders inside a cross-site iframe; SameSite=None+Secure keeps the cookie.
    sameSite: "none",
    secure: true,
    path: "/",
    // Cookie and database row share one expiry (see session-policy.ts), so neither layer logs
    // the admin out before the other: 180 days for the admin, technician rules unchanged.
    expires: expiresAt,
  })
}

export async function createSession(kind: SessionKind, profileId: number | null, remember = false): Promise<void> {
  const token = generateToken()
  const expiresAt = sessionExpiry(kind, remember, new Date())

  await db.insert(appSessions).values({ tokenHash: sha256(token), kind, profileId, expiresAt })
  await setSessionCookie(token, expiresAt)

  // Opportunistic cleanup of expired sessions.
  await db.delete(appSessions).where(lt(appSessions.expiresAt, new Date()))
}

/** Explicit Sign Out: the row goes first, so the token is dead even if the cookie lingers. */
export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) {
    await db.delete(appSessions).where(eq(appSessions.tokenHash, sha256(token)))
  }
  jar.delete(SESSION_COOKIE)
}

/**
 * Security revocation after a password change: every admin session except the one making the
 * change is deleted, so an old phone or browser must sign in with the new password.
 */
export async function revokeOtherAdminSessions(): Promise<number> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const keep = token ? sha256(token) : null
  const deleted = await db
    .delete(appSessions)
    .where(keep ? and(eq(appSessions.kind, "admin"), ne(appSessions.tokenHash, keep)) : eq(appSessions.kind, "admin"))
    .returning({ id: appSessions.id })
  return deleted.length
}

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null

  const now = new Date()
  const rows = await db
    .select()
    .from(appSessions)
    .where(and(eq(appSessions.tokenHash, sha256(token)), gt(appSessions.expiresAt, now)))
    .limit(1)
  const session = rows[0]
  if (!session || !isSessionLive(session.expiresAt, now)) return null

  if (session.kind === "admin") {
    return { kind: "admin", expiresAt: session.expiresAt }
  }

  if (session.profileId == null) return null
  const profiles = await db
    .select()
    .from(technicianProfiles)
    .where(eq(technicianProfiles.id, session.profileId))
    .limit(1)
  const profile = profiles[0]
  if (!profile || !profile.active) return null
  return { kind: "technician", profile, expiresAt: session.expiresAt }
}

export async function requireTechnician(): Promise<TechnicianProfile> {
  const session = await getCurrentSession()
  if (!session || session.kind !== "technician") throw new Error("Unauthorized")
  return session.profile
}

export async function requireAdmin(): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.kind !== "admin") throw new Error("Unauthorized")
}

export async function isAdmin(): Promise<boolean> {
  const session = await getCurrentSession()
  return session?.kind === "admin"
}
