import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { notifications, payouts, workizJobs } from "@/lib/db/schema"

/** Everything a technician may see: only their own payouts, never other techs' rows. */
export async function listPayoutsForProfile(profileId: number, limit = 200) {
  const rows = await db
    .select({
      payout: payouts,
      job: {
        serialId: workizJobs.serialId,
        clientName: workizJobs.clientName,
        address: workizJobs.address,
        status: workizJobs.status,
        jobDateTime: workizJobs.jobDateTime,
        jobType: workizJobs.jobType,
      },
    })
    .from(payouts)
    .leftJoin(workizJobs, eq(payouts.jobUuid, workizJobs.uuid))
    .where(and(eq(payouts.profileId, profileId), inArray(payouts.status, ["ready", "hold", "pending", "paid"])))
    .orderBy(desc(payouts.updatedAt))
    .limit(limit)

  const ids = rows.map((r) => r.payout.id)
  const sent = ids.length
    ? await db
        .select({ payoutId: notifications.payoutId, message: notifications.message, sentAt: notifications.sentAt })
        .from(notifications)
        .where(and(inArray(notifications.payoutId, ids), eq(notifications.status, "sent")))
        .orderBy(desc(notifications.sentAt))
    : []
  const sentByPayout = new Map<number, (typeof sent)[number]>()
  for (const s of sent) if (!sentByPayout.has(s.payoutId)) sentByPayout.set(s.payoutId, s)

  const [totals] = await db
    .select({
      ready: sql<number>`coalesce(sum(${payouts.totalPayout}) filter (where ${payouts.status} = 'ready'), 0)`.mapWith(Number),
      paid30: sql<number>`coalesce(sum(${payouts.totalPayout}) filter (where ${payouts.status} = 'paid' and ${payouts.paidAt} > now() - interval '30 days'), 0)`.mapWith(Number),
      pendingCount: sql<number>`count(*) filter (where ${payouts.status} in ('pending','hold'))`.mapWith(Number),
    })
    .from(payouts)
    .where(eq(payouts.profileId, profileId))

  return {
    items: rows.map((r) => ({ ...r.payout, job: r.job, sentMessage: sentByPayout.get(r.payout.id) ?? null })),
    totals,
  }
}

export type TechnicianPayoutList = Awaited<ReturnType<typeof listPayoutsForProfile>>
