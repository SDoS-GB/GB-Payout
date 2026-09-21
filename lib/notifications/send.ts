import { and, desc, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { notifications, payouts, technicianProfiles, workizJobs, type NotificationRow, type TechnicianProfile } from "@/lib/db/schema"
import { getNotificationSettings, getWorkizSettings } from "@/lib/settings"
import { WorkizClient } from "@/lib/workiz/client"
import { buildTemplateContext, renderTemplate } from "./template"

export type NotifyOutcome = {
  payoutId: number
  notificationId: number | null
  status: "previewed" | "sent" | "failed" | "skipped"
  message: string
  reason?: string
}

/** Delivers one rendered message. Tests pass a mock; production uses the Workiz job note. */
export type Deliver = (input: { jobUuid: string; message: string; profile: TechnicianProfile }) => Promise<unknown>

const deliverViaWorkizNote: Deliver = async ({ jobUuid, message }) => {
  const workiz = await getWorkizSettings()
  const client = new WorkizClient({ apiToken: workiz.apiToken, apiSecret: workiz.apiSecret })
  return client.addJobNote(jobUuid, message)
}

const isUniqueViolation = (err: unknown) => {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code
  return code === "23505"
}

/**
 * Render the message for a payout and persist a notification record.
 *
 * Delivery only happens when:
 *   1. the payout is "ready" (fully paid, payable status, mapped),
 *   2. notifications.sendEnabled is true and a channel is configured, and
 *   3. no delivery for this payout is in flight or already sent.
 * Condition 3 is enforced by the database: `notifications_payout_delivery_unique`
 * allows one row per payout in status sending/sent, so two overlapping syncs
 * cannot both deliver. Otherwise the message is stored as a preview so the admin
 * can inspect it; an identical preview is not stored twice in a row.
 */
export async function notifyPayout(payoutId: number, opts: { force?: boolean; deliver?: Deliver } = {}): Promise<NotifyOutcome> {
  const [payout] = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1)
  if (!payout) return { payoutId, notificationId: null, status: "skipped", message: "", reason: "Payout not found" }

  const [profile] = await db.select().from(technicianProfiles).where(eq(technicianProfiles.id, payout.profileId)).limit(1)
  if (!profile) return { payoutId, notificationId: null, status: "skipped", message: "", reason: "Profile not found" }

  const [job] = await db.select().from(workizJobs).where(eq(workizJobs.uuid, payout.jobUuid)).limit(1)
  const settings = await getNotificationSettings()
  const message = renderTemplate(settings.template, buildTemplateContext(payout, profile, job ?? null))

  const latest = await latestNotificationForPayout(payoutId)
  const delivered = await db
    .select({ id: notifications.id, status: notifications.status })
    .from(notifications)
    .where(and(eq(notifications.payoutId, payoutId), inArray(notifications.status, ["sending", "sent"])))
    .limit(1)

  if (delivered.length && !opts.force) {
    const reason = delivered[0].status === "sent" ? "Already sent" : "Delivery already in progress"
    return { payoutId, notificationId: delivered[0].id, status: "skipped", message, reason }
  }

  const canSend = payout.status === "ready" && settings.sendEnabled && settings.channel !== "none"
  if (!canSend) {
    const reason = !settings.sendEnabled ? "Sending is disabled" : payout.status !== "ready" ? `Payout status is ${payout.status}` : "Channel is none"
    if (latest && latest.status === "previewed" && latest.message === message) {
      return { payoutId, notificationId: latest.id, status: "previewed", message, reason }
    }
    const [record] = await db
      .insert(notifications)
      .values({ payoutId, profileId: profile.id, jobUuid: payout.jobUuid, channel: settings.channel, status: "previewed", message })
      .returning()
    return { payoutId, notificationId: record.id, status: "previewed", message, reason }
  }

  if (opts.force && delivered.length) {
    // An admin explicitly asked for another copy: keep the earlier delivery in history, but
    // relabel it so the one-delivery-per-payout index lets the new attempt claim its slot.
    await db.update(notifications).set({ status: "resent" }).where(and(eq(notifications.payoutId, payoutId), inArray(notifications.status, ["sent"])))
  }

  let record: NotificationRow
  try {
    ;[record] = await db
      .insert(notifications)
      .values({ payoutId, profileId: profile.id, jobUuid: payout.jobUuid, channel: settings.channel, status: "sending", message })
      .returning()
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [winner] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.payoutId, payoutId), inArray(notifications.status, ["sending", "sent"])))
        .limit(1)
      return { payoutId, notificationId: winner?.id ?? null, status: "skipped", message, reason: "Delivery already claimed by another sync" }
    }
    throw err
  }

  try {
    const response = await (opts.deliver ?? deliverViaWorkizNote)({ jobUuid: payout.jobUuid, message, profile })
    await db
      .update(notifications)
      .set({ status: "sent", sentAt: new Date(), providerResponse: (response ?? null) as object | null })
      .where(eq(notifications.id, record.id))
    await db.update(payouts).set({ notifiedAt: new Date(), updatedAt: new Date() }).where(eq(payouts.id, payoutId))
    return { payoutId, notificationId: record.id, status: "sent", message }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await db.update(notifications).set({ status: "failed", error }).where(eq(notifications.id, record.id))
    return { payoutId, notificationId: record.id, status: "failed", message, reason: error }
  }
}

export async function latestNotificationForPayout(payoutId: number): Promise<NotificationRow | null> {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.payoutId, payoutId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(1)
  return rows[0] ?? null
}
