"use server"

import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import {
  colorSealItems,
  payoutSourceChanges,
  payouts,
  syncEvents,
  technicianProfiles,
  workizJobs,
  workizTeamMappings,
} from "@/lib/db/schema"
import { TECH_PAYMENT_METHODS, isoDateInZone, round2, validateBatchForm, type SelectionItem, type StaleItem } from "@/lib/payout/batch-rules"
import { getBatch, listBatches, recordPaymentBatch, reverseBatch, type BatchFilter, type BatchSummary } from "@/lib/payout/batches"
import { isOpeningReviewHold, releaseBlocker } from "@/lib/payout/engine"
import { confirmPreviouslyPaid, initializeOpeningBalance, previewOpeningBalance } from "@/lib/payout/opening"
import { listProfiles } from "@/lib/payout/profiles"
import {
  DEFAULT_BUSINESS_TIMEZONE,
  DEFAULT_PAYOUT_QUERY,
  PAYOUT_STATUS_FILTERS,
  completionState,
  type PayoutQuery,
} from "@/lib/payout/presentation"
import { parseMarkerTokens, workTypeMatches } from "@/lib/payout/segments"
import { getWebhookUrl } from "@/lib/public-origin"
import { generateToken, hashSecret } from "@/lib/security/crypto"
import { requireAdmin } from "@/lib/security/session"
import {
  DEFAULT_WORKIZ_SETTINGS,
  getPayoutSettings,
  getWorkizSettings,
  saveAdminSettings,
  savePayoutSettings,
  saveWorkizSettings,
} from "@/lib/settings"
import { WorkizApiError, WorkizClient } from "@/lib/workiz/client"
import { countWebhookEventsByStatus, recentWebhookEvents } from "@/lib/workiz/events"
import { validateManualPayments, type ManualPaymentEntry } from "@/lib/workiz/payments"
import { SYNC_HOURS_LOCAL, formatSlot, nextScheduledSlot, previousScheduledSlot, syncHealth } from "@/lib/workiz/schedule"
import { parseWorkizDate } from "@/lib/workiz/time"
import { MIN_RECONCILE_LOOKBACK_DAYS, SyncInProgressError, getSyncStatus, getWorkizClient, logSyncEvent, reconcileRecentJobs, reevaluateStoredJob, replaceManualPayments, syncJobByUuid, syncTeamMappings } from "@/lib/workiz/sync"

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

const splitList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

// --- Workiz settings ---------------------------------------------------------

export async function updateWorkizSettings(form: {
  apiToken?: string
  apiSecret?: string
  payableStatuses: string
  colorSealKeywords: string
  cardMethodKeywords: string
  tipKeywords: string
  reconcileLookbackDays: number
  businessTimezone?: string
}): Promise<Result> {
  try {
    await requireAdmin()
    const patch: Parameters<typeof saveWorkizSettings>[0] = {
      payableStatuses: splitList(form.payableStatuses),
      colorSealKeywords: splitList(form.colorSealKeywords),
      cardMethodKeywords: splitList(form.cardMethodKeywords),
      tipKeywords: splitList(form.tipKeywords),
      // Below 30 days the cron silently skips jobs scheduled weeks ago and paid today (production was found at 1).
      reconcileLookbackDays: Math.min(90, Math.max(MIN_RECONCILE_LOOKBACK_DAYS, Math.round(Number(form.reconcileLookbackDays) || DEFAULT_WORKIZ_SETTINGS.reconcileLookbackDays))),
    }
    if (form.businessTimezone !== undefined) {
      const tz = form.businessTimezone.trim() || DEFAULT_BUSINESS_TIMEZONE
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz })
      } catch {
        return { ok: false, error: `"${tz}" is not a valid IANA timezone (example: America/New_York)` }
      }
      patch.businessTimezone = tz
    }
    // Blank secret fields mean "keep the existing value".
    if (form.apiToken && form.apiToken.trim()) patch.apiToken = form.apiToken.trim()
    if (form.apiSecret && form.apiSecret.trim()) patch.apiSecret = form.apiSecret.trim()
    await saveWorkizSettings(patch, "admin")
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function rotateWebhookSecret(): Promise<Result<{ secret: string }>> {
  try {
    await requireAdmin()
    const secret = generateToken()
    await saveWorkizSettings({ webhookSecret: secret }, "admin")
    revalidatePath("/admin")
    return { ok: true, data: { secret } }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Posts a Workiz-shaped `self_test` event to the public webhook URL exactly as the
 * automation would, using the most recently synced job's UUID. Proves the route is
 * deployed, reachable, that the auth key matches and that the Workiz API answers —
 * without touching any payout.
 */
export async function testWebhookEndpoint(): Promise<Result<{ summary: string }>> {
  try {
    await requireAdmin()
    const settings = await getWorkizSettings()
    if (!settings.webhookSecret) throw new Error("Generate an auth key first.")
    const [latest] = await db.select({ uuid: workizJobs.uuid, serialId: workizJobs.serialId }).from(workizJobs).orderBy(desc(workizJobs.lastSeenAt)).limit(1)
    if (!latest) throw new Error("No synced job to test with yet. Run Sync now first.")

    const url = await getWebhookUrl()
    if (!url.startsWith("http")) throw new Error("Public URL unknown in this environment. Test from the deployed site.")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.webhookSecret}` },
        body: JSON.stringify({
          trigger: { type: "self_test", timestamp: new Date().toISOString() },
          data: { uuid: latest.uuid, serialId: latest.serialId },
          metadata: { ruleName: "Admin self-test" },
        }),
        cache: "no-store",
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; summary?: string; error?: string } | null
    if (!res.ok || !body?.ok) throw new Error(body?.error ?? body?.summary ?? `Endpoint answered HTTP ${res.status}`)
    revalidatePath("/admin")
    return { ok: true, data: { summary: body.summary ?? "Self-test passed" } }
  } catch (err) {
    return fail(err)
  }
}

/** Newest webhook that Workiz itself sent (self-tests excluded), for the setup status badge. */
async function latestWorkizWebhook() {
  const [row] = await db
    .select({ createdAt: syncEvents.createdAt, ok: syncEvents.ok, summary: syncEvents.summary, kind: syncEvents.kind })
    .from(syncEvents)
    .where(and(inArray(syncEvents.kind, ["webhook", "job:webhook"]), sql`coalesce(${syncEvents.details}->>'selfTest', 'false') <> 'true'`))
    .orderBy(desc(syncEvents.createdAt))
    .limit(1)
  return row ?? null
}

export async function probeWorkiz(): Promise<Result<Awaited<ReturnType<WorkizClient["probe"]>>>> {
  try {
    await requireAdmin()
    const s = await getWorkizSettings()
    const client = new WorkizClient({ apiToken: s.apiToken, apiSecret: s.apiSecret })
    const data = await client.probe()
    await logSyncEvent("probe", { ok: true, summary: `Workiz reachable in ${data.latencyMs}ms · ${data.teamCount} team members`, details: data })
    return { ok: true, data }
  } catch (err) {
    const details = err instanceof WorkizApiError ? { status: err.status, endpoint: err.endpoint, response: err.body ?? null } : undefined
    await logSyncEvent("probe", { ok: false, summary: `Workiz probe failed: ${err instanceof Error ? err.message : String(err)}`, details })
    return fail(err)
  }
}

export async function runTeamSync(): Promise<Result<{ total: number; created: number }>> {
  try {
    await requireAdmin()
    const data = await syncTeamMappings()
    revalidatePath("/admin")
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

export async function runReconcile(lookbackDays?: number): Promise<Result<Awaited<ReturnType<typeof reconcileRecentJobs>>>> {
  try {
    await requireAdmin()
    const data = await reconcileRecentJobs({ lookbackDays, trigger: "admin" })
    revalidatePath("/admin")
    return { ok: true, data }
  } catch (err) {
    if (err instanceof SyncInProgressError) return { ok: false, error: `A sync started by ${err.holder} is still running (since ${err.since}); wait for it to finish.` }
    return fail(err)
  }
}

export async function syncSingleJob(uuid: string): Promise<Result<{ status: string | null; created: number; updated: number; held: number; notes: string[] }>> {
  try {
    await requireAdmin()
    const trimmed = uuid.trim()
    if (!trimmed) return { ok: false, error: "Job UUID is required" }
    const result = await syncJobByUuid(trimmed, "rest")
    revalidatePath("/admin")
    return {
      ok: true,
      data: {
        status: result.normalized.status,
        created: result.engine.created,
        updated: result.engine.updated,
        held: result.engine.held,
        notes: [...result.engine.notes, ...result.normalized.warnings],
      },
    }
  } catch (err) {
    return fail(err)
  }
}

// --- Customer payment confirmation ------------------------------------------

export type PaymentConfirmationOutcome = { status: string | null; payments: number; held: number; notes: string[] }

/**
 * Record what the Workiz Payments tab shows for a job when Workiz's API will not say. The
 * admin transcribes each payment (method, amount, date); the entries must add up to the
 * Workiz invoice total, are stored with the admin's name, and the job is then re-processed
 * through the normal sync path — every completion/paid/mapping check still applies, and
 * nothing here forces a payout to Ready.
 */
export async function confirmJobPayments(jobUuid: string, entries: ManualPaymentEntry[]): Promise<Result<PaymentConfirmationOutcome>> {
  try {
    await requireAdmin()
    const uuid = jobUuid.trim()
    if (!uuid) return { ok: false, error: "Job UUID is required" }
    const [job] = await db.select({ uuid: workizJobs.uuid, raw: workizJobs.raw }).from(workizJobs).where(eq(workizJobs.uuid, uuid)).limit(1)
    if (!job) return { ok: false, error: "This job has not been synced yet; sync it first" }
    const rawTotal = (job.raw as { JobTotalPrice?: unknown } | null)?.JobTotalPrice
    const invoiceTotal = rawTotal === undefined || rawTotal === null ? null : Number(rawTotal)
    const checked = validateManualPayments(entries, invoiceTotal !== null && Number.isFinite(invoiceTotal) ? invoiceTotal : null)
    if (!checked.ok) return { ok: false, error: checked.error }

    await replaceManualPayments(uuid, checked.entries, "admin")
    const result = await syncJobByUuid(uuid, "rest", { via: "payment-confirmation" })
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return {
      ok: true,
      data: {
        status: result.normalized.status,
        payments: result.normalized.payments.length,
        held: result.engine.held,
        notes: [...result.engine.notes, ...result.normalized.warnings],
      },
    }
  } catch (err) {
    return fail(err)
  }
}

/** Remove the admin-confirmed payments for a job and re-process it from Workiz data alone. */
export async function clearConfirmedPayments(jobUuid: string): Promise<Result<PaymentConfirmationOutcome>> {
  try {
    await requireAdmin()
    const uuid = jobUuid.trim()
    if (!uuid) return { ok: false, error: "Job UUID is required" }
    await replaceManualPayments(uuid, [], "admin")
    const result = await syncJobByUuid(uuid, "rest", { via: "payment-confirmation-cleared" })
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return { ok: true, data: { status: result.normalized.status, payments: result.normalized.payments.length, held: result.engine.held, notes: [...result.engine.notes, ...result.normalized.warnings] } }
  } catch (err) {
    return fail(err)
  }
}

// --- Team mapping ------------------------------------------------------------

export async function setTeamMapping(workizTeamId: string, profileId: number | null, excluded: boolean): Promise<Result> {
  try {
    await requireAdmin()
    await db
      .update(workizTeamMappings)
      .set({ profileId: excluded ? null : profileId, excluded, updatedAt: new Date(), updatedBy: "admin" })
      .where(eq(workizTeamMappings.workizTeamId, workizTeamId))
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function addManualTeamMapping(workizTeamId: string, workizName: string, profileId: number | null): Promise<Result> {
  try {
    await requireAdmin()
    const id = workizTeamId.trim()
    if (!id) return { ok: false, error: "Workiz team id is required" }
    await db
      .insert(workizTeamMappings)
      .values({ workizTeamId: id, workizName: workizName.trim() || null, profileId, source: "manual", updatedBy: "admin" })
      .onConflictDoUpdate({
        target: workizTeamMappings.workizTeamId,
        set: { profileId, workizName: workizName.trim() || null, updatedAt: new Date(), updatedBy: "admin" },
      })
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

// --- Technician profiles -----------------------------------------------------

/** Marker token (`T`); decoration like `*T*` is stripped. Null when blank. */
function normalizeMarker(input: string | null | undefined): string | null {
  if (!(input ?? "").trim()) return null
  const tokens = parseMarkerTokens(input)
  if (tokens.length === 0) throw new Error("Line-item marker needs at least one letter or digit (e.g. T)")
  if (tokens.length > 4) throw new Error("Use at most 4 marker tokens")
  for (const t of tokens) {
    if (t.length > 12) throw new Error(`Marker token "${t}" must be 12 characters or fewer`)
    if (!/^[A-Za-z0-9]+$/.test(t)) throw new Error(`Marker token "${t}" may only contain letters and digits`)
  }
  return tokens.join(", ")
}

/** Owned Work Type as typed (e.g. "Tim's Job"); compared normalized at sync time. Null when blank. */
async function normalizeOwnedWorkType(selfId: number | null, input: string | null | undefined): Promise<string | null> {
  const value = (input ?? "").replace(/\s+/g, " ").trim()
  if (!value) return null
  if (value.length > 60) throw new Error("Owned Work Type must be 60 characters or fewer")
  const others = await db.select({ id: technicianProfiles.id, name: technicianProfiles.name, owned: technicianProfiles.ownedWorkType }).from(technicianProfiles)
  const clash = others.find((o) => o.id !== selfId && workTypeMatches(o.owned, value))
  if (clash) throw new Error(`Work Type "${value}" is already owned by ${clash.name}; a Work Type can belong to one technician only`)
  return value
}

/**
 * A technician with a marker or an owned Work Type is paid on his own work only and never
 * shares tips; everyone else splits the business-held tip equally per job. The stored
 * tip_share column is kept in step for the manual calculator and old snapshots.
 */
function derivedTipShare(lineItemMarker: string | null, ownedWorkType: string | null): string {
  return lineItemMarker || ownedWorkType ? "0" : "0.5"
}

/** The technician this profile always works with; must be a different, existing profile. Null when unpaired. */
async function normalizeWorksWith(selfId: number | null, value: number | null | undefined): Promise<number | null> {
  if (value == null) return null
  if (!Number.isInteger(value)) throw new Error("Choose a technician from the list")
  if (selfId != null && value === selfId) throw new Error("A technician cannot always work with themselves")
  const [target] = await db.select({ id: technicianProfiles.id }).from(technicianProfiles).where(eq(technicianProfiles.id, value)).limit(1)
  if (!target) throw new Error("That technician profile no longer exists")
  return target.id
}

export async function updateProfile(
  id: number,
  patch: {
    nonColorRate: number
    colorRate: number
    separateColorSeal: boolean
    active: boolean
    lineItemMarker?: string | null
    ownedWorkType?: string | null
    worksWithProfileId?: number | null
    newPin?: string
  },
): Promise<Result> {
  try {
    await requireAdmin()
    const rate = (n: number) => {
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("Rates must be between 0 and 1 (e.g. 0.25 for 25%)")
      return n.toString()
    }
    const lineItemMarker = normalizeMarker(patch.lineItemMarker)
    const ownedWorkType = await normalizeOwnedWorkType(id, patch.ownedWorkType)
    const set: Partial<typeof technicianProfiles.$inferInsert> = {
      nonColorRate: rate(patch.nonColorRate),
      colorRate: rate(patch.colorRate),
      tipShare: derivedTipShare(lineItemMarker, ownedWorkType),
      separateColorSeal: patch.separateColorSeal,
      lineItemMarker,
      ownedWorkType,
      worksWithProfileId: await normalizeWorksWith(id, patch.worksWithProfileId),
      active: patch.active,
      updatedAt: new Date(),
    }
    if (patch.newPin && patch.newPin.trim()) {
      if (!/^\d{4,8}$/.test(patch.newPin.trim())) throw new Error("PIN must be 4-8 digits")
      set.pinHash = hashSecret(patch.newPin.trim())
    }
    await db.update(technicianProfiles).set(set).where(eq(technicianProfiles.id, id))
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function createProfile(input: {
  name: string
  pin: string
  nonColorRate: number
  colorRate: number
  separateColorSeal: boolean
  lineItemMarker?: string | null
  ownedWorkType?: string | null
  worksWithProfileId?: number | null
}): Promise<Result> {
  try {
    await requireAdmin()
    const name = input.name.trim()
    if (!name) throw new Error("Name is required")
    if (!/^\d{4,8}$/.test(input.pin.trim())) throw new Error("PIN must be 4-8 digits")
    const lineItemMarker = normalizeMarker(input.lineItemMarker)
    const ownedWorkType = await normalizeOwnedWorkType(null, input.ownedWorkType)
    await db.insert(technicianProfiles).values({
      name,
      pinHash: hashSecret(input.pin.trim()),
      nonColorRate: input.nonColorRate.toString(),
      colorRate: input.colorRate.toString(),
      tipShare: derivedTipShare(lineItemMarker, ownedWorkType),
      separateColorSeal: input.separateColorSeal,
      lineItemMarker,
      ownedWorkType,
      worksWithProfileId: await normalizeWorksWith(null, input.worksWithProfileId),
      active: true,
    })
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

// --- Color seal catalog ------------------------------------------------------

export async function upsertColorSealItem(productId: string, name: string, isColorSeal: boolean): Promise<Result> {
  try {
    await requireAdmin()
    const id = productId.trim()
    if (!id) throw new Error("Product id is required")
    await db
      .insert(colorSealItems)
      .values({ productId: id, name: name.trim() || null, isColorSeal, updatedBy: "admin" })
      .onConflictDoUpdate({ target: colorSealItems.productId, set: { name: name.trim() || null, isColorSeal, updatedAt: new Date(), updatedBy: "admin" } })
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function deleteColorSealItem(productId: string): Promise<Result> {
  try {
    await requireAdmin()
    await db.delete(colorSealItems).where(eq(colorSealItems.productId, productId))
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

// --- Payout review -----------------------------------------------------------

export type ReviewAction = "release" | "hold" | "void" | "reopen"

/**
 * Manual review of one payout row. Paying happens only through `recordPaidBatch`, and a
 * payout settled by a batch can only be reopened by reversing that batch, so history and the
 * Due list never disagree about what was paid.
 */
export async function reviewPayout(id: number, action: ReviewAction, note?: string): Promise<Result> {
  try {
    await requireAdmin()
    const now = new Date()
    const set: Partial<typeof payouts.$inferInsert> = { updatedAt: now, reviewedAt: now, reviewedBy: "admin" }
    if (note !== undefined) set.adminNote = note.trim() || null
    const [payout] = await db.select({ jobUuid: payouts.jobUuid, status: payouts.status, batchId: payouts.batchId }).from(payouts).where(eq(payouts.id, id)).limit(1)
    if (!payout) throw new Error("Payout not found")
    switch (action) {
      case "release": {
        if (payout.status === "paid" || payout.status === "void") throw new Error(`Payout is already ${payout.status}; use Reopen first`)
        const [job] = await db
          .select({ status: workizJobs.status, fullyPaid: workizJobs.fullyPaid, jobTotal: workizJobs.jobTotal })
          .from(workizJobs)
          .where(eq(workizJobs.uuid, payout.jobUuid))
          .limit(1)
        const blocker = releaseBlocker(job ? { status: job.status, fullyPaid: job.fullyPaid, jobTotal: Number(job.jobTotal) } : null, await getWorkizSettings())
        if (blocker) throw new Error(`Cannot release: ${blocker}`)
        set.status = "ready"
        set.holdReason = null
        break
      }
      case "hold":
        if (payout.status === "paid") throw new Error("A paid payout cannot be put on hold; reverse its payment batch instead")
        set.status = "hold"
        set.holdReason = note?.trim() || "Held by admin"
        break
      case "void":
        if (payout.status === "paid") throw new Error("A paid payout cannot be voided; reverse its payment batch instead")
        set.status = "void"
        break
      case "reopen":
        if (payout.batchId != null) throw new Error(`This payout was settled in payment batch #${payout.batchId}; undo that batch from Paid history instead`)
        set.status = "pending"
        set.paidAt = null
        set.paidBy = null
        set.settledKind = null
        // Force the next sync to recompute and re-gate instead of matching the old fingerprint.
        set.inputHash = null
        break
    }
    await db.update(payouts).set(set).where(eq(payouts.id, id))
    await logSyncEvent("review", { jobUuid: payout.jobUuid, ok: true, summary: `Payout #${id} ${action}${note?.trim() ? `: ${note.trim()}` : ""}`, details: { payoutId: id, action, from: payout.status } })
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function changeAdminPassword(current: string, next: string): Promise<Result> {
  try {
    await requireAdmin()
    if (next.length < 10) throw new Error("New password must be at least 10 characters")
    const { verifySecret } = await import("@/lib/security/crypto")
    const { getAdminSettings } = await import("@/lib/settings")
    const admin = await getAdminSettings()
    if (admin.passwordHash && !verifySecret(current, admin.passwordHash)) throw new Error("Current password is incorrect")
    await saveAdminSettings({ passwordHash: hashSecret(next) }, "admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

// --- Paying technicians: batches, undo, history ------------------------------

export type RecordPaidInput = {
  profileId: number
  items: SelectionItem[]
  method: string
  /** YYYY-MM-DD in the business timezone; today by default, earlier to record a past payment. */
  paidOn: string
  reference?: string | null
  /** Generated by the client when the selection is made, so a double tap or retry records one batch. */
  idempotencyKey: string
}

export type RecordPaidOutcome =
  | { ok: true; data: { batchId: number; total: number; count: number; replayed: boolean; profileName: string; method: string; paidOn: string } }
  | { ok: false; error: string; stale?: StaleItem[] }

/**
 * The "Paid" click. Validates the form, then settles exactly the selected payouts at exactly the
 * amounts shown, atomically. A stale selection (amount or status changed since display) records
 * nothing and returns the affected rows so the UI can refresh them and explain.
 */
export async function recordPaidBatch(input: RecordPaidInput): Promise<RecordPaidOutcome> {
  try {
    await requireAdmin()
    const settings = await getWorkizSettings()
    const today = isoDateInZone(new Date(), settings.businessTimezone || DEFAULT_BUSINESS_TIMEZONE)
    const items: SelectionItem[] = (input.items ?? []).map((i) => ({ payoutId: Math.trunc(Number(i.payoutId)), amount: round2(Number(i.amount)), inputHash: typeof i.inputHash === "string" ? i.inputHash : null }))
    if (items.some((i) => !Number.isInteger(i.payoutId) || i.payoutId <= 0 || !Number.isFinite(i.amount) || i.amount < 0)) return { ok: false, error: "Selection is malformed; reload and try again" }
    const formError = validateBatchForm({ method: input.method, paidOn: input.paidOn, today, itemCount: items.length, reference: input.reference })
    if (formError) return { ok: false, error: formError }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.idempotencyKey ?? "")) return { ok: false, error: "Missing request key; reload and try again" }
    const profileId = Math.trunc(Number(input.profileId))
    const [profile] = await db.select({ id: technicianProfiles.id, name: technicianProfiles.name }).from(technicianProfiles).where(eq(technicianProfiles.id, profileId)).limit(1)
    if (!profile) return { ok: false, error: "Technician not found" }

    const res = await recordPaymentBatch({ profileId, items, method: input.method, paidOn: input.paidOn, reference: input.reference ?? null, idempotencyKey: input.idempotencyKey, actor: "admin" })
    if (!res.ok) {
      if (res.kind === "stale") {
        return { ok: false, error: `${res.stale.length === 1 ? "One selected payout" : `${res.stale.length} selected payouts`} changed since the list was loaded; nothing was recorded. The list has been refreshed — check the amounts and click Paid again.`, stale: res.stale }
      }
      return { ok: false, error: res.error }
    }
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return { ok: true, data: { batchId: res.batch.id, total: Number(res.batch.calculatedTotal), count: res.batch.itemCount, replayed: res.replayed, profileName: profile.name, method: res.batch.method ?? input.method, paidOn: res.batch.paidOn ?? input.paidOn } }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Undo (from the success message) or a later correction (from Paid history). The batch stays in
 * history as reversed; each payout is re-evaluated from the stored job data so it lands back in
 * Due, Waiting or review according to the current facts.
 */
export async function undoPaymentBatch(batchId: number, reason?: string): Promise<Result<{ payouts: number; reevaluated: number }>> {
  try {
    await requireAdmin()
    const res = await reverseBatch(Math.trunc(Number(batchId)), "admin", reason ?? null)
    if (!res.ok) return { ok: false, error: res.error }
    let reevaluated = 0
    for (const uuid of res.jobUuids) {
      try {
        if (await reevaluateStoredJob(uuid, `undo batch #${batchId}`)) reevaluated++
      } catch (err) {
        await logSyncEvent("batch:reverse", { jobUuid: uuid, ok: false, summary: `Re-evaluation after undoing batch #${batchId} failed for ${uuid}: ${err instanceof Error ? err.message : String(err)}; the next sync will recompute it` })
      }
    }
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return { ok: true, data: { payouts: res.payoutIds.length, reevaluated } }
  } catch (err) {
    return fail(err)
  }
}

export type HistoryQuery = { profileId: number | null; search: string; from: string | null; to: string | null; kind: "all" | "payment" | "opening"; includeReversed: boolean }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const dayOrNull = (v: unknown) => (typeof v === "string" && ISO_DAY.test(v) ? v : null)

export async function queryBatches(input?: Partial<HistoryQuery>): Promise<BatchSummary[]> {
  await requireAdmin()
  const filter: BatchFilter = {
    profileId: typeof input?.profileId === "number" && Number.isInteger(input.profileId) ? input.profileId : null,
    search: (input?.search ?? "").trim().slice(0, 80),
    from: dayOrNull(input?.from),
    to: dayOrNull(input?.to),
    kind: input?.kind === "payment" || input?.kind === "opening" ? input.kind : "all",
    includeReversed: input?.includeReversed !== false,
    limit: 300,
  }
  return listBatches(filter)
}

export async function getBatchDetail(id: number): Promise<BatchSummary | null> {
  await requireAdmin()
  return getBatch(Math.trunc(Number(id)))
}

export type LegacyPaidRow = { id: number; profileId: number; profileName: string; jobUuid: string; serialId: string | null; clientName: string | null; amount: number; paidAt: Date | null; paidBy: string | null; adminNote: string | null }

/** Payouts marked paid before batches existed: shown in history, clearly labelled, never rewritten. */
async function legacyPaidRows(limit = 300): Promise<LegacyPaidRow[]> {
  const rows = await db
    .select({ id: payouts.id, profileId: payouts.profileId, profileName: technicianProfiles.name, jobUuid: payouts.jobUuid, serialId: workizJobs.serialId, clientName: workizJobs.clientName, totalPayout: payouts.totalPayout, paidAt: payouts.paidAt, paidBy: payouts.paidBy, adminNote: payouts.adminNote })
    .from(payouts)
    .leftJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id))
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .where(and(eq(payouts.status, "paid"), sql`${payouts.batchId} is null`))
    .orderBy(desc(payouts.paidAt), desc(payouts.id))
    .limit(limit)
  return rows.map((r) => ({ ...r, profileName: r.profileName ?? "Unknown", amount: round2(Number(r.totalPayout)) }))
}

// --- Opening balance (one-time) ------------------------------------------------

export async function previewOpening(cutoffAt: string): Promise<Result<Awaited<ReturnType<typeof previewOpeningBalance>>>> {
  try {
    await requireAdmin()
    const cutoff = new Date(cutoffAt)
    if (Number.isNaN(cutoff.getTime())) return { ok: false, error: "Enter a valid date and time" }
    return { ok: true, data: await previewOpeningBalance(cutoff) }
  } catch (err) {
    return fail(err)
  }
}

export async function runOpeningInitialization(cutoffAt: string): Promise<Result<{ batchIds: number[]; settled: number; calculatedTotal: number; issues: number }>> {
  try {
    await requireAdmin()
    const res = await initializeOpeningBalance(new Date(cutoffAt), "admin")
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return { ok: true, data: { batchIds: res.batchIds, settled: res.settled, calculatedTotal: res.calculatedTotal, issues: res.preview.issues.length } }
  } catch (err) {
    return fail(err)
  }
}

export async function confirmPreviouslyPaidPayouts(payoutIds: number[]): Promise<Result<{ batchIds: number[]; settled: number }>> {
  try {
    await requireAdmin()
    const data = await confirmPreviouslyPaid(payoutIds.map((n) => Math.trunc(Number(n))).filter((n) => Number.isInteger(n) && n > 0), "admin")
    revalidatePath("/admin")
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

// --- Source changes on settled payouts ----------------------------------------

export type SourceChangeRow = { id: number; payoutId: number; jobUuid: string; serialId: string | null; clientName: string | null; profileName: string; settledAmount: number | null; recomputedAmount: number | null; summary: string | null; detectedAt: Date }

async function openSourceChanges(limit = 100): Promise<SourceChangeRow[]> {
  const rows = await db
    .select({ id: payoutSourceChanges.id, payoutId: payoutSourceChanges.payoutId, jobUuid: payoutSourceChanges.jobUuid, serialId: workizJobs.serialId, clientName: workizJobs.clientName, profileName: technicianProfiles.name, settledAmount: payoutSourceChanges.settledAmount, recomputedAmount: payoutSourceChanges.recomputedAmount, summary: payoutSourceChanges.summary, detectedAt: payoutSourceChanges.detectedAt })
    .from(payoutSourceChanges)
    .leftJoin(workizJobs, eq(payoutSourceChanges.jobUuid, workizJobs.uuid))
    .leftJoin(technicianProfiles, eq(payoutSourceChanges.profileId, technicianProfiles.id))
    .where(eq(payoutSourceChanges.status, "open"))
    .orderBy(desc(payoutSourceChanges.detectedAt))
    .limit(limit)
  return rows.map((r) => ({ ...r, profileName: r.profileName ?? "Unknown", settledAmount: r.settledAmount == null ? null : round2(Number(r.settledAmount)), recomputedAmount: r.recomputedAmount == null ? null : round2(Number(r.recomputedAmount)) }))
}

export async function acknowledgeSourceChange(id: number): Promise<Result> {
  try {
    await requireAdmin()
    const [row] = await db.update(payoutSourceChanges).set({ status: "acknowledged", acknowledgedAt: new Date(), acknowledgedBy: "admin" }).where(and(eq(payoutSourceChanges.id, Math.trunc(Number(id))), eq(payoutSourceChanges.status, "open"))).returning({ jobUuid: payoutSourceChanges.jobUuid, summary: payoutSourceChanges.summary })
    if (!row) return { ok: false, error: "Already acknowledged" }
    await logSyncEvent("source-change", { jobUuid: row.jobUuid, ok: true, summary: `Acknowledged: ${row.summary ?? `source change #${id}`}` })
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

// --- Sync status -----------------------------------------------------------------

export type SyncPanel = {
  lastSuccessAt: string | null
  lastSuccessSummary: string | null
  lastAttemptAt: string | null
  lastAttemptOk: boolean | null
  lastAttemptSummary: string | null
  running: { holder: string; since: string } | null
  health: "never" | "ok" | "overdue"
  previousSlotAt: string
  nextSlotAt: string
  nextSlotLabel: string
  scheduleLabel: string
  cronConfigured: boolean
  checkedAt: string
}

async function syncPanel(): Promise<SyncPanel> {
  const status = await getSyncStatus()
  const now = new Date()
  const lastSuccess = status.lastSuccessAt ? new Date(status.lastSuccessAt) : null
  const next = nextScheduledSlot(now)
  const hours = SYNC_HOURS_LOCAL.map((h) => `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? "PM" : "AM"}`)
  return {
    ...status,
    health: syncHealth(now, lastSuccess),
    previousSlotAt: previousScheduledSlot(now).toISOString(),
    nextSlotAt: next.toISOString(),
    nextSlotLabel: formatSlot(next),
    scheduleLabel: `${hours.join(" and ")} Eastern, every day`,
    cronConfigured: Boolean(process.env.CRON_SECRET),
    checkedAt: now.toISOString(),
  }
}

/** Polled by the dashboard on focus/resume so the header reflects the server, not a cached page. */
export async function fetchSyncPanel(): Promise<SyncPanel> {
  await requireAdmin()
  return syncPanel()
}

// --- Read models for the admin dashboard ------------------------------------

function sanitizeQuery(input: Partial<PayoutQuery> | undefined): PayoutQuery {
  const status = PAYOUT_STATUS_FILTERS.includes(input?.status as PayoutQuery["status"]) ? (input!.status as PayoutQuery["status"]) : "all"
  const profileId = typeof input?.profileId === "number" && Number.isInteger(input.profileId) ? input.profileId : null
  const search = (input?.search ?? "").trim().slice(0, 80)
  const pageSize = Math.min(100, Math.max(5, Math.round(Number(input?.pageSize) || DEFAULT_PAYOUT_QUERY.pageSize)))
  const page = Math.max(1, Math.round(Number(input?.page) || 1))
  return { status, profileId, search, page, pageSize }
}

function payoutQueryWhere(q: PayoutQuery): SQL | undefined {
  const conditions: SQL[] = []
  if (q.status !== "all") conditions.push(eq(payouts.status, q.status))
  if (q.profileId != null) conditions.push(eq(payouts.profileId, q.profileId))
  if (q.search) {
    const like = `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    const bySerial = ilike(workizJobs.serialId, like)
    const byClient = ilike(workizJobs.clientName, like)
    const byUuid = ilike(payouts.jobUuid, like)
    conditions.push(or(bySerial, byClient, byUuid) as SQL)
  }
  return conditions.length ? and(...conditions) : undefined
}

/**
 * Individual job-technician payout records with everything the detail panel shows. Read-only.
 * Shared by the paged review list and the Due board so both describe a payout identically.
 */
async function payoutRecords(where: SQL | undefined, opts: { limit: number; offset?: number; order?: "recent" | "completion" }) {
  const settings = await getWorkizSettings()
  const rows = await db
    .select({
      payout: payouts,
      profileName: technicianProfiles.name,
      profileMarker: technicianProfiles.lineItemMarker,
      job: {
        uuid: workizJobs.uuid,
        serialId: workizJobs.serialId,
        status: workizJobs.status,
        subStatus: workizJobs.subStatus,
        paymentDueDate: workizJobs.paymentDueDate,
        jobDateTime: workizJobs.jobDateTime,
        jobEndDateTime: workizJobs.jobEndDateTime,
        clientName: workizJobs.clientName,
        address: workizJobs.address,
        jobType: workizJobs.jobType,
        jobTotal: workizJobs.jobTotal,
        subTotal: workizJobs.subTotal,
        taxAmount: workizJobs.taxAmount,
        discountAmount: workizJobs.discountAmount,
        colorSealTotal: workizJobs.colorSealTotal,
        cardServiceAmount: workizJobs.cardServiceAmount,
        nonCardServiceAmount: workizJobs.nonCardServiceAmount,
        cardTipAmount: workizJobs.cardTipAmount,
        nonCardTipAmount: workizJobs.nonCardTipAmount,
        totalPaid: workizJobs.totalPaid,
        fullyPaid: workizJobs.fullyPaid,
        invoiceStatus: workizJobs.invoiceStatus,
        teamIds: workizJobs.teamIds,
        teamNames: workizJobs.teamNames,
        lineItems: workizJobs.lineItems,
        payments: workizJobs.payments,
        lastSeenAt: workizJobs.lastSeenAt,
        updatedAt: workizJobs.updatedAt,
        lastStatusUpdate: sql<string | null>`${workizJobs.raw}->>'LastStatusUpdate'`,
        amountDue: sql<string | null>`${workizJobs.raw}->>'JobAmountDue'`,
        invoiceTotal: sql<string | null>`${workizJobs.raw}->>'JobTotalPrice'`,
      },
    })
    .from(payouts)
    .leftJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id))
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .where(where)
    .orderBy(...(opts.order === "completion" ? [sql`${workizJobs.raw}->>'LastStatusUpdate' asc nulls last`, payouts.id] : [desc(payouts.updatedAt), desc(payouts.id)]))
    .limit(opts.limit)
    .offset(opts.offset ?? 0)

  // Other technicians paid on the same job, so a shared job is visibly one record per technician.
  const jobUuids = Array.from(new Set(rows.map((r) => r.payout.jobUuid)))
  const siblings = jobUuids.length
    ? await db
        .select({ id: payouts.id, jobUuid: payouts.jobUuid, profileId: payouts.profileId, status: payouts.status, totalPayout: payouts.totalPayout, segmentKind: payouts.segmentKind, segmentMarker: payouts.segmentMarker, profileName: technicianProfiles.name })
        .from(payouts)
        .leftJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id))
        .where(inArray(payouts.jobUuid, jobUuids))
    : []

  const timeZone = settings.businessTimezone || DEFAULT_BUSINESS_TIMEZONE
  return rows.map((r) => {
    const raw = r.job?.uuid ? r.job : null
    const job = raw
      ? {
          ...raw,
          lastStatusUpdate: parseWorkizDate(raw.lastStatusUpdate, timeZone),
          amountDue: raw.amountDue === null || raw.amountDue === undefined || raw.amountDue === "" ? null : Number(raw.amountDue),
          invoiceTotal: raw.invoiceTotal === null || raw.invoiceTotal === undefined || raw.invoiceTotal === "" ? null : Number(raw.invoiceTotal),
        }
      : null
    return {
      ...r.payout,
      profileName: r.profileName ?? "Unknown",
      profileMarker: r.profileMarker ?? null,
      /** The amount the owner sees and settles: the stored payout rounded to cents. */
      amount: round2(Number(r.payout.totalPayout)),
      job,
      completion: job ? completionState({ status: job.status, payableStatuses: settings.payableStatuses, lastStatusUpdate: job.lastStatusUpdate }) : null,
      openingReview: isOpeningReviewHold(r.payout.holdReason),
      siblings: siblings.filter((s) => s.jobUuid === r.payout.jobUuid && s.id !== r.payout.id).map((s) => ({ ...s, profileName: s.profileName ?? "Unknown" })),
    }
  })
}

/**
 * One page of payout records. The same WHERE clause drives `total`, so a count and the list it
 * opens always agree, across every page.
 */
export async function queryPayouts(input?: Partial<PayoutQuery>) {
  await requireAdmin()
  const q = sanitizeQuery(input)
  const where = payoutQueryWhere(q)
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(payouts)
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .where(where)
  const items = await payoutRecords(where, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })
  return { items, total, page: q.page, pageSize: q.pageSize, query: q }
}

export type PayoutPage = Awaited<ReturnType<typeof queryPayouts>>
export type PayoutRecord = PayoutPage["items"][number]

export type DueTechnician = { profileId: number; name: string; count: number; total: number; jobs: PayoutRecord[] }
export type DueBoard = { technicians: DueTechnician[]; loadedAt: string }

/**
 * Everything currently owed, per technician: every Ready payout, oldest completion first, with
 * the technician's total as the sum of the rounded individual amounts. Never mixes technicians.
 */
export async function loadDueBoard(): Promise<DueBoard> {
  await requireAdmin()
  const rows = await payoutRecords(eq(payouts.status, "ready"), { limit: 1000, order: "completion" })
  const byTech = new Map<number, DueTechnician>()
  for (const row of rows) {
    const tech = byTech.get(row.profileId) ?? { profileId: row.profileId, name: row.profileName, count: 0, total: 0, jobs: [] }
    tech.jobs.push(row)
    tech.count++
    byTech.set(row.profileId, tech)
  }
  const technicians = Array.from(byTech.values())
    .map((t) => ({ ...t, total: t.jobs.reduce((cents, j) => cents + Math.round(j.amount * 100), 0) / 100 }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { technicians, loadedAt: new Date().toISOString() }
}

/** Individual payout-record counts per technician and status, over every payout ever stored. */
async function payoutStatusCounts() {
  return db
    .select({
      profileId: payouts.profileId,
      status: payouts.status,
      count: sql<number>`count(*)`.mapWith(Number),
      total: sql<number>`coalesce(sum(${payouts.totalPayout}), 0)`.mapWith(Number),
    })
    .from(payouts)
    .groupBy(payouts.profileId, payouts.status)
}

export type WaitingSummary = {
  /** Job finished, customer still owes money. */
  customerUnpaid: number
  /** Job not finished in Workiz yet. */
  notFinished: number
  /** Workiz payment method unknown ("Other" or no payment records): owner classifies. */
  methodReview: number
  /** Pre-cutoff work first seen after the initialization: confirm previously paid or release. */
  openingReview: number
  /** Every other hold: unmapped team members, tip allocation, discounts, calculation checks. */
  otherHolds: number
}

/** Why open payouts are not Due yet, bucketed so payment-method review stays apart from technical problems. */
async function waitingSummary(): Promise<WaitingSummary> {
  const settings = await getWorkizSettings()
  const rows = await db
    .select({ status: payouts.status, holdReason: payouts.holdReason, jobStatus: workizJobs.status, fullyPaid: workizJobs.fullyPaid })
    .from(payouts)
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .where(inArray(payouts.status, ["pending", "hold"]))
  const out: WaitingSummary = { customerUnpaid: 0, notFinished: 0, methodReview: 0, openingReview: 0, otherHolds: 0 }
  for (const r of rows) {
    const payable = Boolean(r.jobStatus) && settings.payableStatuses.some((s) => s.toLowerCase() === String(r.jobStatus).toLowerCase())
    if (r.status === "hold") {
      if (isOpeningReviewHold(r.holdReason)) out.openingReview++
      else if (/payment method|unknown method|method unknown/i.test(r.holdReason ?? "")) out.methodReview++
      else out.otherHolds++
    } else if (!payable) out.notFinished++
    else if (!r.fullyPaid) out.customerUnpaid++
    else out.otherHolds++
  }
  return out
}

/** Jobs (and their customers) that reference a Workiz team id nobody has mapped yet. */
async function unmappedTeamImpact(teamIds: string[]) {
  if (teamIds.length === 0) return {} as Record<string, Array<{ uuid: string; serialId: string | null; clientName: string | null; status: string | null; jobDateTime: Date | null }>>
  const rows = await db
    .select({
      uuid: workizJobs.uuid,
      serialId: workizJobs.serialId,
      clientName: workizJobs.clientName,
      status: workizJobs.status,
      jobDateTime: workizJobs.jobDateTime,
      teamIds: workizJobs.teamIds,
    })
    .from(workizJobs)
    .where(sql`${workizJobs.teamIds} ?| array[${sql.join(teamIds.map((id) => sql`${id}`), sql`, `)}]::text[]`)
    .orderBy(desc(workizJobs.jobDateTime))
  const impact: Record<string, Array<{ uuid: string; serialId: string | null; clientName: string | null; status: string | null; jobDateTime: Date | null }>> = {}
  for (const id of teamIds) impact[id] = []
  for (const row of rows) {
    for (const id of row.teamIds ?? []) {
      if (impact[id]) impact[id].push({ uuid: row.uuid, serialId: row.serialId, clientName: row.clientName, status: row.status, jobDateTime: row.jobDateTime })
    }
  }
  return impact
}

export async function loadAdminDashboard() {
  await requireAdmin()
  const [profiles, mappings, catalog, workiz, payoutSettings, events, statusCounts, due, batches, legacyPaid, waiting, sourceChanges, sync, lastWebhook, webhookLog, webhookCounts] = await Promise.all([
    listProfiles(),
    db.select().from(workizTeamMappings).orderBy(desc(workizTeamMappings.updatedAt)),
    db.select().from(colorSealItems).orderBy(colorSealItems.productId),
    getWorkizSettings(),
    getPayoutSettings(),
    db.select().from(syncEvents).orderBy(desc(syncEvents.createdAt)).limit(40),
    payoutStatusCounts(),
    loadDueBoard(),
    listBatches({ includeReversed: true, kind: "all", limit: 300 }),
    legacyPaidRows(),
    waitingSummary(),
    openSourceChanges(),
    syncPanel(),
    latestWorkizWebhook(),
    recentWebhookEvents(25),
    countWebhookEventsByStatus(),
  ])

  const unmappedIds = mappings.filter((m) => m.profileId == null && !m.excluded).map((m) => m.workizTeamId)
  const unmappedImpact = await unmappedTeamImpact(unmappedIds)

  return {
    profiles: profiles.map((p) => ({ ...p, pinHash: undefined })),
    mappings,
    unmappedImpact,
    catalog,
    workiz: {
      hasApiToken: Boolean(workiz.apiToken),
      hasApiSecret: Boolean(workiz.apiSecret),
      // Format-only checks so the UI can flag a paste into the wrong box without exposing the values.
      apiTokenLooksValid: /^api_[A-Za-z0-9]{8,}$/.test(workiz.apiToken),
      apiSecretLooksValid: /^sec_[A-Za-z0-9]{8,}$/.test(workiz.apiSecret),
      hasWebhookSecret: Boolean(workiz.webhookSecret),
      webhookSecret: workiz.webhookSecret,
      lastWebhook,
      payableStatuses: workiz.payableStatuses,
      colorSealKeywords: workiz.colorSealKeywords,
      cardMethodKeywords: workiz.cardMethodKeywords,
      tipKeywords: workiz.tipKeywords,
      reconcileLookbackDays: workiz.reconcileLookbackDays,
      effectiveLookbackDays: Math.max(MIN_RECONCILE_LOOKBACK_DAYS, workiz.reconcileLookbackDays),
      businessTimezone: workiz.businessTimezone || DEFAULT_BUSINESS_TIMEZONE,
      webhookLog: webhookLog.map((e) => ({ id: e.id, receivedAt: e.receivedAt, triggerType: e.triggerType, ruleName: e.ruleName, kind: e.kind, jobUuid: e.jobUuid, jobInternalId: e.jobInternalId, serialId: e.serialId, status: e.status, error: e.error })),
      webhookCounts,
    },
    opening: payoutSettings,
    events,
    statusCounts,
    due,
    batches,
    legacyPaid,
    waiting,
    sourceChanges,
    sync,
    paymentMethods: TECH_PAYMENT_METHODS,
  }
}

export type AdminDashboardData = Awaited<ReturnType<typeof loadAdminDashboard>>
