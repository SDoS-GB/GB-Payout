import { and, desc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { notifications, payouts, technicianProfiles, workizJobs, type NotificationRow } from "@/lib/db/schema"
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

/**
 * Render the message for a payout and persist a notification record.
 *
 * Delivery only happens when:
 *   1. the payout is "ready" (fully paid, payable status, mapped),
 *   2. notifications.sendEnabled is true, and
 *   3. no successful send already exists for this payout.
 * Otherwise the message is stored as a preview so the admin can inspect it.
 */
export async function notifyPayout(payoutId: number, opts: { force?: boolean } = {}): Promise<NotifyOutcome> {
  const [payout] = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1)
  if (!payout) return { payoutId, notificationId: null, status: "skipped", message: "", reason: "Payout not found" }

  const [profile] = await db.select().from(technicianProfiles).where(eq(technicianProfiles.id, payout.profileId)).limit(1)
  if (!profile) return { payoutId, notificationId: null, status: "skipped", message: "", reason: "Profile not found" }

  const [job] = await db.select().from(workizJobs).where(eq(workizJobs.uuid, payout.jobUuid)).limit(1)
  const settings = await getNotificationSettings()
  const message = renderTemplate(settings.template, buildTemplateContext(payout, profile, job ?? null))

  const alreadySent = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.payoutId, payoutId), eq(notifications.status, "sent")))
    .limit(1)
  if (alreadySent.length && !opts.force) {
    return { payoutId, notificationId: alreadySent[0].id, status: "skipped", message, reason: "Already sent" }
  }

  const canSend = payout.status === "ready" && settings.sendEnabled && settings.channel !== "none"
  const [record] = await db
    .insert(notifications)
    .values({
      payoutId,
      profileId: profile.id,
      jobUuid: payout.jobUuid,
      channel: settings.channel,
      status: "previewed",
      message,
    })
    .returning()

  if (!canSend) {
    const reason = !settings.sendEnabled
      ? "Sending is disabled"
      : payout.status !== "ready"
        ? `Payout status is ${payout.status}`
        : "Channel is none"
    return { payoutId, notificationId: record.id, status: "previewed", message, reason }
  }

  try {
    const workiz = await getWorkizSettings()
    const client = new WorkizClient({ apiToken: workiz.apiToken, apiSecret: workiz.apiSecret })
    const response = await client.addJobNote(payout.jobUuid, message)
    await db
      .update(notifications)
      .set({ status: "sent", sentAt: new Date(), providerResponse: response as object })
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
    .orderBy(desc(notifications.createdAt))
    .limit(1)
  return rows[0] ?? null
}
