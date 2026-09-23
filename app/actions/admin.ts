"use server"

import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import {
  colorSealItems,
  ownerNotifications,
  payouts,
  syncEvents,
  technicianProfiles,
  workizJobs,
  workizTeamMappings,
} from "@/lib/db/schema"
import { confirmOwnerDelivered, getOwnerNotification, loadOwnerInput, refreshOwnerNotification, sendOwnerNotificationNow, sendOwnerTest } from "@/lib/notifications/owner"
import { evaluateOwnerNotification } from "@/lib/notifications/owner-message"
import { releaseBlocker } from "@/lib/payout/engine"
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
  getNotificationSettings,
  getWorkizSettings,
  maskPhone,
  saveAdminSettings,
  saveNotificationSettings,
  saveWorkizSettings,
} from "@/lib/settings"
import { WorkizApiError, WorkizClient } from "@/lib/workiz/client"
import { countWebhookEventsByStatus, recentWebhookEvents } from "@/lib/workiz/events"
import { validateManualPayments, type ManualPaymentEntry } from "@/lib/workiz/payments"
import { parseWorkizDate } from "@/lib/workiz/time"
import { MIN_RECONCILE_LOOKBACK_DAYS, getWorkizClient, logSyncEvent, reconcileRecentJobs, replaceManualPayments, syncJobByUuid, syncTeamMappings } from "@/lib/workiz/sync"
import { DEFAULT_PAYOUT_READY_TAG, normalizeTagName } from "@/lib/workiz/tags"

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

export async function updatePayoutTagSettings(form: { enabled: boolean; tag: string }): Promise<Result<{ tag: string }>> {
  try {
    await requireAdmin()
    const tag = normalizeTagName(form.tag) || DEFAULT_PAYOUT_READY_TAG
    if (tag.length > 60) throw new Error("Tag name is too long (max 60 characters).")
    await saveWorkizSettings({ payoutReadyTagEnabled: Boolean(form.enabled), payoutReadyTag: tag }, "admin")
    await logSyncEvent("settings", { ok: true, summary: `Payout-ready tagging ${form.enabled ? "enabled" : "disabled"} · tag "${tag}"` })
    revalidatePath("/admin")
    return { ok: true, data: { tag } }
  } catch (err) {
    return fail(err)
  }
}

/**
 * "Send test to owner": tag one real job and write a clearly labelled TEST block (no amounts)
 * so the owner's Workiz automation fires once. The tag cannot be removed through the API, so
 * the admin should pick a job that is already paid out. Never touches the payout outbox.
 */
export async function tagJobForPayoutTest(jobRef: string): Promise<Result<{ summary: string }>> {
  try {
    await requireAdmin()
    const ref = jobRef.trim()
    if (!ref) throw new Error("Enter a job number or UUID.")
    const where = /^\d+$/.test(ref) ? eq(workizJobs.serialId, ref) : eq(workizJobs.uuid, ref)
    const [job] = await db.select({ uuid: workizJobs.uuid }).from(workizJobs).where(where).limit(1)
    if (!job) throw new Error(`Job ${ref} has not been synced yet. Run Sync now, or paste the job's UUID.`)
    const outcome = await sendOwnerTest(job.uuid)
    revalidatePath("/admin")
    if (!outcome.tagApplied && !outcome.tagWasPresent) throw new Error(outcome.summary)
    return { ok: true, data: { summary: outcome.summary } }
  } catch (err) {
    return fail(err)
  }
}

/** Newest payout-ready tagging attempt, for the text-alerts status badge. */
async function latestTagEvent() {
  const [row] = await db
    .select({ createdAt: syncEvents.createdAt, ok: syncEvents.ok, summary: syncEvents.summary })
    .from(syncEvents)
    .where(eq(syncEvents.kind, "job:tag"))
    .orderBy(desc(syncEvents.createdAt))
    .limit(1)
  return row ?? null
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
    const data = await reconcileRecentJobs({ lookbackDays })
    revalidatePath("/admin")
    return { ok: true, data }
  } catch (err) {
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

export async function reviewPayout(id: number, action: "release" | "hold" | "void" | "mark-paid" | "reopen", note?: string): Promise<Result> {
  try {
    await requireAdmin()
    const now = new Date()
    const set: Partial<typeof payouts.$inferInsert> = { updatedAt: now, reviewedAt: now, reviewedBy: "admin" }
    if (note !== undefined) set.adminNote = note.trim() || null
    switch (action) {
      case "release": {
        const [payout] = await db.select({ jobUuid: payouts.jobUuid, status: payouts.status }).from(payouts).where(eq(payouts.id, id)).limit(1)
        if (!payout) throw new Error("Payout not found")
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
        set.status = "hold"
        set.holdReason = note?.trim() || "Held by admin"
        break
      case "void":
        set.status = "void"
        break
      case "mark-paid":
        set.status = "paid"
        set.paidAt = now
        set.paidBy = "admin"
        break
      case "reopen":
        set.status = "pending"
        set.paidAt = null
        set.paidBy = null
        // Force the next sync to recompute and re-gate instead of matching the old fingerprint.
        set.inputHash = null
        break
    }
    await db.update(payouts).set(set).where(eq(payouts.id, id))
    // Any review action changes what the owner text should say (or whether it is due), so the
    // job's outbox row is re-evaluated; a release delivers right away when texts are enabled.
    const [changed] = await db.select({ jobUuid: payouts.jobUuid }).from(payouts).where(eq(payouts.id, id)).limit(1)
    if (changed) {
      try {
        await refreshOwnerNotification(changed.jobUuid, { via: `admin ${action}` })
      } catch (err) {
        await logSyncEvent("owner-notify", { jobUuid: changed.jobUuid, ok: false, summary: `Owner text refresh after ${action} failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function bulkMarkPaid(ids: number[]): Promise<Result<{ count: number }>> {
  try {
    await requireAdmin()
    if (ids.length === 0) return { ok: true, data: { count: 0 } }
    const now = new Date()
    const updated = await db
      .update(payouts)
      .set({ status: "paid", paidAt: now, paidBy: "admin", updatedAt: now })
      .where(and(inArray(payouts.id, ids), eq(payouts.status, "ready")))
      .returning({ id: payouts.id })
    revalidatePath("/admin")
    revalidatePath("/payouts")
    return { ok: true, data: { count: updated.length } }
  } catch (err) {
    return fail(err)
  }
}

// --- Owner texts -------------------------------------------------------------

export type OwnerRecipientCandidate = { workizTeamId: string; name: string; role: string | null; phoneMasked: string | null; hasPhone: boolean }

/**
 * Workiz team members the owner text can go to, with masked phones. The SMS is addressed by the
 * owner's Workiz automation; this choice records WHO that automation texts so the app can show
 * it and refuse to report "sent" while nobody is configured.
 */
export async function listOwnerRecipientCandidates(): Promise<Result<OwnerRecipientCandidate[]>> {
  try {
    await requireAdmin()
    const { client } = await getWorkizClient()
    const team = await client.listTeam()
    const data = team
      .filter((m) => m.id)
      .map((m) => ({ workizTeamId: m.id, name: m.name, role: m.role, phoneMasked: maskPhone(m.phone), hasPhone: Boolean(maskPhone(m.phone)) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

export async function setOwnerRecipient(workizTeamId: string | null): Promise<Result<{ name: string | null }>> {
  try {
    await requireAdmin()
    if (!workizTeamId) {
      await saveNotificationSettings({ ownerRecipient: null }, "admin")
      await logSyncEvent("settings", { ok: true, summary: "Owner text recipient cleared" })
      revalidatePath("/admin")
      return { ok: true, data: { name: null } }
    }
    const { client } = await getWorkizClient()
    const member = (await client.listTeam()).find((m) => m.id === workizTeamId)
    if (!member) throw new Error("That team member is not in Workiz any more; refresh the list.")
    const phoneMasked = maskPhone(member.phone)
    await saveNotificationSettings({ ownerRecipient: { workizTeamId: member.id, name: member.name, phoneMasked } }, "admin")
    await logSyncEvent("settings", { ok: true, summary: `Owner text recipient set to ${member.name}${phoneMasked ? ` (${phoneMasked})` : " (no phone on the Workiz profile)"}` })
    revalidatePath("/admin")
    return { ok: true, data: { name: member.name } }
  } catch (err) {
    return fail(err)
  }
}

/** Current owner text for a job, re-evaluated now, without sending. */
export async function previewOwnerText(jobUuid: string): Promise<Result<{ state: string; reason: string | null; message: string | null }>> {
  try {
    await requireAdmin()
    const input = await loadOwnerInput(jobUuid, await getWorkizSettings(), await getNotificationSettings())
    if (!input) throw new Error("Job has not been synced yet")
    const decision = evaluateOwnerNotification(input)
    return { ok: true, data: { state: decision.state, reason: decision.state === "ready" ? null : decision.reason, message: decision.message } }
  } catch (err) {
    return fail(err)
  }
}

export type SendPayoutOutcome = { status: string; outcome: string; detail: string }

/** Admin "Send payout to owner" for one job; `force` re-sends after an earlier delivery. */
export async function sendPayoutToOwner(jobUuid: string, force = false): Promise<Result<SendPayoutOutcome>> {
  try {
    await requireAdmin()
    const res = await sendOwnerNotificationNow(jobUuid, { force, via: force ? "admin-resend" : "admin-send" })
    revalidatePath("/admin")
    revalidatePath("/payouts")
    const d = res.delivery
    const detail =
      d.outcome === "provider_accepted"
        ? d.reconciled
          ? "Workiz already had the tag and summary on this job; recorded as accepted (no second text)."
          : `Workiz accepted the tag and summary${d.descriptionWritten ? "" : " (summary did not appear in the description)"}. Your Workiz automation sends the SMS; delivery is unconfirmed until you confirm receipt.`
        : d.outcome === "failed"
          ? `${d.error}${d.retryAt ? ` Retry scheduled ${d.retryAt.toISOString()}.` : ""}`
          : d.outcome === "not_eligible"
            ? d.reason
            : d.reason
    return { ok: true, data: { status: res.row?.status ?? "unknown", outcome: d.outcome, detail } }
  } catch (err) {
    return fail(err)
  }
}

export async function confirmOwnerTextReceived(id: number): Promise<Result> {
  try {
    await requireAdmin()
    const row = await confirmOwnerDelivered(id, "admin")
    if (!row) throw new Error("Only a text Workiz has accepted can be confirmed as received")
    await logSyncEvent("owner-notify", { jobUuid: row.jobUuid, ok: true, summary: `Owner confirmed receipt of the payout text for job ${row.jobUuid}` })
    revalidatePath("/admin")
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

// --- Read models for the admin dashboard ------------------------------------

/** The job-level owner text row for each job, keyed by job UUID. */
async function ownerTextByJob(jobUuids: string[]) {
  const unique = Array.from(new Set(jobUuids))
  const rows = unique.length ? await db.select().from(ownerNotifications).where(inArray(ownerNotifications.jobUuid, unique)) : []
  return new Map(rows.map((r) => [r.jobUuid, r]))
}

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
 * One page of individual job-technician payout records with everything the
 * detail panel shows. Read-only: never touches payouts, payments or messages.
 * The same WHERE clause drives `total`, so a summary card count and the list
 * it opens always agree, across every page.
 */
export async function queryPayouts(input?: Partial<PayoutQuery>) {
  await requireAdmin()
  const q = sanitizeQuery(input)
  const where = payoutQueryWhere(q)
  const settings = await getWorkizSettings()

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(payouts)
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .where(where)

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
    .orderBy(desc(payouts.updatedAt), desc(payouts.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize)

  const ownerByJob = await ownerTextByJob(rows.map((r) => r.payout.jobUuid))

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
  const items = rows.map((r) => {
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
      job,
      completion: job ? completionState({ status: job.status, payableStatuses: settings.payableStatuses, lastStatusUpdate: job.lastStatusUpdate }) : null,
      ownerText: ownerByJob.get(r.payout.jobUuid) ?? null,
      siblings: siblings.filter((s) => s.jobUuid === r.payout.jobUuid && s.id !== r.payout.id).map((s) => ({ ...s, profileName: s.profileName ?? "Unknown" })),
    }
  })

  return { items, total, page: q.page, pageSize: q.pageSize, query: q }
}

export type PayoutPage = Awaited<ReturnType<typeof queryPayouts>>
export type PayoutRecord = PayoutPage["items"][number]

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

/** Newest reconcile run (cron or manual), successful or not, plus the newest successful one. */
async function reconcileDiagnostics() {
  const [last] = await db.select({ createdAt: syncEvents.createdAt, ok: syncEvents.ok, summary: syncEvents.summary, details: syncEvents.details }).from(syncEvents).where(eq(syncEvents.kind, "reconcile")).orderBy(desc(syncEvents.createdAt)).limit(1)
  const [lastOk] = await db.select({ createdAt: syncEvents.createdAt, summary: syncEvents.summary }).from(syncEvents).where(and(eq(syncEvents.kind, "reconcile"), eq(syncEvents.ok, true))).orderBy(desc(syncEvents.createdAt)).limit(1)
  const [lastJobSync] = await db.select({ createdAt: syncEvents.createdAt }).from(syncEvents).where(inArray(syncEvents.kind, ["job:rest", "job:webhook"])).orderBy(desc(syncEvents.createdAt)).limit(1)
  const d = (last?.details ?? null) as { lookbackDays?: number; revisited?: number; outbox?: { considered: number; accepted: number; failed: number } } | null
  return {
    last: last ? { createdAt: last.createdAt, ok: last.ok, summary: last.summary, lookbackDays: d?.lookbackDays ?? null, revisited: d?.revisited ?? null, outbox: d?.outbox ?? null } : null,
    lastSuccessfulAt: lastOk?.createdAt ?? null,
    lastJobSyncAt: lastJobSync?.createdAt ?? null,
  }
}

/** Every job-level owner text, newest first, with the job facts the diagnostics table shows. */
async function ownerTextRows(limit = 100) {
  const rows = await db
    .select({
      row: ownerNotifications,
      job: { serialId: workizJobs.serialId, clientName: workizJobs.clientName, status: workizJobs.status, jobTotal: workizJobs.jobTotal, payments: workizJobs.payments, fullyPaid: workizJobs.fullyPaid },
    })
    .from(ownerNotifications)
    .leftJoin(workizJobs, eq(ownerNotifications.jobUuid, workizJobs.uuid))
    .orderBy(desc(ownerNotifications.updatedAt))
    .limit(limit)
  return rows.map((r) => ({ ...r.row, job: r.job, paymentSource: paymentSourceSummary(r.job?.payments) }))
}

function paymentSourceSummary(payments: unknown): string {
  const list = Array.isArray(payments) ? (payments as Array<{ source?: string; isTip?: boolean }>) : []
  const service = list.filter((p) => !p.isTip)
  if (service.length === 0) return "none (Workiz balance only)"
  const sources = Array.from(new Set(service.map((p) => p.source ?? "workiz-job")))
  return sources.map((s) => (s === "invoice-webhook" ? "invoice webhook" : s === "estimate-webhook" ? "estimate webhook" : s === "manual" ? "admin recovery entry" : "job payload")).join(" + ")
}

export async function loadAdminDashboard() {
  await requireAdmin()
  const [profiles, mappings, catalog, workiz, notif, events, statusCounts, payoutPage, lastWebhook, lastTagEvent, reconcile, ownerTexts, webhookLog, webhookCounts] = await Promise.all([
    listProfiles(),
    db.select().from(workizTeamMappings).orderBy(desc(workizTeamMappings.updatedAt)),
    db.select().from(colorSealItems).orderBy(colorSealItems.productId),
    getWorkizSettings(),
    getNotificationSettings(),
    db.select().from(syncEvents).orderBy(desc(syncEvents.createdAt)).limit(40),
    payoutStatusCounts(),
    queryPayouts(DEFAULT_PAYOUT_QUERY),
    latestWorkizWebhook(),
    latestTagEvent(),
    reconcileDiagnostics(),
    ownerTextRows(),
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
      payoutReadyTagEnabled: workiz.payoutReadyTagEnabled,
      payoutReadyTag: workiz.payoutReadyTag,
      lastTagEvent,
    },
    ownerTexts: {
      recipient: notif.ownerRecipient,
      sendEnabled: workiz.payoutReadyTagEnabled,
      tag: workiz.payoutReadyTag,
      hasCredentials: Boolean(workiz.apiToken && workiz.apiSecret),
      rows: ownerTexts,
      reconcile,
      webhookLog: webhookLog.map((e) => ({ id: e.id, receivedAt: e.receivedAt, triggerType: e.triggerType, ruleName: e.ruleName, kind: e.kind, jobUuid: e.jobUuid, jobInternalId: e.jobInternalId, serialId: e.serialId, status: e.status, error: e.error, payments: paymentCountOf(e.payload) })),
      webhookCounts,
    },
    events,
    statusCounts,
    payoutPage,
  }
}

function paymentCountOf(payload: unknown): number | null {
  const data = (payload as { data?: { payments?: unknown } } | null)?.data
  return Array.isArray(data?.payments) ? data.payments.length : null
}

export type AdminDashboardData = Awaited<ReturnType<typeof loadAdminDashboard>>
