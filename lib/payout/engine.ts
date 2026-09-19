import { createHash } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import {
  payouts,
  technicianProfiles,
  workizTeamMappings,
  type PayoutRow,
  type TechnicianProfile,
} from "@/lib/db/schema"
import type { WorkizSettings } from "@/lib/settings"
import { isPayableStatus, type NormalizedJob } from "@/lib/workiz/normalize"
import { CALC_VERSION, calcPayoutWithPaymentSplit, type SplitPayoutBreakdown } from "./calculator"
import { profileToRates } from "./profiles"

export type PayoutStatus = "pending" | "hold" | "ready" | "paid" | "void"

export type EngineResult = {
  jobUuid: string
  created: number
  updated: number
  unchanged: number
  held: number
  unmappedTeamIds: string[]
  payoutIds: number[]
  notes: string[]
}

/**
 * Deterministic fingerprint of everything that influences a payout number.
 * If it does not change between syncs the payout row is left alone, which keeps
 * webhook + cron double-processing idempotent.
 */
export function payoutInputHash(job: NormalizedJob, profile: TechnicianProfile, splitCount: number): string {
  const payload = {
    v: CALC_VERSION,
    jobTotal: job.jobTotal,
    colorSealTotal: job.colorSealTotal,
    cardServiceAmount: job.cardServiceAmount,
    nonCardServiceAmount: job.nonCardServiceAmount,
    cardTipAmount: job.cardTipAmount,
    nonCardTipAmount: job.nonCardTipAmount,
    discount: job.discountAmount,
    status: job.status,
    fullyPaid: job.fullyPaid,
    rates: [profile.nonColorRate, profile.colorRate, profile.tipShare, profile.separateColorSeal],
    splitCount,
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

export function computeForProfile(job: NormalizedJob, profile: TechnicianProfile): SplitPayoutBreakdown {
  const rates = profileToRates(profile)
  return calcPayoutWithPaymentSplit(
    {
      jobTotal: job.jobTotal,
      colorSealTotal: job.colorSealTotal,
      cardServiceAmount: job.cardServiceAmount,
      cardTip: job.cardTipAmount,
      nonCardOwedTip: job.nonCardTipAmount,
    },
    { nonColorRate: rates.nonColorRate, colorRate: rates.colorRate },
    { separateColorSeal: rates.separateColorSeal, tipShare: rates.tipShare },
  )
}

/**
 * Decide whether a payout is releasable. Returns null when it is, otherwise the
 * reason it must be held for admin review.
 */
export function gateReason(job: NormalizedJob, settings: WorkizSettings): string | null {
  if (!isPayableStatus(job.status, settings)) return `Job status "${job.status ?? "unknown"}" is not payable`
  if (!job.fullyPaid) return "Job is not fully paid"
  if (job.jobTotal <= 0) return "Job total is zero"
  const blocking = job.warnings.filter((w) => !w.startsWith("No payment records"))
  if (blocking.length) return blocking[0]
  return null
}

async function resolveTeam(job: NormalizedJob, source: "rest" | "webhook") {
  if (job.teamIds.length === 0) return { profiles: [] as TechnicianProfile[], unmapped: [] as string[], mappingByProfile: new Map<number, string>() }

  // Ensure every team id has a mapping row so admins can see and map it.
  for (let i = 0; i < job.teamIds.length; i++) {
    const teamId = job.teamIds[i]
    const name = job.teamNames[i] ?? null
    await db
      .insert(workizTeamMappings)
      .values({ workizTeamId: teamId, workizName: name, source })
      .onConflictDoUpdate({
        target: workizTeamMappings.workizTeamId,
        set: { workizName: name ?? undefined, updatedAt: new Date() },
      })
  }

  const mappings = await db.select().from(workizTeamMappings).where(inArray(workizTeamMappings.workizTeamId, job.teamIds))
  const mapped = mappings.filter((m) => m.profileId != null && !m.excluded)
  const unmapped = mappings.filter((m) => m.profileId == null && !m.excluded).map((m) => m.workizTeamId)

  const profileIds = Array.from(new Set(mapped.map((m) => m.profileId as number)))
  const profiles = profileIds.length
    ? await db.select().from(technicianProfiles).where(and(inArray(technicianProfiles.id, profileIds), eq(technicianProfiles.active, true)))
    : []

  const mappingByProfile = new Map<number, string>()
  for (const m of mapped) if (m.profileId != null) mappingByProfile.set(m.profileId, m.workizTeamId)
  return { profiles, unmapped, mappingByProfile }
}

/**
 * Compute and persist payouts for every mapped technician on a job.
 * - Never touches rows already marked paid or void.
 * - Recomputes and re-gates rows whose input hash changed.
 * - Leaves everything else untouched (idempotent).
 */
export async function upsertPayoutsForJob(
  job: NormalizedJob,
  settings: WorkizSettings,
  source: "rest" | "webhook" = "rest",
): Promise<EngineResult> {
  const result: EngineResult = {
    jobUuid: job.uuid,
    created: 0,
    updated: 0,
    unchanged: 0,
    held: 0,
    unmappedTeamIds: [],
    payoutIds: [],
    notes: [],
  }

  const { profiles, unmapped, mappingByProfile } = await resolveTeam(job, source)
  result.unmappedTeamIds = unmapped
  if (unmapped.length) result.notes.push(`Unmapped Workiz team ids: ${unmapped.join(", ")}`)
  if (profiles.length === 0) {
    result.notes.push("No mapped technicians on this job")
    return result
  }

  const baseGate = gateReason(job, settings)
  const splitCount = profiles.length
  const existing = await db.select().from(payouts).where(eq(payouts.jobUuid, job.uuid))
  const existingByProfile = new Map(existing.map((p) => [p.profileId, p]))

  for (const profile of profiles) {
    const hash = payoutInputHash(job, profile, splitCount)
    const prior = existingByProfile.get(profile.id)

    if (prior && (prior.status === "paid" || prior.status === "void")) {
      result.unchanged++
      result.payoutIds.push(prior.id)
      if (prior.inputHash !== hash) result.notes.push(`Payout #${prior.id} for ${profile.name} is ${prior.status} but Workiz data changed; left untouched`)
      continue
    }
    if (prior && prior.inputHash === hash) {
      result.unchanged++
      result.payoutIds.push(prior.id)
      continue
    }

    const breakdown = computeForProfile(job, profile)
    const holdReason = baseGate ?? (unmapped.length ? `Job has unmapped team members (${unmapped.join(", ")})` : null)
    const status: PayoutStatus = holdReason ? (isPayableStatus(job.status, settings) ? "hold" : "pending") : "ready"
    if (status === "hold") result.held++

    const values = {
      jobUuid: job.uuid,
      profileId: profile.id,
      workizTeamId: mappingByProfile.get(profile.id) ?? null,
      status,
      holdReason,
      jobTotal: job.jobTotal.toFixed(2),
      discountAmount: job.discountAmount.toFixed(2),
      colorSealTotal: job.colorSealTotal.toFixed(2),
      cardServiceAmount: job.cardServiceAmount.toFixed(2),
      nonCardServiceAmount: job.nonCardServiceAmount.toFixed(2),
      cardTipAmount: job.cardTipAmount.toFixed(2),
      nonCardTipAmount: job.nonCardTipAmount.toFixed(2),
      nonColorRate: profile.nonColorRate,
      colorRate: profile.colorRate,
      tipShare: profile.tipShare,
      nonColorPayout: breakdown.nonColorPayout.toFixed(4),
      colorPayout: breakdown.colorPayout.toFixed(4),
      tipPayout: breakdown.tipPayout.toFixed(4),
      basePayout: breakdown.basePayout.toFixed(4),
      totalPayout: breakdown.totalPayout.toFixed(4),
      splitCount,
      splitShare: "1",
      calcMode: breakdown.mode,
      breakdown: { ...breakdown, calcVersion: CALC_VERSION, warnings: job.warnings },
      inputHash: hash,
      updatedAt: new Date(),
    }

    if (prior) {
      await db.update(payouts).set(values).where(eq(payouts.id, prior.id))
      result.updated++
      result.payoutIds.push(prior.id)
    } else {
      const inserted = await db.insert(payouts).values(values).returning({ id: payouts.id })
      result.created++
      if (inserted[0]) result.payoutIds.push(inserted[0].id)
    }
  }

  return result
}

export function payoutMoney(row: PayoutRow) {
  return {
    total: Number(row.totalPayout),
    base: Number(row.basePayout),
    tip: Number(row.tipPayout),
    nonColor: Number(row.nonColorPayout),
    color: Number(row.colorPayout),
    jobTotal: Number(row.jobTotal),
    colorSeal: Number(row.colorSealTotal),
    discount: Number(row.discountAmount),
    cardService: Number(row.cardServiceAmount),
    nonCardService: Number(row.nonCardServiceAmount),
    cardTip: Number(row.cardTipAmount),
    nonCardTip: Number(row.nonCardTipAmount),
  }
}
