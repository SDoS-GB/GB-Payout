"use server"

import { verifyTechnicianPin } from "@/lib/payout/profiles"
import { createSession, destroySession } from "@/lib/security/session"
import { getAdminSettings, saveAdminSettings } from "@/lib/settings"
import { hashSecret, verifySecret } from "@/lib/security/crypto"

export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Verifies the technician PIN on the server and opens a session. The manual
 * calculator does not depend on this call succeeding; it only unlocks the
 * technician's Workiz payout history.
 */
export async function signInTechnician(name: string, pin: string, remember: boolean): Promise<ActionResult> {
  if (typeof name !== "string" || typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) {
    return { ok: false, error: "Invalid credentials" }
  }
  const profile = await verifyTechnicianPin(name, pin)
  if (!profile) return { ok: false, error: "Invalid credentials" }
  await createSession("technician", profile.id, remember)
  return { ok: true }
}

export async function signOutSession(): Promise<ActionResult> {
  await destroySession()
  return { ok: true }
}

const MIN_ADMIN_PASSWORD = 10

/**
 * Admin login. Until an admin password is set (first run), the ADMIN_SETUP_PASSWORD
 * environment variable acts as a bootstrap credential and the supplied password
 * becomes the stored admin password.
 */
export async function signInAdmin(password: string): Promise<ActionResult> {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "Password required" }
  }
  const admin = await getAdminSettings()

  if (admin.passwordHash) {
    if (!verifySecret(password, admin.passwordHash)) return { ok: false, error: "Invalid password" }
    await createSession("admin", null)
    return { ok: true }
  }

  const bootstrap = process.env.ADMIN_SETUP_PASSWORD
  if (!bootstrap) {
    return { ok: false, error: "Admin password is not configured. Set ADMIN_SETUP_PASSWORD to bootstrap." }
  }
  if (password !== bootstrap) return { ok: false, error: "Invalid password" }
  if (password.length < MIN_ADMIN_PASSWORD) {
    return { ok: false, error: `Bootstrap password must be at least ${MIN_ADMIN_PASSWORD} characters` }
  }
  await saveAdminSettings({ passwordHash: hashSecret(password) }, "bootstrap")
  await createSession("admin", null)
  return { ok: true }
}
