import { describe, expect, it } from "vitest"
import { ADMIN_SESSION_DAYS, ADMIN_SESSION_MS, TECH_SESSION_LONG_MS, TECH_SESSION_SHORT_MS, isSessionLive, sessionExpiry, sessionTtlMs } from "@/lib/security/session-policy"

const DAY = 24 * 60 * 60 * 1000
const signIn = new Date("2026-09-30T14:00:00Z")

describe("admin session lifetime (simulated clock)", () => {
  it("is 180 days without any 'remember me' choice", () => {
    expect(ADMIN_SESSION_DAYS).toBe(180)
    expect(sessionTtlMs("admin")).toBe(180 * DAY)
    expect(sessionTtlMs("admin", false)).toBe(ADMIN_SESSION_MS)
    expect(sessionTtlMs("admin", true)).toBe(ADMIN_SESSION_MS)
  })

  it("stays valid across reloads, restarts and reopenings until the 180th day", () => {
    const expiresAt = sessionExpiry("admin", false, signIn)
    expect(expiresAt.toISOString()).toBe("2027-03-29T14:00:00.000Z")
    for (const days of [0, 1, 7, 30, 90, 179]) {
      expect(isSessionLive(expiresAt, new Date(signIn.getTime() + days * DAY))).toBe(true)
    }
    // One second before the deadline the admin is still signed in.
    expect(isSessionLive(expiresAt, new Date(expiresAt.getTime() - 1000))).toBe(true)
  })

  it("requires a fresh login at and after the 180-day mark", () => {
    const expiresAt = sessionExpiry("admin", false, signIn)
    expect(isSessionLive(expiresAt, expiresAt)).toBe(false)
    expect(isSessionLive(expiresAt, new Date(signIn.getTime() + 180 * DAY))).toBe(false)
    expect(isSessionLive(expiresAt, new Date(signIn.getTime() + 181 * DAY))).toBe(false)
    expect(isSessionLive(expiresAt, new Date(signIn.getTime() + 400 * DAY))).toBe(false)
  })
})

describe("technician sessions are unchanged", () => {
  it("12 hours by default, 30 days with 'stay logged in'", () => {
    expect(sessionTtlMs("technician")).toBe(TECH_SESSION_SHORT_MS)
    expect(TECH_SESSION_SHORT_MS).toBe(12 * 60 * 60 * 1000)
    expect(sessionTtlMs("technician", true)).toBe(TECH_SESSION_LONG_MS)
    expect(TECH_SESSION_LONG_MS).toBe(30 * DAY)
    expect(isSessionLive(sessionExpiry("technician", false, signIn), new Date(signIn.getTime() + 13 * 60 * 60 * 1000))).toBe(false)
    expect(isSessionLive(sessionExpiry("technician", true, signIn), new Date(signIn.getTime() + 29 * DAY))).toBe(true)
  })
})
