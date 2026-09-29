import { randomUUID } from "node:crypto"
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { ownerNotificationAttempts, ownerNotifications, payouts, syncEvents, workizJobs, type OwnerNotificationRow } from "@/lib/db/schema"
import { lockPayoutJob } from "@/lib/payout/lock"
import { getNotificationSettings, getWorkizSettings } from "@/lib/settings"
import { WorkizApiError, WorkizClient } from "@/lib/workiz/client"
import { unprocessedEventsForJob } from "@/lib/workiz/events"
import { loadSyncContext, processRawJob } from "@/lib/workiz/sync"
import { ownerConfigurationBlocker } from "./owner-outbox"
import { ownerAttemptDisposition, OWNER_LEASE_MS, OWNER_MAX_ATTEMPTS, OWNER_RETRY_MS } from "./owner-status"
import { deliverOwnerTrigger, verifyOwnerTrigger, type DeliveryOutcome } from "./workiz-owner-transport"

export function productionOwnerSendingAllowed() { return process.env.VERCEL_ENV === "production" }

export async function refreshOwnerOutbox(limit = 30) {
  const rows = await db.select({ uuid: workizJobs.uuid, raw: workizJobs.raw }).from(workizJobs)
    .innerJoin(payouts, eq(payouts.jobUuid, workizJobs.uuid))
    .leftJoin(ownerNotifications, eq(ownerNotifications.jobUuid, workizJobs.uuid))
    .where(and(inArray(payouts.status, ["ready", "hold", "pending"]), or(isNull(ownerNotifications.id), inArray(ownerNotifications.status, ["blocked", "preview_only", "queued", "failed"]))))
    .groupBy(workizJobs.uuid, ownerNotifications.updatedAt).orderBy(sql`${ownerNotifications.updatedAt} asc nulls first`).limit(limit)
  const context = await loadSyncContext()
  for (const row of rows) if (row.raw && typeof row.raw === "object") await processRawJob(row.raw as Record<string, unknown>, "rest", { ...context, storedOnly: true, via: "owner-outbox-recheck" })
  return rows.length
}

export async function claimOwnerNotification(id: number, tag: string) {
  return db.transaction(async (tx) => {
    const token = randomUUID()
    const now = new Date()
    const [row] = await tx.update(ownerNotifications).set({ status: "sending", attempts: sql`${ownerNotifications.attempts} + 1`, lastAttemptAt: now, leaseToken: token, leaseUntil: new Date(Date.now() + OWNER_LEASE_MS), updatedAt: now })
      .where(and(eq(ownerNotifications.id, id), eq(ownerNotifications.status, "queued"), eq(ownerNotifications.requiresReview, false), lt(ownerNotifications.attempts, OWNER_MAX_ATTEMPTS), isNull(ownerNotifications.sentAt), isNotNull(ownerNotifications.snapshotHash), isNotNull(ownerNotifications.destinationId), isNotNull(ownerNotifications.destinationMasked), sql`length(${ownerNotifications.message}) > 0`, or(isNull(ownerNotifications.nextAttemptAt), lte(ownerNotifications.nextAttemptAt, now)))).returning()
    if (!row || !row.snapshotHash || !row.destinationId || !row.destinationMasked) return null
    await tx.insert(ownerNotificationAttempts).values({ id: token, notificationId: row.id, jobUuid: row.jobUuid, snapshotHash: row.snapshotHash, destinationId: row.destinationId, destinationMasked: row.destinationMasked, providerResponse: { message: row.message, tag } })
    return row
  })
}

async function finish(row: OwnerNotificationRow, outcome: DeliveryOutcome) {
  const { retry, status, requiresReview, reconcile } = ownerAttemptDisposition(outcome, row.attempts)
  const now = new Date()
  const [attempt] = await db.select({ response: ownerNotificationAttempts.providerResponse }).from(ownerNotificationAttempts).where(eq(ownerNotificationAttempts.id, row.leaseToken!)).limit(1)
  await db.transaction(async (tx) => {
    await tx.update(ownerNotificationAttempts).set({ status, finishedAt: now, error: outcome.error, providerResponse: { ...(attempt?.response as object ?? {}), ...outcome.evidence } }).where(eq(ownerNotificationAttempts.id, row.leaseToken!))
    await tx.update(ownerNotifications).set({ status, lastError: outcome.error, blockReason: outcome.error, requiresReview, nextAttemptAt: retry || reconcile ? new Date(Date.now() + OWNER_RETRY_MS) : null, leaseToken: null, leaseUntil: null, providerResponse: outcome.evidence, sentSnapshotHash: outcome.accepted ? row.snapshotHash : undefined, sentAt: outcome.accepted ? now : undefined, updatedAt: now })
      .where(and(eq(ownerNotifications.id, row.id), eq(ownerNotifications.leaseToken, row.leaseToken!)))
    await tx.insert(syncEvents).values({ kind: "owner:attempt", jobUuid: row.jobUuid, ok: outcome.accepted, summary: `Owner notification #${row.id}: ${status}${outcome.error ? ` — ${outcome.error}` : " — Workiz update only; SMS delivery unconfirmed"}`, details: { notificationId: row.id, attemptId: row.leaseToken, snapshotHash: row.snapshotHash, destinationMasked: row.destinationMasked, ...outcome.evidence } })
  })
}

export async function sendOwnerNotification(id: number) {
  if (!productionOwnerSendingAllowed()) return { status: "preview_only", error: "Live Workiz writes are disabled in preview/development. Publish and initiate the owner test in production." }
  const workiz = await getWorkizSettings()
  const row = await claimOwnerNotification(id, workiz.payoutReadyTag)
  if (!row) return { status: "unchanged", error: null }
  let requesting = false
  try {
    const context = await loadSyncContext(workiz)
    const client = new WorkizClient(workiz)
    const fetchedAt = new Date()
    const fresh = await client.getJob(row.jobUuid)
    if (!fresh) throw new Error("Workiz job not found")
    const outcome = await db.transaction(async (tx): Promise<DeliveryOutcome> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gb-owner-configuration', 0))`)
      await lockPayoutJob(tx, row.jobUuid)
      context.owner = await getNotificationSettings(tx)
      const currentWorkiz = await getWorkizSettings(tx)
      if (currentWorkiz.payoutReadyTag !== workiz.payoutReadyTag) return { accepted: false, ambiguous: false, retryable: false, blocked: true, error: "Owner automation tag changed; request this job again with the current configuration", evidence: { preflightBlocked: true } }
      // The normal paid/void/review actions also lock payout rows. They cannot change a
      // technician's state between the final eligibility check and the provider trigger.
      await tx.select({ id: payouts.id }).from(payouts).where(eq(payouts.jobUuid, row.jobUuid)).orderBy(payouts.id).for("update")
      const processed = await processRawJob(fresh, "rest", { ...context, database: tx, fetchedAt, via: "owner-send-preflight" })
      const [current] = await tx.select().from(ownerNotifications).where(eq(ownerNotifications.id, row.id)).for("update")
      if (!current) throw new Error("Owner notification no longer exists")
      const [pendingEvent] = await unprocessedEventsForJob(row.jobUuid, tx)
      const config = ownerConfigurationBlocker(context.owner, currentWorkiz) ?? (!current.requestedAt && !context.owner.sendEnabled ? "Automatic owner sending was disabled" : null)
      const blocker = config ?? current.blockReason ?? (pendingEvent ? `Payment/job event #${pendingEvent.id} still needs processing` : null)
        ?? (current.snapshotHash !== row.snapshotHash ? "Payout snapshot changed; review the current figures and request this job again" : null)
        ?? (current.destinationId !== row.destinationId || current.destinationMasked !== row.destinationMasked ? "Owner recipient changed since this notification was queued" : null)
      if (blocker || current.leaseToken !== row.leaseToken) return { accepted: false, ambiguous: false, retryable: Boolean(pendingEvent), blocked: true, error: blocker ?? "Owner send lease changed", evidence: { preflightBlocked: true } }
      // This marker is committed on a separate connection before any provider write. If the
      // transaction/process dies after a POST, lease recovery knows to READ, not resend.
      await db.update(ownerNotificationAttempts).set({ requestStartedAt: new Date(), status: "requesting" }).where(eq(ownerNotificationAttempts.id, row.leaseToken!))
      requesting = true
      return deliverOwnerTrigger({ client, uuid: row.jobUuid, before: fresh, tag: workiz.payoutReadyTag, message: row.message, verifyBeforeTrigger: async (latest) => {
        await processRawJob(latest, "rest", { ...context, database: tx, fetchedAt: new Date(), via: "owner-trigger-verification" })
        const [verified] = await tx.select().from(ownerNotifications).where(eq(ownerNotifications.id, row.id))
        if (verified.snapshotHash !== row.snapshotHash || verified.blockReason) throw new Error(verified.blockReason ?? "Payout changed while preparing the owner text; no tag added")
        if (!processed.normalized.fullyPaid) throw new Error("Job is no longer fully paid")
      } })
    })
    await finish(row, outcome)
    return { status: ownerAttemptDisposition(outcome, row.attempts).status, error: outcome.error }
  } catch (error) {
    const transient = error instanceof WorkizApiError ? error.status === 429 || error.status >= 500 : error instanceof TypeError || (error instanceof Error && /timeout|abort/i.test(error.name))
    await finish(row, { accepted: false, ambiguous: requesting, retryable: !requesting && transient, error: error instanceof Error ? error.message : "Owner notification failed", evidence: { requestMayHaveStarted: requesting, smsDelivery: "unconfirmed" } })
    return { status: "failed", error: "Owner delivery failed; see attempt history" }
  }
}

export async function reconcileOwnerDelivery(id: number) {
  const [row] = await db.select().from(ownerNotifications).where(eq(ownerNotifications.id, id)).limit(1)
  if (!row || row.sentAt || (row.status === "sending" && row.leaseUntil && row.leaseUntil > new Date())) return
  const [attempt] = await db.select().from(ownerNotificationAttempts).where(eq(ownerNotificationAttempts.notificationId, id)).orderBy(sql`${ownerNotificationAttempts.startedAt} desc`).limit(1)
  if (!attempt?.requestStartedAt) {
    if (row.status === "sending" && row.leaseUntil && row.leaseUntil <= new Date()) await db.update(ownerNotifications).set({ status: "queued", leaseUntil: null, leaseToken: null, nextAttemptAt: new Date(), lastError: "Recovered an abandoned attempt before any provider write", updatedAt: new Date() }).where(and(eq(ownerNotifications.id, id), eq(ownerNotifications.status, "sending"), lte(ownerNotifications.leaseUntil, new Date())))
    return
  }
  const info = (attempt.providerResponse ?? {}) as { message?: string; tag?: string }
  if (!info.message || !info.tag) return
  const settings = await getWorkizSettings()
  const current = await new WorkizClient(settings).getJob(row.jobUuid)
  const verified = verifyOwnerTrigger(current, info.message, info.tag)
  const error = verified ? null : "Delivery is ambiguous. Workiz does not expose an SMS receipt here. Check its message/automation log or confirm receipt; no resend is scheduled."
  await db.update(ownerNotifications).set({ status: verified ? "provider_accepted" : "failed", sentSnapshotHash: verified ? attempt.snapshotHash : undefined, sentAt: verified ? new Date() : undefined, requiresReview: !verified, leaseToken: null, leaseUntil: null, nextAttemptAt: null, lastError: error, blockReason: error, providerResponse: { tagVerified: verified, descriptionVerified: verified, reconciled: true, smsDelivery: "unconfirmed" }, updatedAt: new Date() }).where(and(eq(ownerNotifications.id, id), isNull(ownerNotifications.sentAt)))
  await db.update(ownerNotificationAttempts).set({ status: verified ? "provider_accepted" : "ambiguous", finishedAt: new Date(), error }).where(eq(ownerNotificationAttempts.id, attempt.id))
}

export async function drainOwnerNotifications(options: { limit?: number; refresh?: boolean } = {}) {
  const refreshed = options.refresh === false ? 0 : await refreshOwnerOutbox()
  const production = productionOwnerSendingAllowed()
  if (!production || options.limit === 0) return { refreshed, attempted: 0, preview: !production }
  const ambiguous = await db.select({ id: ownerNotifications.id }).from(ownerNotifications).where(or(
    and(eq(ownerNotifications.status, "sending"), lte(ownerNotifications.leaseUntil, new Date())),
    and(eq(ownerNotifications.requiresReview, true), lte(ownerNotifications.nextAttemptAt, new Date())),
  )).limit(2)
  for (const row of ambiguous) await reconcileOwnerDelivery(row.id)
  const due = await db.select({ id: ownerNotifications.id }).from(ownerNotifications).where(and(eq(ownerNotifications.status, "queued"), lte(ownerNotifications.nextAttemptAt, new Date()), eq(ownerNotifications.requiresReview, false))).orderBy(asc(ownerNotifications.nextAttemptAt)).limit(options.limit ?? 2)
  for (const row of due) await sendOwnerNotification(row.id)
  return { refreshed, attempted: due.length, preview: false }
}
