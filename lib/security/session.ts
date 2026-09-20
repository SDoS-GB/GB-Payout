import { and, eq, gt, lt } from "drizzle-orm"
import { cookies } from "next/headers"
import { db } from "@/lib/db"
import { appSessions, technicianProfiles, type TechnicianProfile } from "@/lib/db/schema"
import { generateToken, sha256 } from "./crypto"

export const SESSION_COOKIE = "gb_session"

const TECH_SESSION_SHORT_MS = 12 * 60 * 60 * 1000 // 12 hours
const TECH_SESSION_LONG_MS = 30 * 24 * 60 * 60 * 1000 // 30 days ("stay logged in")
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000 // 8 hours

export type SessionKind = "technician" | "admin"

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
    expires: expiresAt,
  })
}

export async function createSession(kind: SessionKind, profileId: number | null, remember = false): Promise<void> {
  const token = generateToken()
  const ttl = kind === "admin" ? ADMIN_SESSION_MS : remember ? TECH_SESSION_LONG_MS : TECH_SESSION_SHORT_MS
  const expiresAt = new Date(Date.now() + ttl)

  await db.insert(appSessions).values({ tokenHash: sha256(token), kind, profileId, expiresAt })
  await setSessionCookie(token, expiresAt)

  // Opportunistic cleanup of expired sessions.
  await db.delete(appSessions).where(lt(appSessions.expiresAt, new Date()))
}

export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) {
    await db.delete(appSessions).where(eq(appSessions.tokenHash, sha256(token)))
  }
  jar.delete(SESSION_COOKIE)
}

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null

  const rows = await db
    .select()
    .from(appSessions)
    .where(and(eq(appSessions.tokenHash, sha256(token)), gt(appSessions.expiresAt, new Date())))
    .limit(1)
  const session = rows[0]
  if (!session) return null

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
