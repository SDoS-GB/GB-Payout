import { asc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { technicianProfiles, type TechnicianProfile } from "@/lib/db/schema"
import { hashSecret, verifySecret } from "@/lib/security/crypto"
import { COMPANIONS, CONTRACTORS, LINE_ITEM_MARKERS, WORK_TYPE_OWNERS, legacyProfileOptions, type ContractorName } from "./contractors"
import type { ProfileOptions, Rates } from "./calculator"

export type ProfileRates = Rates & ProfileOptions

export function profileToRates(profile: TechnicianProfile): ProfileRates {
  return {
    nonColorRate: Number(profile.nonColorRate),
    colorRate: Number(profile.colorRate),
    tipShare: Number(profile.tipShare),
    separateColorSeal: profile.separateColorSeal,
  }
}

/**
 * Idempotently copy the hardcoded CONTRACTORS table into technician_profiles.
 * Existing rows are left untouched so admin edits are never overwritten.
 */
export async function ensureProfilesSeeded(): Promise<void> {
  const existing = await db.select({ name: technicianProfiles.name }).from(technicianProfiles)
  const known = new Set(existing.map((r) => r.name))
  const missing = (Object.keys(CONTRACTORS) as ContractorName[]).filter((n) => !known.has(n))
  if (missing.length === 0) return

  await db.insert(technicianProfiles).values(
    missing.map((name) => {
      const c = CONTRACTORS[name]
      const legacy = legacyProfileOptions(name)
      return {
        name,
        pinHash: hashSecret(c.pin),
        nonColorRate: c.nonColorRate.toString(),
        colorRate: c.colorRate.toString(),
        tipShare: legacy.tipShare.toString(),
        separateColorSeal: legacy.separateColorSeal,
        lineItemMarker: LINE_ITEM_MARKERS[name] ?? null,
        ownedWorkType: WORK_TYPE_OWNERS[name] ?? null,
        active: true,
      }
    }),
  )

  // Pairings need the primary's row id, which only exists after the insert above.
  const paired = missing.filter((name) => COMPANIONS[name])
  if (paired.length === 0) return
  const rows = await db.select({ id: technicianProfiles.id, name: technicianProfiles.name }).from(technicianProfiles)
  const idByName = new Map(rows.map((r) => [r.name, r.id]))
  for (const name of paired) {
    const primaryId = idByName.get(COMPANIONS[name] as string)
    if (primaryId == null) continue
    await db.update(technicianProfiles).set({ worksWithProfileId: primaryId }).where(eq(technicianProfiles.name, name))
  }
}

export async function listProfiles(): Promise<TechnicianProfile[]> {
  await ensureProfilesSeeded()
  return db.select().from(technicianProfiles).orderBy(asc(technicianProfiles.name))
}

export async function getProfileById(id: number): Promise<TechnicianProfile | null> {
  const rows = await db.select().from(technicianProfiles).where(eq(technicianProfiles.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getProfileByName(name: string): Promise<TechnicianProfile | null> {
  await ensureProfilesSeeded()
  const rows = await db.select().from(technicianProfiles).where(eq(technicianProfiles.name, name)).limit(1)
  return rows[0] ?? null
}

/** Returns the profile when the PIN matches, otherwise null. */
export async function verifyTechnicianPin(name: string, pin: string): Promise<TechnicianProfile | null> {
  const profile = await getProfileByName(name)
  if (!profile || !profile.active) return null
  return verifySecret(pin, profile.pinHash) ? profile : null
}
