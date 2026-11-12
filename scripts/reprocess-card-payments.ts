/**
 * Re-run the unsettled payouts whose customer payments were reported by Workiz, after the
 * card-label fix ("charge" / "Credit" / "Credit charge" are one method, job events carry
 * payments, tips sit inside Workiz's total).
 *
 * A job is affected when it still has a pending / hold / ready payout AND Workiz has told us
 * about its payments: a stored payment row from a webhook, or a stored webhook event that
 * lists payments. Each one goes through the normal sync path (`processRawJob`), which re-reads
 * the stored events first. Paid and void payouts are never rewritten by the engine; they are
 * printed before and after so that is visible. A hold clears only when the engine finds no
 * remaining reason for it.
 *
 *   set -a && source .env.development.local && set +a
 *   pnpm dlx tsx scripts/reprocess-card-payments.ts --dry-run   # list the jobs, change nothing
 *   pnpm dlx tsx scripts/reprocess-card-payments.ts             # reprocess from the stored job data
 *   pnpm dlx tsx scripts/reprocess-card-payments.ts --fetch     # re-fetch each job from Workiz first (one API call per job)
 */
import { eq, inArray, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { payouts, technicianProfiles, workizJobs } from "@/lib/db/schema"
import { reevaluateStoredJob, syncJobByUuid } from "@/lib/workiz/sync"

const VIA = `reprocess-card-payments-${new Date().toISOString().slice(0, 10)}`
const dryRun = process.argv.includes("--dry-run")
const fetchLive = process.argv.includes("--fetch")

type Row = { id: number; jobUuid: string; serialId: string | null; tech: string; status: string; holdReason: string | null; total: string; tip: string; card: string }

async function snapshot(uuids: string[]): Promise<Row[]> {
  if (uuids.length === 0) return []
  const rows = await db
    .select({
      id: payouts.id,
      jobUuid: payouts.jobUuid,
      serialId: workizJobs.serialId,
      tech: technicianProfiles.name,
      status: payouts.status,
      holdReason: payouts.holdReason,
      total: payouts.totalPayout,
      tip: payouts.tipPayout,
      card: payouts.cardServiceAmount,
    })
    .from(payouts)
    .innerJoin(technicianProfiles, eq(technicianProfiles.id, payouts.profileId))
    .innerJoin(workizJobs, eq(workizJobs.uuid, payouts.jobUuid))
    .where(inArray(payouts.jobUuid, uuids))
    .orderBy(workizJobs.serialId, technicianProfiles.name)
  return rows.map((r) => ({ ...r, total: Number(r.total).toFixed(2), tip: Number(r.tip).toFixed(2), card: Number(r.card).toFixed(2) }))
}

const line = (r: Row) => `  #${r.serialId} ${r.tech.padEnd(8)} ${r.status.padEnd(7)} $${r.total.padStart(9)}  tip $${r.tip.padStart(7)}  card-paid service $${r.card.padStart(9)}${r.holdReason ? `  — ${r.holdReason.slice(0, 90)}` : ""}`

async function main() {
  const affected = await db.execute<{ job_uuid: string }>(sql`
    select distinct p.job_uuid
    from payouts p
    where p.status in ('pending', 'hold', 'ready')
      and (
        exists (select 1 from job_payments jp where jp.job_uuid = p.job_uuid and jp.source <> 'manual')
        or exists (
          select 1 from webhook_events e
          where e.job_uuid = p.job_uuid
            and e.kind in ('job', 'invoice', 'estimate')
            and jsonb_typeof(e.payload -> 'data' -> 'payments') = 'array'
            and jsonb_array_length(e.payload -> 'data' -> 'payments') > 0
        )
      )`)
  const uuids = affected.rows.map((r) => r.job_uuid)
  console.log(`Unsettled jobs with payments reported by Workiz: ${uuids.length}`)

  const before = await snapshot(uuids)
  console.log("\nBEFORE")
  for (const r of before) console.log(line(r))
  if (dryRun || uuids.length === 0) return

  console.log(`\nREPROCESS (${fetchLive ? "re-fetching each job from Workiz" : "from the stored job data"})`)
  const failures: Array<{ uuid: string; error: string }> = []
  for (const uuid of uuids) {
    try {
      const result = fetchLive ? await syncJobByUuid(uuid, "rest", { via: VIA }) : await reevaluateStoredJob(uuid, VIA)
      if (!result) throw new Error("no stored job data")
      const n = result.normalized
      const e = result.engine
      console.log(`  #${n.serialId ?? uuid} ${n.status ?? "?"} · services $${n.jobTotal.toFixed(2)} · card $${n.cardServiceAmount.toFixed(2)} / other $${n.nonCardServiceAmount.toFixed(2)} · tips card $${n.cardTipAmount.toFixed(2)} / other $${n.nonCardTipAmount.toFixed(2)} · payouts +${e.created}/~${e.updated}/=${e.unchanged}${e.held ? ` · held ${e.held}` : ""}${e.sourceChanges ? ` · ${e.sourceChanges} settled row(s) flagged` : ""}`)
      for (const w of n.warnings) console.log(`      warn: ${w.slice(0, 170)}`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failures.push({ uuid, error })
      console.log(`  ${uuid} FAILED: ${error}`)
    }
  }

  const after = await snapshot(uuids)
  console.log("\nAFTER")
  for (const r of after) console.log(line(r))

  const beforeById = new Map(before.map((r) => [r.id, r]))
  console.log("\nCHANGES")
  let changed = 0
  let settledTouched = 0
  for (const r of after) {
    const b = beforeById.get(r.id)
    if (!b) {
      changed++
      console.log(`  NEW  #${r.serialId} ${r.tech} ${r.status} $${r.total}`)
      continue
    }
    const diffs: string[] = []
    if (b.status !== r.status) diffs.push(`status ${b.status} -> ${r.status}`)
    if (b.total !== r.total) diffs.push(`total $${b.total} -> $${r.total}`)
    if (b.tip !== r.tip) diffs.push(`tip $${b.tip} -> $${r.tip}`)
    if (b.card !== r.card) diffs.push(`card-paid service $${b.card} -> $${r.card}`)
    if ((b.holdReason ?? "") !== (r.holdReason ?? "")) diffs.push(r.holdReason ? `still held: ${r.holdReason.slice(0, 80)}` : "hold cleared")
    if (diffs.length) {
      changed++
      if (b.status === "paid" || b.status === "void") settledTouched++
      console.log(`  #${r.serialId} ${r.tech}: ${diffs.join(", ")}`)
    }
  }
  console.log(`\n${changed} payout row(s) changed, ${failures.length} job(s) failed, ${settledTouched} paid/void row(s) altered (must be 0).`)
  if (failures.length) console.log(JSON.stringify(failures, null, 2))
  if (settledTouched > 0) process.exitCode = 1
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
