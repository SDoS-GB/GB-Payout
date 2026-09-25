import { createHash } from "node:crypto"
import { and, eq, inArray, notInArray } from "drizzle-orm"
import { db } from "@/lib/db"
import {
  payoutSourceChanges,
  payouts,
  technicianProfiles,
  workizTeamMappings,
  type TechnicianProfile,
} from "@/lib/db/schema"
import type { WorkizSettings } from "@/lib/settings"
import { isBlockingWarning, isPayableStatus, type NormalizedJob } from "@/lib/workiz/normalize"
import {
  CALC_VERSION,
  CARD_FEE_MULTIPLIER,
  CARD_FEE_RATE,
  calcPayoutWithCardShare,
  cardShareOf,
  serviceFactorFor,
  type SplitPayoutBreakdown,
} from "./calculator"
import { addCompanions, describeCompanion } from "./companions"
import { profileToRates } from "./profiles"
import { ownershipExplanation, planSegments, segmentLabel, workTypeOwners, type JobSegment, type MarkerOwner, type SegmentPlan } from "./segments"

export { planSegments, type MarkerOwner, type SegmentPlan } from "./segments"

export type PayoutStatus = "pending" | "hold" | "ready" | "paid" | "void"

export type EngineResult = {
  jobUuid: string
  created: number
  updated: number
  unchanged: number
  held: number
  /** Technicians on the job who are owed nothing and got no payout row. */
  skipped: number
  unmappedTeamIds: string[]
  payoutIds: number[]
  notes: string[]
  /** Settled payouts whose Workiz inputs changed; the settlement is untouched and flagged for review. */
  sourceChanges: number
}

export type EngineOptions = {
  /**
   * The owner's "everything paid through" declaration. A NEW payout for a job completed and
   * customer-paid at or before this instant is not new debt: it is held for the owner to confirm
   * as previously settled instead of appearing as Due.
   */
  openingCutoff?: Date | null
}

/** Hold reason prefix for pre-cutoff work first seen after the opening-balance initialization. */
export const OPENING_REVIEW_PREFIX = "Completed before the previously-paid-through cutoff"

export function isOpeningReviewHold(holdReason: string | null | undefined): boolean {
  return Boolean(holdReason && holdReason.startsWith(OPENING_REVIEW_PREFIX))
}

/** True when the job finished and was customer-paid no later than the owner's cutoff. */
export function completedBeforeCutoff(job: Pick<NormalizedJob, "status" | "fullyPaid" | "lastStatusUpdate">, settings: WorkizSettings, cutoff: Date | null | undefined): boolean {
  if (!cutoff) return false
  if (!isPayableStatus(job.status, settings) || !job.fullyPaid) return false
  return job.lastStatusUpdate != null && job.lastStatusUpdate.getTime() <= cutoff.getTime()
}

const round2 = (n: number) => Math.round(n * 100) / 100

export type ComputeOptions = {
  /** Fraction of the business-held tip this technician receives; defaults to the profile's stored share. */
  tipShare?: number
  /** Invoice-wide `C / S`; defaults to the segment's own card dollars over its total. */
  cardServiceShare?: number
}

/**
 * Deterministic fingerprint of everything that influences a payout number.
 * If it does not change between syncs the payout row is left alone, which keeps
 * webhook + cron double-processing idempotent.
 */
export function payoutInputHash(
  segment: JobSegment,
  job: NormalizedJob,
  profile: TechnicianProfile,
  splitCount: number,
  unmappedTeamIds: string[] = [],
  opts: ComputeOptions = {},
): string {
  const payload = {
    v: CALC_VERSION,
    segment: segment.kind,
    ownership: segment.ownership,
    workType: segment.workType,
    marker: segment.marker,
    items: segment.itemIndexes,
    jobTotal: segment.jobTotal,
    colorSealTotal: segment.colorSealTotal,
    cardServiceAmount: segment.cardServiceAmount,
    nonCardServiceAmount: segment.nonCardServiceAmount,
    cardTipAmount: segment.cardTipAmount,
    nonCardTipAmount: segment.nonCardTipAmount,
    invoice: [job.jobTotal, job.cardServiceAmount, job.jobType],
    discount: job.discountAmount,
    status: job.status,
    fullyPaid: job.fullyPaid,
    paidEvidence: job.paidEvidence,
    blockingWarnings: job.warnings.filter(isBlockingWarning),
    rates: [profile.nonColorRate, profile.colorRate, opts.tipShare ?? profile.tipShare, profile.separateColorSeal],
    cardServiceShare: opts.cardServiceShare ?? null,
    splitCount,
    // Excluding or mapping a team member must re-gate the payout even when the money is unchanged.
    unmapped: [...unmappedTeamIds].sort(),
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

/**
 * Runs the calculator against one segment with the technician's saved rates.
 * The engine passes the invoice-wide card share and the plan's tip share so
 * every technician on the job is scaled by the same factor.
 */
export function computeForProfile(segment: JobSegment, profile: TechnicianProfile, opts: ComputeOptions = {}): SplitPayoutBreakdown {
  const rates = profileToRates(profile)
  return calcPayoutWithCardShare(
    {
      jobTotal: segment.jobTotal,
      colorSealTotal: segment.colorSealTotal,
      cardServiceShare: opts.cardServiceShare ?? cardShareOf(segment.cardServiceAmount, segment.jobTotal),
      cardTip: segment.cardTipAmount,
      nonCardOwedTip: segment.nonCardTipAmount,
    },
    { nonColorRate: rates.nonColorRate, colorRate: rates.colorRate },
    { separateColorSeal: rates.separateColorSeal, tipShare: opts.tipShare ?? rates.tipShare },
  )
}

/**
 * Dollars withheld from this payout by the card-processing fee, for display in
 * the saved snapshot. Read straight off the breakdown the calculator already
 * produced: the fee multiplier is applied to card-paid service commission and
 * card tips only, exactly as the calculator does, so this never changes totals.
 */
export function cardFeeWithheld(breakdown: SplitPayoutBreakdown, segment: JobSegment, profile: TechnicianProfile, tipShare?: number): number {
  const rates = profileToRates(profile)
  const share = tipShare ?? rates.tipShare
  const feeRate = 1 - CARD_FEE_MULTIPLIER
  const cardCommission = breakdown.cardNonColorAmount * rates.nonColorRate + breakdown.cardColorAmount * rates.colorRate
  const cardTip = segment.cardTipAmount > 0 ? segment.cardTipAmount * share : 0
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

/** Every active technician: the source for marker / Work Type owners and for companions who are never assigned in Workiz. */
async function loadActiveRoster(): Promise<TechnicianProfile[]> {
  return db.select().from(technicianProfiles).where(eq(technicianProfiles.active, true))
}

const money = (n: number) => `$${n.toFixed(2)}`
const pct = (n: number) => `${(n * 100).toFixed(4)}%`

/** The invoice-level card fee facts every payout on the job shares. */
export function invoiceCardFee(job: Pick<NormalizedJob, "jobTotal" | "cardServiceAmount" | "nonCardServiceAmount">) {
  const cardShare = cardShareOf(job.cardServiceAmount, job.jobTotal)
  const serviceFactor = serviceFactorFor(cardShare)
  return {
    serviceSubtotal: job.jobTotal,
    cardPaid: job.cardServiceAmount,
    otherPaid: job.nonCardServiceAmount,
    cardShare,
    feeRate: CARD_FEE_RATE,
    /** Exact processor fee on the card-paid service dollars (C x 3.5%). */
    fee: job.cardServiceAmount * CARD_FEE_RATE,
    serviceFactor,
    /** S x serviceFactor: the service subtotal every rate is applied to. */
    adjustedServiceSubtotal: job.jobTotal * serviceFactor,
  }
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
  options: EngineOptions = {},
): Promise<EngineResult> {
  const result: EngineResult = {
    jobUuid: job.uuid,
    created: 0,
    updated: 0,
    unchanged: 0,
    held: 0,
    skipped: 0,
    unmappedTeamIds: [],
    payoutIds: [],
    notes: [],
    sourceChanges: 0,
  }
  const preCutoff = completedBeforeCutoff(job, settings, options.openingCutoff)

  const { profiles: assigned, unmapped, mappingByProfile } = await resolveTeam(job, source)
  result.unmappedTeamIds = unmapped
  if (unmapped.length) result.notes.push(`Unmapped Workiz team ids: ${unmapped.join(", ")}`)

  const roster = await loadActiveRoster()
  const existing = await db.select().from(payouts).where(eq(payouts.jobUuid, job.uuid))
  const existingByProfile = new Map(existing.map((p) => [p.profileId, p]))
  const settledProfileIds = new Set(existing.filter((p) => p.status === "paid" || p.status === "void").map((p) => p.profileId))

  // Rule A: a Work Type owned by a technician names him even when Workiz did not assign him.
  const owners = workTypeOwners(job.jobType, roster)
  const addedOwners: TechnicianProfile[] = []
  if (owners.length === 1 && !assigned.some((p) => p.id === owners[0].id)) {
    const owner = owners[0]
    const settledJob = settledProfileIds.size > 0 && !existingByProfile.has(owner.id)
    if (settledJob) {
      result.notes.push(`Work Type "${job.jobType}" belongs to ${owner.name} but this job already has paid/void payouts; ${owner.name} was not added — review by hand`)
    } else {
      addedOwners.push(owner)
      result.notes.push(`Work Type "${job.jobType}" belongs to ${owner.name}; added to this job although Workiz does not list them`)
    }
  }

  if (assigned.length === 0 && addedOwners.length === 0) {
    result.notes.push("No mapped technicians on this job")
    return result
  }

  // Technicians who ride along on every job of an assigned tech (Denis with Vadim) but whom Workiz never lists.
  const { profiles, added: companions } = addCompanions([...assigned, ...addedOwners], roster, {
    settledPrimaryIds: settledProfileIds,
    existingPayoutProfileIds: new Set(existing.map((p) => p.profileId)),
  })
  const companionPrimary = new Map(companions.map((c) => [c.companion.id, { id: c.primary.id, name: c.primary.name }]))
  for (const c of companions) result.notes.push(`${describeCompanion(c)}; added to this job although Workiz does not list them`)

  const plan = planSegments(job, profiles, roster)
  const fee = invoiceCardFee(job)
  const workTypeSegment = plan.segmentation.segments.find((s) => s.ownership === "work-type") ?? null
  const ownerProfile = workTypeSegment ? (owners[0] ?? null) : null

  if (workTypeSegment) {
    result.notes.push(`Work Type "${workTypeSegment.workType}": whole job ${money(workTypeSegment.jobTotal)} belongs to ${ownerProfile?.name ?? "its owner"}; no crew service commission`)
  } else if (plan.segmentation.segments.length > 1) {
    result.notes.push(
      plan.segmentation.segments
        .map((s) => (s.kind === "dedicated" ? `${segmentLabel(s.kind, s.marker)} ${money(s.jobTotal)} (${s.itemIndexes.length} items)` : `crew work ${money(s.jobTotal)} (${s.itemIndexes.length} items, tips ${money(s.cardTipAmount + s.nonCardTipAmount)})`))
        .join(" · "),
    )
  }
  if (fee.cardShare > 0) result.notes.push(`Card-paid ${money(fee.cardPaid)} of ${money(fee.serviceSubtotal)} (${pct(fee.cardShare)}); fee ${money(round2(fee.fee))}; services x ${fee.serviceFactor.toFixed(10)}`)
  if (plan.tips.total > 0) {
    result.notes.push(
      plan.tips.recipients.length
        ? `Tip ${money(plan.tips.total)} split among ${plan.tips.recipients.map((r) => r.name).join(", ")} (${(plan.tips.share * 100).toFixed(plan.tips.share * 100 % 1 === 0 ? 0 : 2)}% each)${plan.tips.excluded.length ? `; ${plan.tips.excluded.map((e) => e.name).join(", ")} receive${plan.tips.excluded.length === 1 ? "s" : ""} no tip` : ""}`
        : `Tip ${money(plan.tips.total)} has no eligible regular technician`,
    )
  }
  result.notes.push(...plan.warnings)

  const baseGate = gateReason(job, settings, plan.warnings)

  for (const profile of profiles) {
    const segment = plan.segmentFor.get(profile.id) ?? plan.segmentation.segments[0]
    const splitCount = plan.splitCountFor.get(profile.id) ?? profiles.length
    const tipShare = plan.tipShareFor.get(profile.id) ?? 0
    const computeOpts: ComputeOptions = { tipShare, cardServiceShare: fee.cardShare }
    const hash = payoutInputHash(segment, job, profile, splitCount, unmapped, computeOpts)
    const prior = existingByProfile.get(profile.id)

    if (prior && (prior.status === "paid" || prior.status === "void")) {
      result.unchanged++
      result.payoutIds.push(prior.id)
      if (prior.inputHash !== hash) {
        // A settled payout is frozen; the difference is recorded once per new fingerprint for review.
        const recomputed = computeForProfile(segment, profile, computeOpts)
        const settled = Number(prior.totalPayout)
        const inserted = await db
          .insert(payoutSourceChanges)
          .values({
            payoutId: prior.id,
            jobUuid: job.uuid,
            profileId: profile.id,
            settledHash: prior.inputHash,
            newHash: hash,
            settledAmount: prior.totalPayout,
            recomputedAmount: recomputed.totalPayout.toFixed(4),
            summary: `${profile.name} on ${job.serialId ?? job.uuid}: settled ${money(round2(settled))}, Workiz data now computes ${money(round2(recomputed.totalPayout))} (${job.status ?? "?"}, ${job.fullyPaid ? "paid" : "unpaid"})`,
          })
          .onConflictDoNothing()
          .returning({ id: payoutSourceChanges.id })
        if (inserted.length) result.sourceChanges++
        result.notes.push(`Payout #${prior.id} for ${profile.name} is ${prior.status} but Workiz data changed; left untouched and flagged for review`)
      }
      continue
    }
    if (prior && prior.inputHash === hash) {
      result.unchanged++
      result.payoutIds.push(prior.id)
      continue
    }

    const ownershipReason = segment.ownership === "work-type" ? "work-type" : segment.kind === "job" ? "whole-job" : segment.ownership
    const ownership = {
      reason: ownershipReason,
      workType: workTypeSegment?.workType ?? null,
      ownerName: ownerProfile?.name ?? null,
      label: segmentLabel(segment.kind, segment.marker, { reason: ownershipReason, workType: workTypeSegment?.workType ?? null }),
      explanation: ownershipExplanation(segment.kind, segment.marker, { reason: ownershipReason, workType: workTypeSegment?.workType ?? null }),
    }

    // A technician the job owes nothing (regular crew on an owned Work Type, no tip) gets no row.
    const tipOwed = tipShare > 0 ? segment.cardTipAmount + segment.nonCardTipAmount : 0
    const nothingOwed = job.jobTotal > 0 && segment.jobTotal <= 0 && tipOwed <= 0
    if (nothingOwed && !prior) {
      result.skipped++
      result.notes.push(`${profile.name} is on this job but is owed nothing (${ownership.label ?? "no eligible work"}); no payout row created`)
      continue
    }

    const breakdown = computeForProfile(segment, profile, computeOpts)
    const cardFeeAdjustment = cardFeeWithheld(breakdown, segment, profile, tipShare)
    let holdReason = baseGate ?? (unmapped.length ? `Job has unmapped team members (${unmapped.join(", ")})` : null)
    if (nothingOwed) holdReason = `${ownership.explanation} Nothing is owed on this row; void it if that is right.`
    // Work finished and paid before the owner's declaration is not new debt. A row first created
    // now (late import, newly mapped technician) waits for the owner to confirm it was settled;
    // a row that already carries that hold keeps it until the owner decides.
    const openingHold = preCutoff && (!prior || isOpeningReviewHold(prior.holdReason)) && !nothingOwed
    if (openingHold) {
      holdReason = `${OPENING_REVIEW_PREFIX} (${options.openingCutoff!.toISOString()}) but first seen afterwards — confirm it was already paid, or release it if it is still owed${holdReason ? `. Also: ${holdReason}` : ""}`
    }
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
      tipShare: tipShare.toFixed(6),
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
        addedAsOwner: addedOwners.some((o) => o.id === profile.id),
        ownership,
        rates: {
          nonColorRate: Number(profile.nonColorRate),
          colorRate: Number(profile.colorRate),
          separateColorSeal: profile.separateColorSeal,
          tipShare,
        },
        tips: {
          total: plan.tips.total,
          card: job.cardTipAmount,
          other: job.nonCardTipAmount,
          recipients: plan.tips.recipients,
          share: plan.tips.share,
          excluded: plan.tips.excluded,
          needsReview: plan.tips.needsReview,
          thisTechnician: breakdown.tipPayout,
        },
        invoiceFee: fee,
        segment: {
          kind: segment.kind,
          ownership: segment.ownership,
          workType: segment.workType,
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
          jobType: job.jobType,
          jobTotal: job.jobTotal,
          colorSealTotal: job.colorSealTotal,
          discountAmount: job.discountAmount,
          cardServiceAmount: job.cardServiceAmount,
          nonCardServiceAmount: job.nonCardServiceAmount,
          cardTipAmount: job.cardTipAmount,
          nonCardTipAmount: job.nonCardTipAmount,
          invoiceTotal: job.invoiceTotal,
          amountDue: job.amountDue,
          paidEvidence: job.paidEvidence,
          markers: plan.segmentation.segments.filter((s) => s.kind === "dedicated" && s.marker).map((s) => s.marker),
          workType: workTypeSegment?.workType ?? null,
        },
        verification: plan.segmentation.verification,
      },
      inputHash: hash,
      updatedAt: new Date(),
    }

    if (prior) {
      // The row was read before this write; if the owner settled it in between, leave it alone.
      const written = await db
        .update(payouts)
        .set(values)
        .where(and(eq(payouts.id, prior.id), notInArray(payouts.status, ["paid", "void"])))
        .returning({ id: payouts.id })
      if (written.length) result.updated++
      else {
        result.unchanged++
        result.notes.push(`Payout #${prior.id} for ${profile.name} was settled while this sync ran; left untouched`)
      }
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
