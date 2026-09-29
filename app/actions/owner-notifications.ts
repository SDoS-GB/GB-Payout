"use server"

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { db } from "@/lib/db"
import { jobPayments, ownerNotificationAttempts, ownerNotifications, payouts, syncEvents, workizJobs, workizTeamMappings } from "@/lib/db/schema"
import { ownerConfigurationBlocker } from "@/lib/notifications/owner-outbox"
import { OWNER_MAX_ATTEMPTS } from "@/lib/notifications/owner-status"
import { productionOwnerSendingAllowed, reconcileOwnerDelivery, sendOwnerNotification } from "@/lib/notifications/owner-worker"
import { lockPayoutJob } from "@/lib/payout/lock"
import { requireAdmin } from "@/lib/security/session"
import { getNotificationSettings, getWorkizSettings, maskPhone, saveNotificationSettings, saveWorkizSettings } from "@/lib/settings"
import { WorkizClient } from "@/lib/workiz/client"
import { unprocessedEventsForJob } from "@/lib/workiz/events"
import { syncJobByUuid } from "@/lib/workiz/sync"

type ActionResult = { ok: true; message: string } | { ok: false; error: string }
const jobId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)
const failure = (error: unknown): ActionResult => ({ ok: false, error: error instanceof Error ? error.message : "Owner notification operation failed" })

export async function loadOwnerSettings() {
  await requireAdmin()
  const [settings, workiz, team, counts, lastWorker, lastSync] = await Promise.all([
    getNotificationSettings(),
    getWorkizSettings(),
    db.select({ id: workizTeamMappings.workizTeamId, name: workizTeamMappings.workizName, role: workizTeamMappings.workizRole }).from(workizTeamMappings).orderBy(workizTeamMappings.workizName),
    db.select({ status: ownerNotifications.status, count: sql<number>`count(*)`.mapWith(Number) }).from(ownerNotifications).groupBy(ownerNotifications.status),
    db.select({ at: syncEvents.createdAt, ok: syncEvents.ok, summary: syncEvents.summary }).from(syncEvents).where(eq(syncEvents.kind, "automation:cron")).orderBy(desc(syncEvents.id)).limit(1),
    db.select({ at: syncEvents.createdAt, summary: syncEvents.summary }).from(syncEvents).where(and(eq(syncEvents.kind, "reconcile"), eq(syncEvents.ok, true))).orderBy(desc(syncEvents.id)).limit(1),
  ])
  return { settings, tag: workiz.payoutReadyTag, team, counts, lastWorker: lastWorker[0] ?? null, lastSync: lastSync[0] ?? null, blocker: ownerConfigurationBlocker(settings, workiz), production: productionOwnerSendingAllowed(), cronSecretConfigured: Boolean(process.env.CRON_SECRET), timezone: workiz.businessTimezone }
}

export type OwnerSettingsData = Awaited<ReturnType<typeof loadOwnerSettings>>

export async function saveOwnerConfiguration(input: { teamId: string; lastFour: string; tag: string; ruleName: string; confirmed: boolean }): Promise<ActionResult> {
  try {
    await requireAdmin()
    const form = z.object({ teamId: z.string().trim().min(1).max(100), lastFour: z.string().trim().regex(/^\d{4}$/), tag: z.string().trim().min(1).max(80).refine((v) => !/[\r\n]/.test(v)), ruleName: z.string().trim().min(1).max(150), confirmed: z.literal(true) }).parse(input)
    const workiz = await getWorkizSettings()
    const members = await new WorkizClient(workiz).listTeam()
    const owner = members.find((member) => member.id === form.teamId && member.active)
    if (!owner) throw new Error("Select an active, existing Workiz team member for the owner. Never select the customer or an assigned-technician placeholder.")
    const providerMask = maskPhone(owner.phone)
    if (providerMask && !providerMask.endsWith(form.lastFour)) throw new Error("The last four digits do not match the selected Workiz member. No configuration was changed.")
    const recipient = { workizTeamId: owner.id, name: owner.name, phoneMasked: providerMask ?? maskPhone(form.lastFour) }
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gb-owner-configuration', 0))`)
      const current = await getNotificationSettings(tx)
      const currentWorkiz = await getWorkizSettings(tx)
      const changed = current.ownerRecipient?.workizTeamId !== recipient.workizTeamId || current.ownerRecipient?.phoneMasked !== recipient.phoneMasked || current.automationRuleName !== form.ruleName || currentWorkiz.payoutReadyTag !== form.tag
      await saveWorkizSettings({ payoutReadyTag: form.tag, payoutReadyTagEnabled: false }, "admin", tx)
      await saveNotificationSettings({ ownerRecipient: recipient, automationRuleName: form.ruleName, automationConfirmedAt: changed || !current.automationConfirmedAt ? new Date().toISOString() : current.automationConfirmedAt, ...(changed ? { sendEnabled: false, verifiedDeliveryAt: null, automaticSince: null } : {}) }, "admin", tx)
      if (changed) await tx.update(ownerNotifications).set({ status: "blocked", requestedAt: null, requestedBy: null, nextAttemptAt: null, blockReason: "Owner configuration changed; verify the recipient and request this job again", updatedAt: new Date() }).where(and(isNull(ownerNotifications.sentAt), eq(ownerNotifications.requiresReview, false), inArray(ownerNotifications.status, ["blocked", "preview_only", "queued", "failed"])))
      await tx.insert(syncEvents).values({ kind: "owner:configuration", summary: `Owner automation recorded for ${recipient.name} ${recipient.phoneMasked}; live delivery still requires an owner-confirmed test`, details: { recipient, ruleName: form.ruleName, tag: form.tag, providerPhoneAvailable: Boolean(providerMask), changed } })
    })
    revalidatePath("/admin")
    return { ok: true, message: "Configuration saved. This does not create or verify the Workiz rule and does not send a text." }
  } catch (error) { return failure(error) }
}

export async function setAutomaticOwnerSending(enabled: boolean): Promise<ActionResult> {
  try {
    await requireAdmin()
    z.boolean().parse(enabled)
    if (!productionOwnerSendingAllowed()) throw new Error("Automatic sending can only be changed on the published production app.")
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gb-owner-configuration', 0))`)
      const current = await getNotificationSettings(tx)
      const workiz = await getWorkizSettings(tx)
      if (enabled) {
        const blocker = ownerConfigurationBlocker(current, workiz)
        if (blocker) throw new Error(blocker)
        if (!current.verifiedDeliveryAt) throw new Error("Confirm receipt of a one-job owner test before enabling automatic sending.")
        if (!process.env.CRON_SECRET) throw new Error("The production CRON_SECRET is missing; background delivery is not configured.")
      }
      await saveNotificationSettings({ sendEnabled: enabled, automaticSince: enabled ? current.sendEnabled && current.automaticSince ? current.automaticSince : new Date().toISOString() : current.automaticSince }, "admin", tx)
      await tx.insert(syncEvents).values({ kind: "owner:configuration", summary: enabled ? "Automatic owner delivery enabled for new completions only; historical texts suppressed" : "Automatic owner delivery disabled" })
    })
    revalidatePath("/admin")
    return { ok: true, message: enabled ? "Enabled for newly completed jobs only. Historical jobs will not be texted automatically." : "Automatic sending is off. Existing explicit one-job requests are unchanged." }
  } catch (error) { return failure(error) }
}

export async function loadOwnerJobDiagnostics(uuidInput: string) {
  await requireAdmin()
  const uuid = jobId.parse(uuidInput)
  const [settings, workiz, jobRows, notificationRows, payments, attempts, events, payoutStates] = await Promise.all([
    getNotificationSettings(), getWorkizSettings(),
    db.select({ uuid: workizJobs.uuid, serialId: workizJobs.serialId, lastSeenAt: workizJobs.lastSeenAt }).from(workizJobs).where(eq(workizJobs.uuid, uuid)).limit(1),
    db.select().from(ownerNotifications).where(eq(ownerNotifications.jobUuid, uuid)).limit(1),
    db.select({ id: jobPayments.id, source: jobPayments.source, externalId: jobPayments.externalId, method: jobPayments.method, amount: jobPayments.amount, tipAmount: jobPayments.tipAmount, state: jobPayments.paymentState, reviewReason: jobPayments.reviewReason, paidAt: jobPayments.paidAt, updatedAt: jobPayments.updatedAt }).from(jobPayments).where(eq(jobPayments.jobUuid, uuid)).orderBy(jobPayments.id),
    db.select({ id: ownerNotificationAttempts.id, status: ownerNotificationAttempts.status, startedAt: ownerNotificationAttempts.startedAt, requestStartedAt: ownerNotificationAttempts.requestStartedAt, finishedAt: ownerNotificationAttempts.finishedAt, snapshotHash: ownerNotificationAttempts.snapshotHash, destinationMasked: ownerNotificationAttempts.destinationMasked, error: ownerNotificationAttempts.error }).from(ownerNotificationAttempts).where(eq(ownerNotificationAttempts.jobUuid, uuid)).orderBy(desc(ownerNotificationAttempts.startedAt)).limit(5),
    unprocessedEventsForJob(uuid),
    db.select({ status: payouts.status }).from(payouts).where(eq(payouts.jobUuid, uuid)),
  ])
  const row = notificationRows[0]
  const configBlocker = ownerConfigurationBlocker(settings, workiz)
  const blocked = configBlocker ?? (events.length ? `Event #${events[0].id} is ${events[0].status}: ${events[0].error ?? "waiting for processing"}` : null)
    ?? (!payoutStates.length || payoutStates.some((p) => p.status !== "ready") ? row?.blockReason ?? "Every required technician payout must be ready" : null)
  const notification = row ? { id: row.id, status: row.status, blockReason: row.blockReason, message: row.message, snapshotHash: row.snapshotHash, destinationLabel: row.destinationLabel, destinationMasked: row.destinationMasked, attempts: row.attempts, lastAttemptAt: row.lastAttemptAt, lastError: row.lastError, nextAttemptAt: row.nextAttemptAt, sentAt: row.sentAt, deliveredAt: row.deliveredAt, sentSnapshotHash: row.sentSnapshotHash, requiresReview: row.requiresReview, providerMessageId: row.providerMessageId } : null
  return { job: jobRows[0] ?? null, notification, payments, attempts, events, configBlocker, blocked, recipient: settings.ownerRecipient, production: productionOwnerSendingAllowed(), canRequest: Boolean(productionOwnerSendingAllowed() && !blocked && row?.message && row.snapshotHash && !row.sentAt && !row.requiresReview && row.status !== "sending" && row.attempts < OWNER_MAX_ATTEMPTS) }
}

export type OwnerJobDiagnostics = Awaited<ReturnType<typeof loadOwnerJobDiagnostics>>

export async function refreshOwnerJob(uuidInput: string): Promise<ActionResult> {
  try {
    await requireAdmin()
    const result = await syncJobByUuid(jobId.parse(uuidInput), "rest", { via: "owner-admin-recheck-no-send" })
    revalidatePath("/admin")
    return { ok: true, message: `Job rechecked: ${result.engine.updated} payout(s) updated. No text was requested.` }
  } catch (error) { return failure(error) }
}

export async function requestOwnerPayout(input: { uuid: string; snapshotHash: string; confirmed: boolean }): Promise<ActionResult> {
  try {
    await requireAdmin()
    const form = z.object({ uuid: jobId, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).parse(input)
    if (!productionOwnerSendingAllowed()) throw new Error("Live Workiz writes are disabled in preview. Use this action on the published production app.")
    await syncJobByUuid(form.uuid, "rest", { via: "owner-single-job-request" })
    const id = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gb-owner-configuration', 0))`)
      await lockPayoutJob(tx, form.uuid)
      const settings = await getNotificationSettings(tx)
      const workiz = await getWorkizSettings(tx)
      const blocker = ownerConfigurationBlocker(settings, workiz)
      if (blocker) throw new Error(blocker)
      const ready = await tx.select({ status: payouts.status }).from(payouts).where(eq(payouts.jobUuid, form.uuid)).orderBy(payouts.id).for("update")
      const [row] = await tx.select().from(ownerNotifications).where(eq(ownerNotifications.jobUuid, form.uuid)).for("update")
      if (!row?.message || !ready.length || ready.some((p) => p.status !== "ready")) throw new Error(row?.blockReason ?? "All technician calculations must be ready. Genuine payment holds cannot be bypassed.")
      if (row.snapshotHash !== form.snapshotHash) throw new Error("The payout changed. Review the refreshed message before requesting this job again.")
      if (row.sentAt || row.status === "sending" || row.requiresReview || row.attempts >= OWNER_MAX_ATTEMPTS) throw new Error("This job was already triggered, is sending, or needs delivery review. No duplicate text was requested.")
      if ((await unprocessedEventsForJob(form.uuid, tx)).length) throw new Error("A pending payment/job event must finish before this payout can be sent.")
      await tx.update(ownerNotifications).set({ status: "queued", requestedAt: new Date(), requestedBy: "admin", nextAttemptAt: new Date(), lastError: null, blockReason: null, updatedAt: new Date() }).where(eq(ownerNotifications.id, row.id))
      await tx.insert(syncEvents).values({ kind: "owner:request", jobUuid: form.uuid, summary: `Admin explicitly requested one owner text to ${row.destinationMasked}`, details: { notificationId: row.id, snapshotHash: row.snapshotHash, destinationMasked: row.destinationMasked } })
      return row.id
    })
    const outcome = await sendOwnerNotification(id)
    revalidatePath("/admin")
    return { ok: true, message: outcome.status === "provider_accepted" ? "Workiz retained the payout description and tag. SMS delivery is unconfirmed; check your phone and the Workiz log." : `Owner request: ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ""}` }
  } catch (error) { return failure(error) }
}

export async function checkOwnerDelivery(idInput: number): Promise<ActionResult> {
  try {
    await requireAdmin()
    const id = z.number().int().positive().parse(idInput)
    await reconcileOwnerDelivery(id)
    revalidatePath("/admin")
    return { ok: true, message: "Checked the Workiz tag and description only. No text was resent; this API has no SMS delivery receipt." }
  } catch (error) { return failure(error) }
}

export async function confirmOwnerReceipt(input: { id: number; snapshotHash: string; received: boolean }): Promise<ActionResult> {
  try {
    await requireAdmin()
    const form = z.object({ id: z.number().int().positive(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), received: z.literal(true) }).parse(input)
    if (!productionOwnerSendingAllowed()) throw new Error("Confirm receipt on the published production app, not in preview.")
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gb-owner-configuration', 0))`)
      const [row] = await tx.select().from(ownerNotifications).where(eq(ownerNotifications.id, form.id)).for("update")
      if (!row) throw new Error("Owner notification not found")
      const [attempt] = await tx.select().from(ownerNotificationAttempts).where(eq(ownerNotificationAttempts.notificationId, row.id)).orderBy(desc(ownerNotificationAttempts.startedAt)).limit(1)
      if (!attempt?.requestStartedAt || attempt.snapshotHash !== form.snapshotHash || (!row.sentAt && !row.requiresReview)) throw new Error("No matching completed or ambiguous live attempt can be confirmed. A preview is not a send.")
      const now = new Date()
      await tx.update(ownerNotifications).set({ status: "delivered", deliveredAt: now, deliveredConfirmedBy: "owner via admin confirmation", sentAt: row.sentAt ?? now, sentSnapshotHash: attempt.snapshotHash, destinationId: attempt.destinationId, destinationMasked: attempt.destinationMasked, requiresReview: false, nextAttemptAt: null, lastError: null, blockReason: row.snapshotHash !== attempt.snapshotHash ? "Payout changed after the received message; no automatic second text" : null, updatedAt: now }).where(eq(ownerNotifications.id, row.id))
      const settings = await getNotificationSettings(tx)
      const workiz = await getWorkizSettings(tx)
      const evidence = (attempt.providerResponse ?? {}) as { tag?: string }
      if (!ownerConfigurationBlocker(settings, workiz) && settings.ownerRecipient?.workizTeamId === attempt.destinationId && settings.ownerRecipient?.phoneMasked === attempt.destinationMasked && evidence.tag === workiz.payoutReadyTag && settings.automationConfirmedAt && new Date(settings.automationConfirmedAt) <= attempt.requestStartedAt) await saveNotificationSettings({ verifiedDeliveryAt: now.toISOString() }, "admin", tx)
      await tx.insert(syncEvents).values({ kind: "owner:receipt", jobUuid: row.jobUuid, summary: `Owner confirmed receiving notification #${row.id} at ${attempt.destinationMasked}; not a provider delivery receipt`, details: { notificationId: row.id, attemptId: attempt.id, snapshotHash: attempt.snapshotHash } })
    })
    revalidatePath("/admin")
    return { ok: true, message: "Your receipt confirmation was recorded. Automatic sending remains unchanged; enable it separately after checking Workiz setup." }
  } catch (error) { return failure(error) }
}
