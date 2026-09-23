import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { ownerNotifications, payouts, syncEvents, technicianProfiles, workizJobs, workizTeamMappings, type NormalizedPayment, type OwnerNotificationRow } from "@/lib/db/schema"
import { sha256 } from "@/lib/security/crypto"
import { getNotificationSettings, getWorkizSettings, type NotificationSettings, type WorkizSettings } from "@/lib/settings"
import { WorkizClient, type WorkizRawJob } from "@/lib/workiz/client"
import { hasPayoutNote, mergePayoutNote, PAYOUT_NOTE_HEADER } from "@/lib/workiz/payout-note"
import { explainNotApplied, hasTag, normalizeTagName } from "@/lib/workiz/tags"
import { MAX_ATTEMPTS, OWNER_MESSAGE_HEADER, evaluateOwnerNotification, nextRetryAt, type OwnerNotificationDecision, type OwnerNotificationInput } from "./owner-message"

/**
 * Durable outbox for the owner's "payout ready" text, one row per job.
 *
 *   webhook / cron / admin ──► refreshOwnerNotification(job) ──► row: blocked | preview_only | queued
 *                                                                        │
 *   cron / webhook / "Send now" ──► attemptDelivery(row) ─── claim ──────┘
 *        re-check eligibility + snapshot ► Workiz job/update (tag + description) ► read back
 *        ► provider_accepted (Workiz confirmed; SMS sent by the owner's Workiz automation)
 *        ► failed + next_attempt_at (bounded back-off)         ► delivered (owner confirms)
 *
 * The claim is a single conditional UPDATE, so two overlapping runs cannot both send. Workiz
 * only texts when the tag is ADDED, and the API cannot remove tags, so the tag on the job is
 * also the provider-side idempotency marker: a job is never texted twice by retries.
 */

const STALE_SENDING_MS = 10 * 60_000
const ACTIVE_STATES = ["provider_accepted", "delivered"] as const

export type DeliveryOutcome =
  | { outcome: "provider_accepted"; reconciled: boolean; descriptionWritten: boolean }
  | { outcome: "failed"; error: string; retryAt: Date | null }
  | { outcome: "skipped"; reason: string }
  | { outcome: "not_eligible"; state: "blocked" | "preview_only"; reason: string }

export type OwnerRefreshResult = { row: OwnerNotificationRow; decision: OwnerNotificationDecision; delivery: DeliveryOutcome | null }

type Ctx = { settings?: WorkizSettings; notificationSettings?: NotificationSettings; client?: WorkizClient | null; via?: string }

async function ctxOf(ctx: Ctx) {
  const settings = ctx.settings ?? (await getWorkizSettings())
  const notificationSettings = ctx.notificationSettings ?? (await getNotificationSettings())
  const client = ctx.client === undefined ? (settings.apiToken ? new WorkizClient({ apiToken: settings.apiToken, apiSecret: settings.apiSecret }) : null) : ctx.client
  return { settings, notificationSettings, client }
}

async function log(kind: string, opts: { jobUuid?: string | null; ok?: boolean; summary: string; details?: unknown }) {
  await db.insert(syncEvents).values({ kind, jobUuid: opts.jobUuid ?? null, ok: opts.ok ?? true, summary: opts.summary, details: (opts.details as object) ?? null })
}

/** Everything the evaluator needs about a job, read fresh from the database. Null when the job was never synced. */
export async function loadOwnerInput(jobUuid: string, settings: WorkizSettings, notificationSettings: NotificationSettings): Promise<OwnerNotificationInput | null> {
  const [job] = await db.select().from(workizJobs).where(eq(workizJobs.uuid, jobUuid)).limit(1)
  if (!job) return null
  const rows = await db
    .select({
      id: payouts.id,
      name: technicianProfiles.name,
      status: payouts.status,
      total: payouts.totalPayout,
      tip: payouts.tipPayout,
      holdReason: payouts.holdReason,
      segmentKind: payouts.segmentKind,
      segmentMarker: payouts.segmentMarker,
      breakdown: payouts.breakdown,
    })
    .from(payouts)
    .innerJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id))
    .where(eq(payouts.jobUuid, jobUuid))
    .orderBy(asc(payouts.id))
  const teamIds = Array.isArray(job.teamIds) ? job.teamIds : []
  const mappings = teamIds.length ? await db.select().from(workizTeamMappings).where(inArray(workizTeamMappings.workizTeamId, teamIds)) : []
  const unmapped = teamIds.filter((id) => {
    const m = mappings.find((x) => x.workizTeamId === id)
    return !m || (m.profileId == null && !m.excluded)
  })
  const raw = (job.raw ?? null) as { LastStatusUpdate?: unknown } | null
  return {
    job: {
      uuid: job.uuid,
      serialId: job.serialId,
      clientName: job.clientName,
      jobType: job.jobType,
      status: job.status,
      fullyPaid: job.fullyPaid,
      jobTotal: Number(job.jobTotal),
      tipTotal: Number(job.cardTipAmount) + Number(job.nonCardTipAmount),
      payments: (Array.isArray(job.payments) ? job.payments : []) as NormalizedPayment[],
      lastStatusUpdate: typeof raw?.LastStatusUpdate === "string" ? raw.LastStatusUpdate : null,
    },
    techs: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      total: Number(r.total),
      tip: Number(r.tip),
      holdReason: r.holdReason,
      segmentKind: r.segmentKind,
      segmentMarker: r.segmentMarker,
      ownership: ((r.breakdown ?? null) as { ownership?: { reason?: string | null; workType?: string | null } } | null)?.ownership ?? null,
    })),
    unmappedTeamIds: unmapped,
    sender: { enabled: settings.payoutReadyTagEnabled, tag: settings.payoutReadyTag, hasCredentials: Boolean(settings.apiToken && settings.apiSecret) },
    recipient: {
      configured: Boolean(notificationSettings.ownerRecipient),
      label: notificationSettings.ownerRecipient?.name ?? null,
      masked: notificationSettings.ownerRecipient?.phoneMasked ?? null,
    },
    timeZone: settings.businessTimezone,
  }
}

export async function getOwnerNotification(jobUuid: string): Promise<OwnerNotificationRow | null> {
  const [row] = await db.select().from(ownerNotifications).where(eq(ownerNotifications.jobUuid, jobUuid)).limit(1)
  return row ?? null
}

/**
 * Re-evaluate one job and bring its outbox row up to date. Never downgrades a delivered row;
 * when the payout set changed after the text went out, the row keeps its status and the
 * difference is surfaced in `blockReason`. Delivers immediately when a Workiz client is at
 * hand and the row is queued; otherwise the cron picks it up.
 */
export async function refreshOwnerNotification(jobUuid: string, ctx: Ctx & { deliver?: boolean } = {}): Promise<OwnerRefreshResult | null> {
  const { settings, notificationSettings, client } = await ctxOf(ctx)
  const input = await loadOwnerInput(jobUuid, settings, notificationSettings)
  if (!input) return null
  const decision = evaluateOwnerNotification(input)
  const snapshotHash = decision.snapshotKey ? sha256(decision.snapshotKey) : null
  const now = new Date()
  const existing = await getOwnerNotification(jobUuid)
  const destination = { destinationLabel: input.recipient.label, destinationMasked: input.recipient.masked }

  let row: OwnerNotificationRow
  if (existing && (ACTIVE_STATES as readonly string[]).includes(existing.status)) {
    const changed = snapshotHash !== null && existing.sentSnapshotHash !== null && snapshotHash !== existing.sentSnapshotHash
    ;[row] = await db
      .update(ownerNotifications)
      .set({
        message: decision.message ?? existing.message,
        snapshotHash: snapshotHash ?? existing.snapshotHash,
        blockReason: changed ? "Payouts changed after this text was sent; the owner has the earlier amounts. Workiz texts only when the tag is first added, so re-sending needs the tag removed in Workiz first." : null,
        ...destination,
        updatedAt: now,
      })
      .where(eq(ownerNotifications.id, existing.id))
      .returning()
  } else if (existing && existing.status === "sending" && existing.lastAttemptAt && now.getTime() - existing.lastAttemptAt.getTime() < STALE_SENDING_MS) {
    row = existing
  } else {
    const keepBackoff = existing?.status === "failed" && existing.nextAttemptAt !== null && existing.nextAttemptAt > now && existing.attempts < MAX_ATTEMPTS
    const exhausted = existing?.status === "failed" && existing.nextAttemptAt === null && existing.attempts >= MAX_ATTEMPTS
    const status = decision.state === "ready" ? (keepBackoff || exhausted ? "failed" : "queued") : decision.state
    const values = {
      jobUuid,
      status,
      blockReason: decision.state === "ready" ? (exhausted ? existing?.lastError ?? "Retries exhausted; use Send now" : null) : decision.reason,
      snapshotHash,
      message: decision.message ?? "",
      ...destination,
      nextAttemptAt: status === "queued" ? now : keepBackoff ? existing!.nextAttemptAt : null,
      updatedAt: now,
    }
    ;[row] = await db
      .insert(ownerNotifications)
      .values(values)
      .onConflictDoUpdate({ target: ownerNotifications.jobUuid, set: values })
      .returning()
  }

  let delivery: DeliveryOutcome | null = null
  const shouldDeliver = ctx.deliver ?? Boolean(client)
  if (shouldDeliver && client && row.status === "queued") {
    delivery = await attemptDelivery(row.id, { settings, notificationSettings, client, via: ctx.via })
    row = (await getOwnerNotification(jobUuid)) ?? row
  }
  return { row, decision, delivery }
}

/**
 * Write the message into the Workiz job (tag + description) and read it back. Shared by the
 * live send and the admin test so both leave the same evidence.
 */
export async function deliverToWorkiz(client: WorkizClient, args: { uuid: string; tag: string; message: string; fresh?: WorkizRawJob | null }) {
  const fresh = args.fresh ?? (await client.getJob(args.uuid))
  if (!fresh) throw new Error(`Workiz job ${args.uuid} not found`)
  const before = Array.isArray(fresh.Tags) ? (fresh.Tags as unknown[]).map(String) : []
  const description = typeof fresh.JobNotes === "string" ? fresh.JobNotes : null
  const tag = normalizeTagName(args.tag)
  const tags = Array.from(new Set([...before, tag]))
  await client.updateJob(args.uuid, { Tags: tags, JobNotes: mergePayoutNote(description, args.message) })
  const after = await client.getJob(args.uuid)
  const tagsAfter = Array.isArray(after?.Tags) ? (after!.Tags as unknown[]).map(String) : []
  const descriptionAfter = typeof after?.JobNotes === "string" ? after.JobNotes : null
  return {
    tagWasPresent: hasTag(before, tag),
    tagApplied: hasTag(tagsAfter, tag),
    descriptionWritten: hasOwnerMessage(descriptionAfter),
    tagsBefore: before,
    tagsAfter,
  }
}

function hasOwnerMessage(description: string | null | undefined): boolean {
  return typeof description === "string" && (description.includes(OWNER_MESSAGE_HEADER) || hasPayoutNote(description))
}

/**
 * One delivery attempt. Claims the row atomically, re-checks eligibility and the snapshot,
 * reconciles an earlier ambiguous attempt (tag already on the job with our block in the
 * description = it went through), then writes to Workiz.
 */
export async function attemptDelivery(rowId: number, ctx: Ctx & { client: WorkizClient; force?: boolean }): Promise<DeliveryOutcome> {
  const { settings, notificationSettings, client } = await ctxOf(ctx)
  if (!client) return { outcome: "skipped", reason: "Workiz API token is not configured" }
  const now = new Date()
  const [claimed] = await db
    .update(ownerNotifications)
    .set({ status: "sending", attempts: sql`${ownerNotifications.attempts} + 1`, lastAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(ownerNotifications.id, rowId),
        or(
          inArray(ownerNotifications.status, ["queued"]),
          and(eq(ownerNotifications.status, "failed"), or(sql`${ownerNotifications.nextAttemptAt} is null and ${ownerNotifications.attempts} < ${MAX_ATTEMPTS}`, lte(ownerNotifications.nextAttemptAt, now))),
          and(eq(ownerNotifications.status, "sending"), lt(ownerNotifications.lastAttemptAt, new Date(now.getTime() - STALE_SENDING_MS))),
        ),
      ),
    )
    .returning()
  if (!claimed) return { outcome: "skipped", reason: "Not claimable (already sent, in progress, blocked, or waiting for its retry time)" }

  const input = await loadOwnerInput(claimed.jobUuid, settings, notificationSettings)
  const decision = input ? evaluateOwnerNotification(input) : null
  if (!input || !decision || decision.state !== "ready") {
    const state = decision?.state === "preview_only" ? "preview_only" : "blocked"
    const reason = decision && decision.state !== "ready" ? decision.reason : "Job snapshot missing"
    await db.update(ownerNotifications).set({ status: state, blockReason: reason, nextAttemptAt: null, updatedAt: new Date() }).where(eq(ownerNotifications.id, rowId))
    await log("owner-notify", { jobUuid: claimed.jobUuid, ok: false, summary: `Owner text for ${label(input, claimed.jobUuid)} not sent: ${reason}`, details: { ownerNotificationId: rowId, via: ctx.via ?? null } })
    return { outcome: "not_eligible", state, reason }
  }

  // Always send the message for the CURRENT payout snapshot, never a stale stored copy.
  const snapshotHash = sha256(decision.snapshotKey)
  const message = decision.message
  const via = ctx.via ?? "outbox"
  const jobLabel = label(input, claimed.jobUuid)

  try {
    const fresh = await client.getJob(claimed.jobUuid)
    if (!fresh) throw new Error(`Workiz job ${claimed.jobUuid} not found`)
    const tagsNow = Array.isArray(fresh.Tags) ? (fresh.Tags as unknown[]).map(String) : []
    const descriptionNow = typeof fresh.JobNotes === "string" ? fresh.JobNotes : null

    if (hasTag(tagsNow, settings.payoutReadyTag) && !ctx.force) {
      if (hasOwnerMessage(descriptionNow) || claimed.attempts > 1) {
        // An earlier attempt (or the pre-outbox tagging code) already went through: Workiz has the
        // tag and a payout block, so the automation fired. Record it instead of failing or re-sending.
        await db
          .update(ownerNotifications)
          .set({ status: "provider_accepted", sentAt: claimed.sentAt ?? now, sentSnapshotHash: snapshotHash, snapshotHash, message, lastError: null, nextAttemptAt: null, providerResponse: { reconciled: true, tagsAfter: tagsNow, descriptionWritten: hasOwnerMessage(descriptionNow), via }, updatedAt: new Date() })
          .where(eq(ownerNotifications.id, rowId))
        await log("job:tag", { jobUuid: claimed.jobUuid, ok: true, summary: `Owner text for ${jobLabel}: tag "${settings.payoutReadyTag}" already on the job with a payout summary - recorded as provider accepted (no second text) · via ${via}`, details: { ownerNotificationId: rowId, reconciled: true, tags: tagsNow } })
        return { outcome: "provider_accepted", reconciled: true, descriptionWritten: hasOwnerMessage(descriptionNow) }
      }
      const error = `Tag "${settings.payoutReadyTag}" is already on this job but no payout summary is in its description, so Workiz will not text again (it only fires when the tag is added). Remove the tag in Workiz, then use Send now.`
      await db.update(ownerNotifications).set({ status: "failed", lastError: error, attempts: MAX_ATTEMPTS, nextAttemptAt: null, snapshotHash, message, updatedAt: new Date() }).where(eq(ownerNotifications.id, rowId))
      await log("job:tag", { jobUuid: claimed.jobUuid, ok: false, summary: `Owner text for ${jobLabel} not sent: tag already present without summary · via ${via}`, details: { ownerNotificationId: rowId, tags: tagsNow } })
      return { outcome: "failed", error, retryAt: null }
    }

    const result = await deliverToWorkiz(client, { uuid: claimed.jobUuid, tag: settings.payoutReadyTag, message, fresh })
    if (!result.tagApplied) {
      const error = explainNotApplied(settings.payoutReadyTag)
      await db.update(ownerNotifications).set({ status: "failed", lastError: error, attempts: MAX_ATTEMPTS, nextAttemptAt: null, snapshotHash, message, providerResponse: result, updatedAt: new Date() }).where(eq(ownerNotifications.id, rowId))
      await log("job:tag", { jobUuid: claimed.jobUuid, ok: false, summary: `Tag "${settings.payoutReadyTag}" not applied to ${jobLabel} - create it in Workiz first · via ${via}`, details: { ownerNotificationId: rowId, ...result } })
      return { outcome: "failed", error, retryAt: null }
    }
    await db
      .update(ownerNotifications)
      .set({
        status: "provider_accepted",
        sentAt: now,
        sentSnapshotHash: snapshotHash,
        snapshotHash,
        message,
        lastError: result.descriptionWritten ? null : "Tag applied but the payout summary did not appear in the job description; the text may be missing amounts",
        nextAttemptAt: null,
        providerResponse: { ...result, via, acceptedAt: now.toISOString(), deliveryReceipt: "none (Workiz gives no SMS receipt)" },
        updatedAt: new Date(),
      })
      .where(eq(ownerNotifications.id, rowId))
    await db.update(payouts).set({ notifiedAt: now, updatedAt: now }).where(and(eq(payouts.jobUuid, claimed.jobUuid), eq(payouts.status, "ready")))
    await log("job:tag", {
      jobUuid: claimed.jobUuid,
      ok: true,
      summary: `Tagged ${jobLabel} with "${settings.payoutReadyTag}"${result.descriptionWritten ? " · owner summary written to description" : " · summary NOT in description"} · owner text handed to Workiz · via ${via}`,
      details: { ownerNotificationId: rowId, note: message, ...result, via },
    })
    return { outcome: "provider_accepted", reconciled: false, descriptionWritten: result.descriptionWritten }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const retryAt = nextRetryAt(claimed.attempts, now)
    await db.update(ownerNotifications).set({ status: "failed", lastError: error, nextAttemptAt: retryAt, snapshotHash, message, updatedAt: new Date() }).where(eq(ownerNotifications.id, rowId))
    await log("job:tag", { jobUuid: claimed.jobUuid, ok: false, summary: `Owner text for ${jobLabel} failed (attempt ${claimed.attempts}): ${error}${retryAt ? ` · retry at ${retryAt.toISOString()}` : " · retries exhausted"} · via ${via}`, details: { ownerNotificationId: rowId, error, attempts: claimed.attempts, retryAt } })
    return { outcome: "failed", error, retryAt }
  }
}

function label(input: OwnerNotificationInput | null, uuid: string) {
  return input?.job.serialId ? `#${input.job.serialId}` : uuid
}

export type OutboxSummary = { considered: number; accepted: number; failed: number; skipped: number; notEligible: number; results: Array<{ jobUuid: string; outcome: DeliveryOutcome["outcome"]; detail: string }> }

/**
 * Deliver everything that is due: queued rows, failed rows whose retry time has come, and
 * claims that went stale. Runs on every cron tick and after every webhook regardless of
 * whether any payout changed, so an unchanged ready-but-unsent job is never stranded.
 */
export async function processOwnerOutbox(ctx: Ctx & { limit?: number } = {}): Promise<OutboxSummary> {
  const { settings, notificationSettings, client } = await ctxOf(ctx)
  const summary: OutboxSummary = { considered: 0, accepted: 0, failed: 0, skipped: 0, notEligible: 0, results: [] }
  if (!client) return summary
  const now = new Date()
  const due = await db
    .select()
    .from(ownerNotifications)
    .where(
      or(
        eq(ownerNotifications.status, "queued"),
        and(eq(ownerNotifications.status, "failed"), lte(ownerNotifications.nextAttemptAt, now)),
        and(eq(ownerNotifications.status, "sending"), lt(ownerNotifications.lastAttemptAt, new Date(now.getTime() - STALE_SENDING_MS))),
      ),
    )
    .orderBy(asc(ownerNotifications.updatedAt))
    .limit(ctx.limit ?? 25)
  for (const row of due) {
    summary.considered++
    const outcome = await attemptDelivery(row.id, { settings, notificationSettings, client, via: ctx.via ?? "outbox" })
    if (outcome.outcome === "provider_accepted") summary.accepted++
    else if (outcome.outcome === "failed") summary.failed++
    else if (outcome.outcome === "skipped") summary.skipped++
    else summary.notEligible++
    summary.results.push({ jobUuid: row.jobUuid, outcome: outcome.outcome, detail: "reason" in outcome ? outcome.reason : "error" in outcome ? outcome.error : outcome.reconciled ? "reconciled earlier send" : "sent" })
  }
  return summary
}

/** Jobs whose owner text is still open (not delivered/accepted), for the reconcile revisit and diagnostics. */
export async function openOwnerNotificationJobUuids(limit = 100): Promise<string[]> {
  const rows = await db
    .select({ jobUuid: ownerNotifications.jobUuid })
    .from(ownerNotifications)
    .where(inArray(ownerNotifications.status, ["blocked", "preview_only", "queued", "failed"]))
    .orderBy(desc(ownerNotifications.updatedAt))
    .limit(limit)
  return rows.map((r) => r.jobUuid)
}

/**
 * Admin "Send payout to owner" for one job. Re-evaluates first; a job that already went out is
 * refused unless `force`, which resets the retry budget and, when the tag is already on the
 * job, only rewrites the description (Workiz cannot be made to text again through the API).
 */
export async function sendOwnerNotificationNow(jobUuid: string, opts: { force?: boolean; via?: string } = {}): Promise<{ row: OwnerNotificationRow | null; delivery: DeliveryOutcome; decision: OwnerNotificationDecision | null }> {
  const { settings, notificationSettings, client } = await ctxOf({})
  const refreshed = await refreshOwnerNotification(jobUuid, { settings, notificationSettings, client, deliver: false, via: opts.via })
  if (!refreshed) return { row: null, delivery: { outcome: "skipped", reason: "Job has not been synced yet" }, decision: null }
  const { row, decision } = refreshed
  if (decision.state !== "ready") return { row, delivery: { outcome: "not_eligible", state: decision.state, reason: decision.reason }, decision }
  if (!client) return { row, delivery: { outcome: "skipped", reason: "Workiz API token is not configured" }, decision }
  if ((ACTIVE_STATES as readonly string[]).includes(row.status) && !opts.force) {
    return { row, delivery: { outcome: "skipped", reason: `Already ${row.status.replace("_", " ")} on ${row.sentAt?.toISOString() ?? "an earlier run"}; use "Send again" to force` }, decision }
  }
  const now = new Date()
  await db.update(ownerNotifications).set({ status: "queued", attempts: 0, nextAttemptAt: now, lastError: null, updatedAt: now }).where(eq(ownerNotifications.id, row.id))
  const delivery = await attemptDelivery(row.id, { settings, notificationSettings, client, via: opts.via ?? "admin-send", force: opts.force })
  return { row: await getOwnerNotification(jobUuid), delivery, decision }
}

/** The owner confirms the SMS arrived; the only path to `delivered` because Workiz gives no receipt. */
export async function confirmOwnerDelivered(id: number, confirmedBy: string): Promise<OwnerNotificationRow | null> {
  const now = new Date()
  const [row] = await db
    .update(ownerNotifications)
    .set({ status: "delivered", deliveredAt: now, deliveredConfirmedBy: confirmedBy, updatedAt: now })
    .where(and(eq(ownerNotifications.id, id), eq(ownerNotifications.status, "provider_accepted")))
    .returning()
  return row ?? null
}

/**
 * Admin "Send test to owner": writes a clearly labelled TEST block (no amounts) and the tag to a
 * real job so the owner's Workiz automation fires once. Recorded in sync_events, never in the
 * outbox, so it can never be mistaken for a job's payout text.
 */
export async function sendOwnerTest(jobUuid: string): Promise<{ summary: string; tagApplied: boolean; descriptionWritten: boolean; tagWasPresent: boolean }> {
  const { settings, notificationSettings, client } = await ctxOf({})
  if (!client) throw new Error("Workiz API token is not configured. Add it in Admin > Workiz.")
  if (!notificationSettings.ownerRecipient) throw new Error("Pick the owner recipient first (Admin > Owner texts).")
  const [job] = await db.select({ uuid: workizJobs.uuid, serialId: workizJobs.serialId, clientName: workizJobs.clientName }).from(workizJobs).where(eq(workizJobs.uuid, jobUuid)).limit(1)
  if (!job) throw new Error("Job has not been synced yet")
  const when = new Date().toISOString().replace("T", " ").slice(0, 16)
  const message = [`${PAYOUT_NOTE_HEADER} - TEST`, `Job #${job.serialId ?? job.uuid} - ${job.clientName ?? "client"}`, `Test text from the GB payout app at ${when} UTC.`, `No payout is due from this message.`, `To: ${notificationSettings.ownerRecipient.name}${notificationSettings.ownerRecipient.phoneMasked ? ` ${notificationSettings.ownerRecipient.phoneMasked}` : ""}`].join("\n")
  const result = await deliverToWorkiz(client, { uuid: job.uuid, tag: settings.payoutReadyTag, message })
  const summary = result.tagWasPresent
    ? `Job #${job.serialId ?? job.uuid} already carried "${settings.payoutReadyTag}", so Workiz will NOT text again for it; the test block was written to its description only. Use a job without the tag.`
    : result.tagApplied
      ? `Tagged job #${job.serialId ?? job.uuid} with "${settings.payoutReadyTag}" and wrote the test block. If your Workiz automation is live, the text to ${notificationSettings.ownerRecipient.name} is on its way; confirm receipt below.`
      : explainNotApplied(settings.payoutReadyTag)
  await log("job:tag", { jobUuid: job.uuid, ok: result.tagApplied && !result.tagWasPresent, summary: `Owner TEST: ${summary}`, details: { test: true, note: message, ...result, recipient: notificationSettings.ownerRecipient } })
  return { summary, ...result }
}
