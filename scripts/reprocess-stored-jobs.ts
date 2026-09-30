/**
 * Re-run the payout engine on jobs already stored in `workiz_jobs` WITHOUT calling Workiz:
 * the same path the cron, Refresh and Undo use after a fetch. Useful to prove that a job's
 * saved payments and status produce the expected payout rows before anyone opens the admin.
 *
 *   set -a && source /vercel/share/v0-project/.env.development.local && set +a
 *   pnpm dlx tsx scripts/reprocess-stored-jobs.ts <uuid> [<uuid> ...]
 *
 * Paid and void payouts are never rewritten (the engine flags source changes instead).
 */
import { inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { payouts, technicianProfiles } from "@/lib/db/schema"
import { reevaluateStoredJob } from "@/lib/workiz/sync"

async function main() {
  const uuids = process.argv.slice(2).filter(Boolean)
  if (uuids.length === 0) {
    console.error("usage: tsx scripts/reprocess-stored-jobs.ts <uuid> [<uuid> ...]")
    process.exit(2)
  }
  for (const uuid of uuids) {
    const res = await reevaluateStoredJob(uuid, "reprocess-stored-jobs script")
    if (!res) {
      console.log(`${uuid}: no stored job`)
      continue
    }
    const n = res.normalized
    console.log(`${uuid}: status=${n.status} fullyPaid=${n.fullyPaid} services=${n.jobTotal.toFixed(2)} card=${n.cardServiceAmount.toFixed(2)} other=${n.nonCardServiceAmount.toFixed(2)} tips=${(n.cardTipAmount + n.nonCardTipAmount).toFixed(2)} created=${res.engine.created} updated=${res.engine.updated} held=${res.engine.held}`)
    for (const note of res.engine.notes) console.log(`   ${note}`)
  }
  const rows = await db
    .select({ id: payouts.id, jobUuid: payouts.jobUuid, name: technicianProfiles.name, status: payouts.status, total: payouts.totalPayout, hold: payouts.holdReason })
    .from(payouts)
    .leftJoin(technicianProfiles, inArray(technicianProfiles.id, [payouts.profileId]))
    .where(inArray(payouts.jobUuid, uuids))
    .orderBy(payouts.jobUuid, payouts.id)
  for (const r of rows) console.log(`payout #${r.id} ${r.jobUuid} ${r.name ?? "?"} ${r.status} $${Number(r.total).toFixed(2)}${r.hold ? ` — ${r.hold.slice(0, 90)}` : ""}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
