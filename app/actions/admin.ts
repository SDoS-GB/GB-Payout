"use server"

import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import {
  colorSealItems,
  notifications,
  payouts,
  syncEvents,
  technicianProfiles,
  workizJobs,
  workizTeamMappings,
} from "@/lib/db/schema"
import { notifyPayout } from "@/lib/notifications/send"
import { buildTemplateContext, renderTemplate } from "@/lib/notifications/template"
import { releaseBlocker } from "@/lib/payout/engine"
import { listProfiles } from "@/lib/payout/profiles"
import {
  DEFAULT_BUSINESS_TIMEZONE,
  DEFAULT_PAYOUT_QUERY,
  PAYOUT_STATUS_FILTERS,
  completionState,
  type PayoutQuery,
} from "@/lib/payout/presentation"
import { parseMarkerTokens } from "@/lib/payout/segments"
import { getWebhookUrl } from "@/lib/public-origin"
import { generateToken, hashSecret } from "@/lib/security/crypto"
import { requireAdmin } from "@/lib/security/session"
import {
  getNotificationSettings,
  getWorkizSettings,
  saveAdminSettings,
  saveNotificationSettings,
  saveWorkizSettings,
  type NotificationSettings,
} from "@/lib/settings"
import { WorkizApiError, WorkizClient } from "@/lib/workiz/client"
import { parseWorkizDate } from "@/lib/workiz/time"
import { logSyncEvent, reconcileRecentJobs, syncJobByUuid, syncTeamMappings } from "@/lib/workiz/sync"

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
      reconcileLookbackDays: Math.min(90, Math.max(1, Math.round(Number(form.reconcileLookbackDays) || 14))),
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

/** Marker tokens (`T, Tim`); decoration like `*T*` is stripped. Null when blank. */
function normalizeMarker(input: string | null | undefined): string | null {
  if (!(input ?? "").trim()) return null
  const tokens = parseMarkerTokens(input)
  if (tokens.length === 0) throw new Error("Line-item marker needs at least one letter or digit (e.g. T or T, Tim)")
  if (tokens.length > 4) throw new Error("Use at most 4 marker tokens")
  for (const t of tokens) {
    if (t.length > 12) throw new Error(`Marker token "${t}" must be 12 characters or fewer`)
    if (!/^[A-Za-z0-9]+$/.test(t)) throw new Error(`Marker token "${t}" may only contain letters and digits`)
  }
  return tokens.join(", ")
}

export async function updateProfile(
  id: number,
  patch: { nonColorRate: number; colorRate: number; tipShare: number; separateColorSeal: boolean; active: boolean; lineItemMarker?: string | null; newPin?: string },
): Promise<Result> {
  try {
    await requireAdmin()
    const rate = (n: number) => {
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("Rates must be between 0 and 1 (e.g. 0.25 for 25%)")
      return n.toString()
    }
    const set: Partial<typeof technicianProfiles.$inferInsert> = {
      nonColorRate: rate(patch.nonColorRate),
      colorRate: rate(patch.colorRate),
      tipShare: rate(patch.tipShare),
      separateColorSeal: patch.separateColorSeal,
      lineItemMarker: normalizeMarker(patch.lineItemMarker),
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
  tipShare: number
  separateColorSeal: boolean
  lineItemMarker?: string | null
}): Promise<Result> {
  try {
    await requireAdmin()
    const name = input.name.trim()
    if (!name) throw new Error("Name is required")
    if (!/^\d{4,8}$/.test(input.pin.trim())) throw new Error("PIN must be 4-8 digits")
    await db.insert(technicianProfiles).values({
      name,
      pinHash: hashSecret(input.pin.trim()),
      nonColorRate: input.nonColorRate.toString(),
      colorRate: input.colorRate.toString(),
      tipShare: input.tipShare.toString(),
      separateColorSeal: input.separateColorSeal,
      lineItemMarker: normalizeMarker(input.lineItemMarker),
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
    // A release makes the payout ready, so it gets the same ready-to-pay message a sync would
    // produce; notifyPayout only previews unless sending is enabled and never delivers twice.
    if (action === "release") await notifyPayout(id)
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

// --- Notifications -----------------------------------------------------------

export async function updateNotificationSettings(patch: Partial<NotificationSettings>): Promise<Result> {
  try {
    await requireAdmin()
    await saveNotificationSettings(patch, "admin")
    revalidatePath("/admin")
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function previewNotification(payoutId: number): Promise<Result<{ message: string }>> {
  try {
    await requireAdmin()
    const [payout] = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1)
    if (!payout) throw new Error("Payout not found")
    const [profile] = await db.select().from(technicianProfiles).where(eq(technicianProfiles.id, payout.profileId)).limit(1)
    if (!profile) throw new Error("Profile not found")
    const [job] = await db.select().from(workizJobs).where(eq(workizJobs.uuid, payout.jobUuid)).limit(1)
    const settings = await getNotificationSettings()
    return { ok: true, data: { message: renderTemplate(settings.template, buildTemplateContext(payout, profile, job ?? null)) } }
  } catch (err) {
    return fail(err)
  }
}

export async function sendNotificationNow(payoutId: number): Promise<Result<{ status: string; reason?: string }>> {
  try {
    await requireAdmin()
    const outcome = await notifyPayout(payoutId, { force: true })
    revalidatePath("/admin")
    return { ok: true, data: { status: outcome.status, reason: outcome.reason } }
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

async function latestNotificationByPayout(payoutIds: number[]) {
  const rows = payoutIds.length
    ? await db.select().from(notifications).where(inArray(notifications.payoutId, payoutIds)).orderBy(desc(notifications.createdAt))
    : []
  const byPayout = new Map<number, (typeof rows)[number]>()
  for (const n of rows) if (!byPayout.has(n.payoutId)) byPayout.set(n.payoutId, n)
  return byPayout
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

  const notifByPayout = await latestNotificationByPayout(rows.map((r) => r.payout.id))

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
      lastNotification: notifByPayout.get(r.payout.id) ?? null,
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

export async function loadAdminDashboard() {
  await requireAdmin()
  const [profiles, mappings, catalog, workiz, notif, events, statusCounts, payoutPage, lastWebhook] = await Promise.all([
    listProfiles(),
    db.select().from(workizTeamMappings).orderBy(desc(workizTeamMappings.updatedAt)),
    db.select().from(colorSealItems).orderBy(colorSealItems.productId),
    getWorkizSettings(),
    getNotificationSettings(),
    db.select().from(syncEvents).orderBy(desc(syncEvents.createdAt)).limit(40),
    payoutStatusCounts(),
    queryPayouts(DEFAULT_PAYOUT_QUERY),
    latestWorkizWebhook(),
  ])

  const unmappedIds = mappings.filter((m) => m.profileId == null && !m.excluded).map((m) => m.workizTeamId)
  const unmappedImpact = await unmappedTeamImpact(unmappedIds)

  // Compact recent list for the Messages tab (preview picker + delivery log).
  const recentRows = await db
    .select({
      payout: payouts,
      profileName: technicianProfiles.name,
      job: { serialId: workizJobs.serialId, clientName: workizJobs.clientName, status: workizJobs.status, jobDateTime: workizJobs.jobDateTime, fullyPaid: workizJobs.fullyPaid },
    })
    .from(payouts)
    .leftJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id))
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .orderBy(desc(payouts.updatedAt))
    .limit(300)
  const notifByPayout = await latestNotificationByPayout(recentRows.map((r) => r.payout.id))

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
      businessTimezone: workiz.businessTimezone || DEFAULT_BUSINESS_TIMEZONE,
    },
    notifications: notif,
    events,
    payouts: recentRows.map((r) => ({
      ...r.payout,
      profileName: r.profileName ?? "Unknown",
      job: r.job,
      lastNotification: notifByPayout.get(r.payout.id) ?? null,
    })),
    statusCounts,
    payoutPage,
  }
}

export type AdminDashboardData = Awaited<ReturnType<typeof loadAdminDashboard>>
