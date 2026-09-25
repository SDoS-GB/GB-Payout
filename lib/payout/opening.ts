import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { appSettings, payouts, syncEvents, technicianProfiles, workizJobs } from "@/lib/db/schema"
import { DEFAULT_PAYOUT_SETTINGS, getPayoutSettings, getWorkizSettings, type PayoutSettings } from "@/lib/settings"
import { isPayableStatus } from "@/lib/workiz/normalize"
import { BUSINESS_TIMEZONE, zonedTimeToUtc } from "@/lib/workiz/schedule"
import { parseWorkizDate } from "@/lib/workiz/time"
import { round2, selectionTotal } from "./batch-rules"
import { recordOpeningBatch } from "./batches"
import { isOpeningReviewHold } from "./engine"

export const OPENING_LABEL = "Previously settled — opening balance"
export const LATE_IMPORT_LABEL = "Previously settled — confirmed after import"

export type OpeningCandidate = {
  payoutId: number
  profileId: number
  profileName: string
  jobUuid: string
  serialId: string | null
  clientName: string | null
  amount: number
  status: string
  holdReason: string | null
  completedAt: string | null
}

export type OpeningIssue = { jobUuid: string; serialId: string | null; clientName: string | null; reason: string }

export type OpeningPreview = {
  cutoffAt: string
  technicians: Array<{ profileId: number; name: string; calculatedTotal: number; provisional: number; items: OpeningCandidate[] }>
  /** Jobs that cannot be placed before or after the cutoff; nothing is settled for them. */
  issues: OpeningIssue[]
  /** Finished before the cutoff but the customer still owes money: stay Waiting, never historically paid. */
  waitingJobs: number
  /** Eligible rows completed after the cutoff: stay Due. */
  afterCutoff: number
  /** Rows marked paid before this redesign (no batch); left exactly as they are. */
  legacyPaid: number
}

type Row = {
  payoutId: number
  profileId: number
  profileName: string | null
  jobUuid: string
  status: string
  holdReason: string | null
  totalPayout: string
  serialId: string | null
  clientName: string | null
  jobStatus: string | null
  fullyPaid: boolean | null
  lastStatusUpdate: string | null
}

async function openRows(): Promise<Row[]> {
  return db
    .select({
      payoutId: payouts.id,
      profileId: payouts.profileId,
      profileName: technicianProfiles.name,
      jobUuid: payouts.jobUuid,
      status: payouts.status,
      holdReason: payouts.holdReason,
      totalPayout: payouts.totalPayout,
      serialId: workizJobs.serialId,
      clientName: workizJobs.clientName,
      jobStatus: workizJobs.status,
      fullyPaid: workizJobs.fullyPaid,
      lastStatusUpdate: sql<string | null>`${workizJobs.raw}->>'LastStatusUpdate'`,
    })
    .from(payouts)
    .leftJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id))
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .where(inArray(payouts.status, ["ready", "hold", "pending"]))
}

/**
 * Classifies every open payout against the owner's cutoff. Only rows whose job is finished AND
 * fully customer-paid no later than the cutoff are candidates; a missing completion timestamp
 * is reported, never guessed.
 */
export async function previewOpeningBalance(cutoff: Date): Promise<OpeningPreview> {
  const settings = await getWorkizSettings()
  const tz = settings.businessTimezone || "America/New_York"
  const rows = await openRows()
  const [{ legacyPaid }] = await db
    .select({ legacyPaid: sql<number>`count(*)`.mapWith(Number) })
    .from(payouts)
    .where(and(eq(payouts.status, "paid"), isNull(payouts.batchId)))

  const byTech = new Map<number, { profileId: number; name: string; items: OpeningCandidate[] }>()
  const issues: OpeningIssue[] = []
  const issueJobs = new Set<string>()
  const waiting = new Set<string>()
  let afterCutoff = 0

  for (const r of rows) {
    if (!r.jobStatus || !isPayableStatus(r.jobStatus, settings)) continue
    if (!r.fullyPaid) {
      waiting.add(r.jobUuid)
      continue
    }
    if (r.status === "pending") continue
    const completedAt = parseWorkizDate(r.lastStatusUpdate, tz)
    if (!completedAt) {
      if (!issueJobs.has(r.jobUuid)) {
        issueJobs.add(r.jobUuid)
        issues.push({ jobUuid: r.jobUuid, serialId: r.serialId, clientName: r.clientName, reason: "Workiz has no completion timestamp for this job, so it cannot be placed before or after the cutoff. Sync it again or review it by hand." })
      }
      continue
    }
    if (completedAt.getTime() > cutoff.getTime()) {
      afterCutoff++
      continue
    }
    const tech = byTech.get(r.profileId) ?? { profileId: r.profileId, name: r.profileName ?? "Unknown", items: [] }
    tech.items.push({
      payoutId: r.payoutId,
      profileId: r.profileId,
      profileName: tech.name,
      jobUuid: r.jobUuid,
      serialId: r.serialId,
      clientName: r.clientName,
      amount: round2(Number(r.totalPayout)),
      status: r.status,
      holdReason: r.holdReason,
      completedAt: completedAt.toISOString(),
    })
    byTech.set(r.profileId, tech)
  }

  const technicians = Array.from(byTech.values())
    .map((t) => ({
      profileId: t.profileId,
      name: t.name,
      calculatedTotal: selectionTotal(t.items),
      provisional: t.items.filter((i) => i.status === "hold").length,
      items: t.items.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? "")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { cutoffAt: cutoff.toISOString(), technicians, issues, waitingJobs: waiting.size, afterCutoff, legacyPaid }
}

export type OpeningInitResult = { batchIds: number[]; settled: number; calculatedTotal: number; preview: OpeningPreview; settings: PayoutSettings }

/**
 * The one-time initialization: settles every candidate as "Previously settled — opening balance"
 * (one batch per technician, real payment facts unknown) and stores the cutoff durably, all in
 * one transaction. A second call is refused, so deployments and syncs can never repeat it.
 */
export async function initializeOpeningBalance(cutoff: Date, actor: string): Promise<OpeningInitResult> {
  const now = new Date()
  if (Number.isNaN(cutoff.getTime())) throw new Error("Cutoff is not a valid date/time")
  if (cutoff.getTime() > now.getTime()) throw new Error("Cutoff cannot be in the future")
  const current = await getPayoutSettings()
  if (current.openingInitializedAt) throw new Error(`Already initialized on ${current.openingInitializedAt} with cutoff ${current.openingCutoffAt}; it cannot run twice`)
  const [y, m, d] = current.historyStartDate.split("-").map(Number)
  const start = zonedTimeToUtc(y, m, d, 0, 0, (await getWorkizSettings()).businessTimezone || BUSINESS_TIMEZONE)
  if (cutoff.getTime() < start.getTime()) throw new Error(`Cutoff cannot be before the business-history start (${current.historyStartDate})`)

  const preview = await previewOpeningBalance(cutoff)

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(appSettings).where(eq(appSettings.key, "payout")).for("update")
    const stored: PayoutSettings = { ...DEFAULT_PAYOUT_SETTINGS, ...((row?.value ?? {}) as Partial<PayoutSettings>) }
    if (stored.openingInitializedAt) throw new Error("Already initialized by another request")

    const batchIds: number[] = []
    let settled = 0
    for (const tech of preview.technicians) {
      const { batch, settledPayoutIds } = await recordOpeningBatch(
        { profileId: tech.profileId, payoutIds: tech.items.map((i) => i.payoutId), cutoffAt: cutoff, actor, label: OPENING_LABEL, source: "initialization" },
        tx,
      )
      batchIds.push(batch.id)
      settled += settledPayoutIds.length
    }

    const next: PayoutSettings = { ...stored, openingCutoffAt: cutoff.toISOString(), openingInitializedAt: now.toISOString(), openingInitializedBy: actor, openingBatchIds: batchIds }
    await tx
      .insert(appSettings)
      .values({ key: "payout", value: next, updatedBy: actor })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: now, updatedBy: actor } })

    const calculatedTotal = round2(preview.technicians.reduce((s, t) => s + t.calculatedTotal, 0))
    await tx.insert(syncEvents).values({
      kind: "opening:init",
      ok: preview.issues.length === 0,
      summary: `Opening balance initialized: previously paid through ${cutoff.toISOString()} · ${settled} payout${settled === 1 ? "" : "s"} across ${batchIds.length} technician${batchIds.length === 1 ? "" : "s"} (calculated $${calculatedTotal.toFixed(2)}, actual payments unknown)${preview.issues.length ? ` · ${preview.issues.length} job(s) need review` : ""}`,
      details: { cutoffAt: cutoff.toISOString(), batchIds, settled, calculatedTotal, issues: preview.issues, waitingJobs: preview.waitingJobs, afterCutoff: preview.afterCutoff, legacyPaid: preview.legacyPaid, actor },
    })
    return { batchIds, settled, calculatedTotal, preview, settings: next }
  })
}

/**
 * A pre-cutoff job first seen after the initialization is held for the owner. Confirming it
 * settles it as previously paid (per technician, real payment facts unknown) instead of creating
 * old debt. Rows without the opening-review hold are refused.
 */
export async function confirmPreviouslyPaid(payoutIds: number[], actor: string): Promise<{ batchIds: number[]; settled: number }> {
  if (payoutIds.length === 0) throw new Error("Nothing selected")
  const settings = await getPayoutSettings()
  if (!settings.openingCutoffAt) throw new Error("Run the opening-balance initialization first")
  const cutoff = new Date(settings.openingCutoffAt)
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: payouts.id, profileId: payouts.profileId, status: payouts.status, holdReason: payouts.holdReason }).from(payouts).where(inArray(payouts.id, payoutIds)).for("update")
    const bad = rows.filter((r) => r.status !== "hold" || !isOpeningReviewHold(r.holdReason))
    if (bad.length) throw new Error(`Payout${bad.length === 1 ? "" : "s"} ${bad.map((b) => `#${b.id}`).join(", ")} ${bad.length === 1 ? "is" : "are"} not waiting for an opening-balance decision`)
    const byProfile = new Map<number, number[]>()
    for (const r of rows) byProfile.set(r.profileId, [...(byProfile.get(r.profileId) ?? []), r.id])
    const batchIds: number[] = []
    let settled = 0
    for (const [profileId, ids] of byProfile) {
      const { batch, settledPayoutIds } = await recordOpeningBatch({ profileId, payoutIds: ids, cutoffAt: cutoff, actor, label: LATE_IMPORT_LABEL, source: "late-import" }, tx)
      batchIds.push(batch.id)
      settled += settledPayoutIds.length
    }
    return { batchIds, settled }
  })
}
