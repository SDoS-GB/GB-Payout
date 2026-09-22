import { createHash } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import {
  payouts,
  technicianProfiles,
  workizTeamMappings,
  type TechnicianProfile,
} from "@/lib/db/schema"
import type { WorkizSettings } from "@/lib/settings"
import { isBlockingWarning, isPayableStatus, type NormalizedJob } from "@/lib/workiz/normalize"
import { CALC_VERSION, CARD_FEE_MULTIPLIER, calcPayoutWithPaymentSplit, type SplitPayoutBreakdown } from "./calculator"
import { addCompanions, describeCompanion } from "./companions"
import { profileToRates } from "./profiles"
import { planSegments, type JobSegment, type MarkerOwner } from "./segments"

export { planSegments, type MarkerOwner, type SegmentPlan } from "./segments"

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

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Deterministic fingerprint of everything that influences a payout number.
 * If it does not change between syncs the payout row is left alone, which keeps
 * webhook + cron double-processing idempotent.
 */
export function payoutInputHash(segment: JobSegment, job: NormalizedJob, profile: TechnicianProfile, splitCount: number, unmappedTeamIds: string[] = []): string {
  const payload = {
    v: CALC_VERSION,
    segment: segment.kind,
    marker: segment.marker,
    items: segment.itemIndexes,
    jobTotal: segment.jobTotal,
    colorSealTotal: segment.colorSealTotal,
    cardServiceAmount: segment.cardServiceAmount,
    nonCardServiceAmount: segment.nonCardServiceAmount,
    cardTipAmount: segment.cardTipAmount,
    nonCardTipAmount: segment.nonCardTipAmount,
    discount: job.discountAmount,
    status: job.status,
    fullyPaid: job.fullyPaid,
    paidEvidence: job.paidEvidence,
    blockingWarnings: job.warnings.filter(isBlockingWarning),
    rates: [profile.nonColorRate, profile.colorRate, profile.tipShare, profile.separateColorSeal],
    splitCount,
    // Excluding or mapping a team member must re-gate the payout even when the money is unchanged.
    unmapped: [...unmappedTeamIds].sort(),
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

/** Runs the unchanged calculator formulas against one segment with the technician's saved rates. */
export function computeForProfile(segment: JobSegment, profile: TechnicianProfile): SplitPayoutBreakdown {
  const rates = profileToRates(profile)
  return calcPayoutWithPaymentSplit(
    {
      jobTotal: segment.jobTotal,
      colorSealTotal: segment.colorSealTotal,
      cardServiceAmount: segment.cardServiceAmount,
      cardTip: segment.cardTipAmount,
      nonCardOwedTip: segment.nonCardTipAmount,
    },
    { nonColorRate: rates.nonColorRate, colorRate: rates.colorRate },
    { separateColorSeal: rates.separateColorSeal, tipShare: rates.tipShare },
  )
}

/**
 * Dollars withheld from this payout by the card-processing fee, for display in
 * the saved snapshot. Read straight off the breakdown the calculator already
 * produced: the fee multiplier is applied to card-paid service commission and
 * card tips only, exactly as the calculator does, so this never changes totals.
 */
export function cardFeeWithheld(breakdown: SplitPayoutBreakdown, segment: JobSegment, profile: TechnicianProfile): number {
  const rates = profileToRates(profile)
  const feeRate = 1 - CARD_FEE_MULTIPLIER
  const cardCommission = breakdown.cardNonColorAmount * rates.nonColorRate + breakdown.cardColorAmount * rates.colorRate
  const cardTip = segment.cardTipAmount > 0 ? segment.cardTipAmount * rates.tipShare : 0
  return Math.round((cardCommission + cardTip) * feeRate * 10000) / 10000
}

/**
 * Decide whether a payout is releasable. Returns null when it is, otherwise the
 * reason it must be held for admin review.
 */
export function gateReason(job: NormalizedJob, settings: WorkizSettings, extraWarnings: string[] = []): string | null {
  if (!isPayableStatus(job.status, settings)) return `Job status "${job.status ?? "unknown"}" is not payable`
  if (!job.fullyPaid) return "Job is not fully paid"
  if (job.jobTotal <= 0) return "Job total is zero"
  // Every non-informational warning holds the payout: an unknown payment method
  // is flagged for review rather than silently paid as non-card.
  const blocking = [...job.warnings.filter(isBlockingWarning), ...extraWarnings.filter(isBlockingWarning)]
  if (blocking.length) return blocking[0]
  return null
}

/**
 * Why an admin may not release a held payout, or null when they may. Review
 * warnings (unknown payment method, unitemized discount, marker problems) are
 * exactly what an admin resolves by releasing; an unfinished or unpaid job is
 * not, so those holds cannot be overridden from the dashboard.
 */
export function releaseBlocker(
  job: { status: string | null; fullyPaid: boolean; jobTotal: number } | null,
  settings: WorkizSettings,
): string | null {
  if (!job) return "No Workiz snapshot exists for this payout; sync the job first"
  if (!isPayableStatus(job.status, settings)) return `Job status "${job.status ?? "unknown"}" is not completed`
  if (!job.fullyPaid) return "Job is not fully paid in Workiz"
  if (job.jobTotal <= 0) return "Job total is zero"
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

/** Every active technician: the source for line-item marker owners and for companions who are never assigned in Workiz. */
async function loadActiveRoster(): Promise<TechnicianProfile[]> {
  return db.select().from(technicianProfiles).where(eq(technicianProfiles.active, true))
}

function markerOwnersOf(roster: TechnicianProfile[]): MarkerOwner[] {
  return roster.filter((p) => p.lineItemMarker != null).map((p) => ({ id: p.id, name: p.name, lineItemMarker: p.lineItemMarker }))
}

const money = (n: number) => `$${n.toFixed(2)}`

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

  const { profiles: assigned, unmapped, mappingByProfile } = await resolveTeam(job, source)
  result.unmappedTeamIds = unmapped
  if (unmapped.length) result.notes.push(`Unmapped Workiz team ids: ${unmapped.join(", ")}`)
  if (assigned.length === 0) {
    result.notes.push("No mapped technicians on this job")
    return result
  }

  const existing = await db.select().from(payouts).where(eq(payouts.jobUuid, job.uuid))
  const existingByProfile = new Map(existing.map((p) => [p.profileId, p]))
  const roster = await loadActiveRoster()

  // Technicians who ride along on every job of an assigned tech (Denis with Vadim) but whom Workiz never lists.
  const { profiles, added: companions } = addCompanions(assigned, roster, {
    settledPrimaryIds: new Set(existing.filter((p) => p.status === "paid" || p.status === "void").map((p) => p.profileId)),
    existingPayoutProfileIds: new Set(existing.map((p) => p.profileId)),
  })
  const companionPrimary = new Map(companions.map((c) => [c.companion.id, { id: c.primary.id, name: c.primary.name }]))
  for (const c of companions) result.notes.push(`${describeCompanion(c)}; added to this job although Workiz does not list them`)

  const plan = planSegments(job, profiles, markerOwnersOf(roster))
  if (plan.segmentation.segments.length > 1) {
    result.notes.push(
      plan.segmentation.segments
        .map((s) => (s.kind === "dedicated" ? `${s.marker} work ${money(s.jobTotal)} (${s.itemIndexes.length} items)` : `crew work ${money(s.jobTotal)} (${s.itemIndexes.length} items, tips ${money(s.cardTipAmount + s.nonCardTipAmount)})`))
        .join(" · "),
    )
  }
  result.notes.push(...plan.warnings)

  const baseGate = gateReason(job, settings, plan.warnings)

  for (const profile of profiles) {
    const segment = plan.segmentFor.get(profile.id) ?? plan.segmentation.segments[0]
    const splitCount = plan.splitCountFor.get(profile.id) ?? profiles.length
    const hash = payoutInputHash(segment, job, profile, splitCount, unmapped)
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

    const breakdown = computeForProfile(segment, profile)
    const cardFeeAdjustment = cardFeeWithheld(breakdown, segment, profile)
    const holdReason = baseGate ?? (unmapped.length ? `Job has unmapped team members (${unmapped.join(", ")})` : null)
    const status: PayoutStatus = holdReason ? (isPayableStatus(job.status, settings) ? "hold" : "pending") : "ready"
    if (status === "hold") result.held++

    const discountAmount = segment.kind === "job" ? job.discountAmount : round2(segment.itemDiscountAmount + segment.allocatedDiscountAmount)

    const values = {
      jobUuid: job.uuid,
      profileId: profile.id,
      workizTeamId: mappingByProfile.get(profile.id) ?? null,
      status,
      holdReason,
      jobTotal: segment.jobTotal.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      colorSealTotal: segment.colorSealTotal.toFixed(2),
      cardServiceAmount: segment.cardServiceAmount.toFixed(2),
      nonCardServiceAmount: segment.nonCardServiceAmount.toFixed(2),
      cardTipAmount: segment.cardTipAmount.toFixed(2),
      nonCardTipAmount: segment.nonCardTipAmount.toFixed(2),
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
      segmentKind: segment.kind,
      segmentMarker: segment.marker,
      calcMode: breakdown.mode,
      breakdown: {
        ...breakdown,
        cardFeeAdjustment,
        calcVersion: CALC_VERSION,
        warnings: [...job.warnings, ...plan.warnings],
        companionOf: companionPrimary.get(profile.id) ?? null,
        segment: {
          kind: segment.kind,
          marker: segment.marker,
          itemIndexes: segment.itemIndexes,
          itemNames: segment.itemNames,
          markerFields: segment.markerFields,
          grossAmount: segment.grossAmount,
          itemDiscountAmount: segment.itemDiscountAmount,
          allocatedDiscountAmount: segment.allocatedDiscountAmount,
          share: segment.share,
        },
        job: {
          jobTotal: job.jobTotal,
          colorSealTotal: job.colorSealTotal,
          discountAmount: job.discountAmount,
          cardServiceAmount: job.cardServiceAmount,
          invoiceTotal: job.invoiceTotal,
          amountDue: job.amountDue,
          paidEvidence: job.paidEvidence,
          markers: plan.segmentation.segments.filter((s) => s.kind === "dedicated").map((s) => s.marker),
        },
        verification: plan.segmentation.verification,
      },
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

export { payoutMoney } from "./money"
