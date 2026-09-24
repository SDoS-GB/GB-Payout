/**
 * One-off: re-run every job that still has an unpaid (pending/hold/ready) payout through the
 * normal deduplicated sync path (`processRawJob`) using live Workiz data, so the saved payouts
 * reflect the current ownership/tip/card rules. Settled (paid) and void payouts are never
 * rewritten by the engine; a settled row whose inputs changed is flagged for review instead.
 *
 * Run from the project root:
 *   set -a && source /vercel/share/.env.project && set +a && pnpm dlx tsx scripts/reprocess-unpaid.ts
 * Pass --dry-run to only print the before snapshot.
 */
import { eq, inArray, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { payouts, technicianProfiles, workizJobs } from "@/lib/db/schema"
import { getWorkizClient, loadSyncContext, processRawJob } from "@/lib/workiz/sync"

const VIA = `reprocess-unpaid-${new Date().toISOString().slice(0, 10)}`
const dryRun = process.argv.includes("--dry-run")

type Row = {
  id: number
  jobUuid: string
  serialId: string | null
  tech: string
  status: string
  holdReason: string | null
  total: string
  tip: string
  segmentKind: string
  provisional: boolean
}

async function snapshot(uuids: string[]): Promise<Row[]> {
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
      segmentKind: payouts.segmentKind,
      provisional: sql<boolean>`coalesce((${payouts.breakdown} -> 'provisional')::boolean, false)`,
    })
    .from(payouts)
    .innerJoin(technicianProfiles, eq(technicianProfiles.id, payouts.profileId))
    .innerJoin(workizJobs, eq(workizJobs.uuid, payouts.jobUuid))
    .where(inArray(payouts.jobUuid, uuids))
    .orderBy(workizJobs.serialId, technicianProfiles.name)
  return rows.map((r) => ({ ...r, total: Number(r.total).toFixed(2), tip: Number(r.tip).toFixed(2) }))
}

async function main() {
  const unpaid = await db
    .selectDistinct({ jobUuid: payouts.jobUuid })
    .from(payouts)
    .where(inArray(payouts.status, ["pending", "hold", "ready"]))
  const uuids = unpaid.map((r) => r.jobUuid)
  console.log(`Jobs with unpaid payouts: ${uuids.length}`)

  const before = await snapshot(uuids)
  console.log("\nBEFORE")
  for (const r of before) console.log(`  #${r.serialId} ${r.tech.padEnd(8)} ${r.status.padEnd(7)} $${r.total.padStart(8)} tip $${r.tip.padStart(7)} ${r.segmentKind}${r.provisional ? " provisional" : ""}${r.holdReason ? ` — ${r.holdReason.slice(0, 60)}` : ""}`)
  if (dryRun) return

  const { client, settings } = await getWorkizClient()
  const context = await loadSyncContext(settings)

  console.log("\nSYNC")
  const failures: Array<{ uuid: string; error: string }> = []
  for (const uuid of uuids) {
    try {
      const raw = await client.getJob(uuid)
      if (!raw) throw new Error("not found in Workiz")
      const result = await processRawJob(raw, "rest", { ...context, via: VIA })
      const e = result.engine
      console.log(`  #${result.normalized.serialId ?? uuid} ${result.normalized.status ?? "?"} · +${e.created}/~${e.updated}/=${e.unchanged}${e.held ? ` held ${e.held}` : ""}${e.sourceChanges ? ` · ${e.sourceChanges} settled row(s) changed` : ""}${result.normalized.warnings.length ? ` · ${result.normalized.warnings.length} warning(s)` : ""}`)
      for (const n of e.notes) console.log(`      note: ${n}`)
      for (const w of result.normalized.warnings) console.log(`      warn: ${w.slice(0, 160)}`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failures.push({ uuid, error })
      console.log(`  ${uuid} FAILED: ${error}`)
    }
  }

  const after = await snapshot(uuids)
  const beforeById = new Map(before.map((r) => [r.id, r]))
  console.log("\nCHANGES")
  let changed = 0
  for (const r of after) {
    const b = beforeById.get(r.id)
    if (!b) {
      changed++
      console.log(`  NEW  #${r.serialId} ${r.tech} ${r.status} $${r.total} ${r.segmentKind}`)
      continue
    }
    const diffs: string[] = []
    if (b.status !== r.status) diffs.push(`status ${b.status} -> ${r.status}`)
    if (b.total !== r.total) diffs.push(`total $${b.total} -> $${r.total}`)
    if (b.tip !== r.tip) diffs.push(`tip $${b.tip} -> $${r.tip}`)
    if (b.segmentKind !== r.segmentKind) diffs.push(`segment ${b.segmentKind} -> ${r.segmentKind}`)
    if (b.provisional !== r.provisional) diffs.push(`provisional ${b.provisional} -> ${r.provisional}`)
    if (diffs.length) {
      changed++
      console.log(`  #${r.serialId} ${r.tech}: ${diffs.join(", ")}`)
    }
  }
  const afterIds = new Set(after.map((r) => r.id))
  for (const b of before) if (!afterIds.has(b.id)) { changed++; console.log(`  GONE #${b.serialId} ${b.tech} (${b.status} $${b.total})`) }
  console.log(`\n${changed} payout row(s) changed, ${failures.length} job(s) failed.`)
  if (failures.length) console.log(JSON.stringify(failures, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
