import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { colorSealItems, syncEvents, workizJobs, workizTeamMappings } from "@/lib/db/schema"
import { notifyPayout, type NotifyOutcome } from "@/lib/notifications/send"
import { upsertPayoutsForJob, type EngineResult } from "@/lib/payout/engine"
import { getWorkizSettings, type WorkizSettings } from "@/lib/settings"
import { WorkizClient, type WorkizRawJob } from "./client"
import { normalizeJob, type ColorSealCatalog, type NormalizedJob } from "./normalize"

export type SyncSource = "rest" | "webhook"

export type JobSyncResult = {
  uuid: string
  normalized: NormalizedJob
  engine: EngineResult
  notifications: NotifyOutcome[]
}

export async function logSyncEvent(kind: string, opts: { jobUuid?: string | null; ok?: boolean; summary?: string; details?: unknown } = {}) {
  await db.insert(syncEvents).values({
    kind,
    jobUuid: opts.jobUuid ?? null,
    ok: opts.ok ?? true,
    summary: opts.summary ?? null,
    details: (opts.details as object) ?? null,
  })
}

export async function loadColorSealCatalog(): Promise<ColorSealCatalog> {
  const rows = await db.select().from(colorSealItems)
  return new Map(rows.map((r) => [r.productId, r.isColorSeal]))
}

export async function getWorkizClient(settings?: WorkizSettings) {
  const s = settings ?? (await getWorkizSettings())
  if (!s.apiToken) throw new Error("Workiz API token is not configured. Add it in Admin → Workiz settings.")
  return { client: new WorkizClient({ apiToken: s.apiToken, apiSecret: s.apiSecret }), settings: s }
}

export async function saveJobSnapshot(job: NormalizedJob, raw: WorkizRawJob, source: SyncSource) {
  const now = new Date()
  const values = {
    uuid: job.uuid,
    serialId: job.serialId,
    status: job.status,
    subStatus: job.subStatus,
    paymentDueDate: job.paymentDueDate,
    jobDateTime: job.jobDateTime,
    jobEndDateTime: job.jobEndDateTime,
    clientId: job.clientId,
    clientName: job.clientName,
    address: job.address,
    jobType: job.jobType,
    jobSource: job.jobSource,
    jobTotal: job.jobTotal.toFixed(2),
    subTotal: job.subTotal === null ? null : job.subTotal.toFixed(2),
    taxAmount: job.taxAmount === null ? null : job.taxAmount.toFixed(2),
    discountAmount: job.discountAmount.toFixed(2),
    colorSealTotal: job.colorSealTotal.toFixed(2),
    cardServiceAmount: job.cardServiceAmount.toFixed(2),
    nonCardServiceAmount: job.nonCardServiceAmount.toFixed(2),
    cardTipAmount: job.cardTipAmount.toFixed(2),
    nonCardTipAmount: job.nonCardTipAmount.toFixed(2),
    totalPaid: job.totalPaid.toFixed(2),
    fullyPaid: job.fullyPaid,
    invoiceStatus: job.invoiceStatus,
    teamIds: job.teamIds,
    teamNames: job.teamNames,
    tags: job.tags,
    lineItems: job.lineItems,
    payments: job.payments,
    raw: raw as object,
    source,
    lastSeenAt: now,
    updatedAt: now,
  }
  await db
    .insert(workizJobs)
    .values(values)
    .onConflictDoUpdate({ target: workizJobs.uuid, set: values })
}

/**
 * Process one raw Workiz job end to end. Safe to call repeatedly.
 */
export async function processRawJob(raw: WorkizRawJob, source: SyncSource, ctx?: { settings: WorkizSettings; catalog: ColorSealCatalog }): Promise<JobSyncResult> {
  const settings = ctx?.settings ?? (await getWorkizSettings())
  const catalog = ctx?.catalog ?? (await loadColorSealCatalog())

  const normalized = normalizeJob(raw, settings, catalog)
  await saveJobSnapshot(normalized, raw, source)
  const engine = await upsertPayoutsForJob(normalized, settings, source)

  const notifications: NotifyOutcome[] = []
  const touched = engine.created + engine.updated
  if (touched > 0) {
    for (const id of engine.payoutIds) notifications.push(await notifyPayout(id))
  }

  await logSyncEvent(`job:${source}`, {
    jobUuid: normalized.uuid,
    ok: true,
    summary: `${normalized.serialId ?? normalized.uuid} · ${normalized.status ?? "?"} · total ${normalized.jobTotal.toFixed(2)} · payouts +${engine.created}/~${engine.updated}/=${engine.unchanged}${engine.held ? ` · held ${engine.held}` : ""}`,
    details: { engine, warnings: normalized.warnings, notifications: notifications.map((n) => ({ id: n.notificationId, status: n.status, reason: n.reason })) },
  })

  return { uuid: normalized.uuid, normalized, engine, notifications }
}

/** Fetch a single job from Workiz by UUID and process it. */
export async function syncJobByUuid(uuid: string, source: SyncSource = "rest"): Promise<JobSyncResult> {
  const { client, settings } = await getWorkizClient()
  const raw = await client.getJob(uuid)
  if (!raw) throw new Error(`Workiz job ${uuid} not found`)
  const catalog = await loadColorSealCatalog()
  return processRawJob(raw, source, { settings, catalog })
}

export type ReconcileSummary = {
  scanned: number
  processed: number
  failed: number
  created: number
  updated: number
  held: number
  unmappedTeamIds: string[]
  errors: Array<{ uuid: string | null; error: string }>
  startDate: string
}

/**
 * Cron reconciliation: list every job updated in the lookback window and
 * re-process it. `job/all/` returns list-level fields only, so each job is
 * refetched with `job/get/` to pick up line items and payments.
 */
export async function reconcileRecentJobs(opts: { lookbackDays?: number; maxJobs?: number } = {}): Promise<ReconcileSummary> {
  const { client, settings } = await getWorkizClient()
  const catalog = await loadColorSealCatalog()
  const lookback = opts.lookbackDays ?? settings.reconcileLookbackDays
  const start = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000)
  const startDate = start.toISOString().slice(0, 10)
  const maxJobs = opts.maxJobs ?? 300

  const summary: ReconcileSummary = { scanned: 0, processed: 0, failed: 0, created: 0, updated: 0, held: 0, unmappedTeamIds: [], errors: [], startDate }
  const unmapped = new Set<string>()

  let offset = 0
  let hasMore = true
  while (hasMore && summary.scanned < maxJobs) {
    const page = await client.listJobs({ startDate, offset, records: 100 })
    for (const listed of page.jobs) {
      if (summary.scanned >= maxJobs) break
      summary.scanned++
      const uuid = typeof listed.UUID === "string" ? listed.UUID : null
      try {
        const detail = uuid ? await client.getJob(uuid) : null
        const result = await processRawJob(detail ?? listed, "rest", { settings, catalog })
        summary.processed++
        summary.created += result.engine.created
        summary.updated += result.engine.updated
        summary.held += result.engine.held
        result.engine.unmappedTeamIds.forEach((id) => unmapped.add(id))
      } catch (err) {
        summary.failed++
        summary.errors.push({ uuid, error: err instanceof Error ? err.message : String(err) })
      }
    }
    hasMore = page.hasMore && page.jobs.length > 0
    offset += page.jobs.length
  }

  summary.unmappedTeamIds = Array.from(unmapped)
  await logSyncEvent("reconcile", {
    ok: summary.failed === 0,
    summary: `Scanned ${summary.scanned}, processed ${summary.processed}, failed ${summary.failed}, payouts +${summary.created}/~${summary.updated}, held ${summary.held}`,
    details: summary,
  })
  return summary
}

/** Pull team members from Workiz so every stable id has a mapping row. */
export async function syncTeamMappings() {
  const { client } = await getWorkizClient()
  const team = await client.listTeam()
  let created = 0
  for (const member of team) {
    if (!member.id) continue
    const existing = await db.select({ id: workizTeamMappings.id }).from(workizTeamMappings).where(eq(workizTeamMappings.workizTeamId, member.id)).limit(1)
    if (existing.length === 0) created++
    await db
      .insert(workizTeamMappings)
      .values({ workizTeamId: member.id, workizName: member.name, workizRole: member.role, source: "rest" })
      .onConflictDoUpdate({
        target: workizTeamMappings.workizTeamId,
        set: { workizName: member.name, workizRole: member.role, updatedAt: new Date() },
      })
  }
  await logSyncEvent("team-sync", { summary: `Synced ${team.length} team members (${created} new)` })
  return { total: team.length, created }
}
