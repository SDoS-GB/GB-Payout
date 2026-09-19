"use server"

import { and, desc, eq, inArray, sql } from "drizzle-orm"
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
import { listProfiles } from "@/lib/payout/profiles"
import { parseMarkerTokens } from "@/lib/payout/segments"
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
import { WorkizClient } from "@/lib/workiz/client"
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

export async function probeWorkiz(): Promise<Result<Awaited<ReturnType<WorkizClient["probe"]>>>> {
  try {
    await requireAdmin()
    const s = await getWorkizSettings()
    const client = new WorkizClient({ apiToken: s.apiToken, apiSecret: s.apiSecret })
    const data = await client.probe()
    await logSyncEvent("probe", { ok: true, summary: `Workiz reachable in ${data.latencyMs}ms · ${data.teamCount} team members`, details: data })
    return { ok: true, data }
  } catch (err) {
    await logSyncEvent("probe", { ok: false, summary: `Workiz probe failed: ${err instanceof Error ? err.message : String(err)}` })
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
      case "release":
        set.status = "ready"
        set.holdReason = null
        break
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
        break
    }
    await db.update(payouts).set(set).where(eq(payouts.id, id))
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

export async function loadAdminDashboard() {
  await requireAdmin()
  const [profiles, mappings, catalog, workiz, notif, events] = await Promise.all([
    listProfiles(),
    db.select().from(workizTeamMappings).orderBy(desc(workizTeamMappings.updatedAt)),
    db.select().from(colorSealItems).orderBy(colorSealItems.productId),
    getWorkizSettings(),
    getNotificationSettings(),
    db.select().from(syncEvents).orderBy(desc(syncEvents.createdAt)).limit(40),
  ])

  const payoutRows = await db
    .select({
      payout: payouts,
      profileName: technicianProfiles.name,
      job: {
        serialId: workizJobs.serialId,
        clientName: workizJobs.clientName,
        status: workizJobs.status,
        jobDateTime: workizJobs.jobDateTime,
        fullyPaid: workizJobs.fullyPaid,
      },
    })
    .from(payouts)
    .leftJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id))
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .orderBy(desc(payouts.updatedAt))
    .limit(300)

  const payoutIds = payoutRows.map((r) => r.payout.id)
  const latestNotifications = payoutIds.length
    ? await db
        .select()
        .from(notifications)
        .where(inArray(notifications.payoutId, payoutIds))
        .orderBy(desc(notifications.createdAt))
    : []
  const notifByPayout = new Map<number, (typeof latestNotifications)[number]>()
  for (const n of latestNotifications) if (!notifByPayout.has(n.payoutId)) notifByPayout.set(n.payoutId, n)

  const [counts] = await db
    .select({
      ready: sql<number>`count(*) filter (where ${payouts.status} = 'ready')`.mapWith(Number),
      hold: sql<number>`count(*) filter (where ${payouts.status} = 'hold')`.mapWith(Number),
      pending: sql<number>`count(*) filter (where ${payouts.status} = 'pending')`.mapWith(Number),
      paid: sql<number>`count(*) filter (where ${payouts.status} = 'paid')`.mapWith(Number),
      readyTotal: sql<number>`coalesce(sum(${payouts.totalPayout}) filter (where ${payouts.status} = 'ready'), 0)`.mapWith(Number),
    })
    .from(payouts)

  return {
    profiles: profiles.map((p) => ({ ...p, pinHash: undefined })),
    mappings,
    catalog,
    workiz: {
      hasApiToken: Boolean(workiz.apiToken),
      hasApiSecret: Boolean(workiz.apiSecret),
      hasWebhookSecret: Boolean(workiz.webhookSecret),
      webhookSecret: workiz.webhookSecret,
      payableStatuses: workiz.payableStatuses,
      colorSealKeywords: workiz.colorSealKeywords,
      cardMethodKeywords: workiz.cardMethodKeywords,
      tipKeywords: workiz.tipKeywords,
      reconcileLookbackDays: workiz.reconcileLookbackDays,
    },
    notifications: notif,
    events,
    payouts: payoutRows.map((r) => ({
      ...r.payout,
      profileName: r.profileName ?? "Unknown",
      job: r.job,
      lastNotification: notifByPayout.get(r.payout.id) ?? null,
    })),
    counts,
  }
}

export type AdminDashboardData = Awaited<ReturnType<typeof loadAdminDashboard>>
