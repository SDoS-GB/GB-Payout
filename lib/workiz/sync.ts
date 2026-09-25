import { and, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { appSettings, colorSealItems, jobPayments, payouts, syncEvents, workizJobs, workizTeamMappings, type NormalizedPayment } from "@/lib/db/schema"
import { upsertPayoutsForJob, type EngineResult } from "@/lib/payout/engine"
import { getPayoutSettings, getWorkizSettings, type WorkizSettings } from "@/lib/settings"
import { WorkizApiError, WorkizClient, type WorkizRawJob } from "./client"
import { bumpWebhookEventAttempt, markWebhookEvent, pendingUnresolvedEvents, rememberJobIds, resolveJobUuid } from "./events"
import { compareListing } from "./listing-diff"
import { normalizeJob, type ColorSealCatalog, type NormalizedJob } from "./normalize"
import { TIP_INCLUSION_RAW_KEY, externalRowsToPayments, type ExternalPaymentInput, type InvoiceWebhookPayments, type ManualPaymentEntry, type TipInclusion } from "./payments"
import { parseWebhookBody, type ParsedWebhook } from "./webhook"

export type SyncSource = "rest" | "webhook"

export type JobSyncResult = {
  uuid: string
  normalized: NormalizedJob
  engine: EngineResult
}

/** Sync-wide context loaded once per run so every job sees the same cutoff and settings. */
export type SyncContext = {
  settings: WorkizSettings
  catalog: ColorSealCatalog
  openingCutoff: Date | null
}

export async function loadSyncContext(settings?: WorkizSettings): Promise<SyncContext> {
  const [s, catalog, payout] = await Promise.all([settings ?? getWorkizSettings(), loadColorSealCatalog(), getPayoutSettings()])
  return { settings: s, catalog, openingCutoff: payout.openingCutoffAt ? new Date(payout.openingCutoffAt) : null }
}

/** The cron must never look back less than this: `job/all?start_date` filters on the scheduled date, and jobs are paid weeks later. */
export const MIN_RECONCILE_LOOKBACK_DAYS = 30

/**
 * `job/get` calls one reconcile may spend. Listing a page of 100 jobs is one call; each detail
 * fetch is another, and the Workiz account quota is shared with webhooks and the admin UI.
 * Observed live 2026-09-23: two runs were cut off by 429 after 30 and 29 consecutive job/get
 * calls, so the whole run must stay well under 30. Anything left over waits for the next run,
 * stalest first.
 */
export const DEFAULT_RECONCILE_DETAIL_BUDGET = 20
/** Open jobs (payout pending/hold/ready) re-fetched per run even when their listing looks unchanged. */
export const DEFAULT_RECONCILE_MAX_REVISITS = 10

/** One reconcile at a time: cron and "Sync now" share this lease, held in app_settings. */
const SYNC_LEASE_KEY = "sync_lease"
const SYNC_LEASE_SECONDS = 15 * 60

export class SyncInProgressError extends Error {
  constructor(public readonly holder: string, public readonly since: string) {
    super(`A Workiz sync started by ${holder} at ${since} is still running`)
  }
}

async function acquireSyncLease(holder: string): Promise<{ token: string } | { busy: { holder: string; since: string } }> {
  const token = `${holder}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const now = new Date()
  const value = { token, holder, since: now.toISOString(), expiresAt: new Date(now.getTime() + SYNC_LEASE_SECONDS * 1000).toISOString() }
  const rows = await db
    .insert(appSettings)
    .values({ key: SYNC_LEASE_KEY, value, updatedAt: now, updatedBy: holder })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now, updatedBy: holder },
      setWhere: sql`(${appSettings.value}->>'expiresAt')::timestamptz < now()`,
    })
    .returning({ value: appSettings.value })
  if (rows.length) return { token }
  const [current] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SYNC_LEASE_KEY)).limit(1)
  const held = (current?.value ?? {}) as { holder?: string; since?: string }
  return { busy: { holder: held.holder ?? "another run", since: held.since ?? "unknown" } }
}

async function releaseSyncLease(token: string) {
  await db
    .update(appSettings)
    .set({ value: { token: null, holder: null, since: null, expiresAt: new Date(0).toISOString() }, updatedAt: new Date() })
    .where(and(eq(appSettings.key, SYNC_LEASE_KEY), sql`${appSettings.value}->>'token' = ${token}`))
}

/** Workiz answers 429 once the account's API quota is used up; nothing else will succeed until it resets. */
export function isWorkizQuotaError(err: unknown): boolean {
  return err instanceof WorkizApiError && err.status === 429
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

// --- Payment records the job payload never carries -----------------------------

/** Stored webhook and admin-confirmed payments for a job, in normalizer shape. */
export async function loadExternalPayments(jobUuid: string, settings: WorkizSettings): Promise<NormalizedPayment[]> {
  const rows = await db.select().from(jobPayments).where(eq(jobPayments.jobUuid, jobUuid)).orderBy(jobPayments.paidAt, jobPayments.id)
  return externalRowsToPayments(rows, settings.cardMethodKeywords)
}

/**
 * Persist payments delivered by an invoice or estimate webhook. Keyed by Workiz's payment id
 * ("PAY-…"), so a retried or duplicated webhook updates the same row instead of doubling the
 * paid total. Live payloads carry no per-payment date, so `paidAt` is the arrival time of the
 * FIRST event that mentioned the payment and is never moved forward by a later re-delivery
 * (the Sep 15 deposit must still read Sep 15 when the Sep 23 invoice event repeats it).
 * Records without an id cannot be de-duplicated safely and are skipped with a log entry.
 */
export async function recordExternalPayments(jobUuid: string, inputs: ExternalPaymentInput[], opts: { tipInclusion?: TipInclusion } = {}): Promise<{ stored: number; skipped: number }> {
  let stored = 0
  let skipped = 0
  for (const p of inputs) {
    if (!p.externalId) {
      skipped++
      continue
    }
    const now = new Date()
    let paidAt = p.paidAt ? new Date(p.paidAt) : null
    if (paidAt && Number.isNaN(paidAt.getTime())) paidAt = null
    const raw = { ...((p.raw as object) ?? {}), [TIP_INCLUSION_RAW_KEY]: opts.tipInclusion ?? "separate" }
    const values = {
      jobUuid,
      externalId: p.externalId,
      source: p.source,
      method: p.method,
      amount: p.amount.toFixed(2),
      tipAmount: p.tipAmount.toFixed(2),
      paidAt,
      paidAtFromPayload: p.paidAtFromPayload,
      invoiceId: p.invoiceId,
      reference: p.reference,
      recordedBy: p.recordedBy,
      raw: raw as object,
      updatedAt: now,
    }
    await db
      .insert(jobPayments)
      .values(values)
      .onConflictDoUpdate({
        target: [jobPayments.jobUuid, jobPayments.externalId],
        targetWhere: sql`${jobPayments.externalId} is not null`,
        set: {
          method: values.method,
          amount: values.amount,
          tipAmount: values.tipAmount,
          // A payload date always wins; an arrival-time date only fills a gap.
          paidAt: p.paidAtFromPayload ? values.paidAt : sql`coalesce(${jobPayments.paidAt}, ${values.paidAt})`,
          paidAtFromPayload: sql`${jobPayments.paidAtFromPayload} or ${p.paidAtFromPayload}`,
          invoiceId: values.invoiceId,
          reference: values.reference,
          raw: values.raw,
          updatedAt: now,
        },
      })
    stored++
  }
  if (skipped) await logSyncEvent("payments", { jobUuid, ok: false, summary: `${skipped} webhook payment record(s) had no id and were not stored`, details: { skipped } })
  return { stored, skipped }
}

/**
 * Replace the admin-confirmed payments for a job with a new set. Re-submitting the same
 * form is idempotent, and clearing the set (empty array) removes the confirmation. This is
 * the labelled recovery path for payments Workiz never reported (no invoice/estimate event).
 */
export async function replaceManualPayments(jobUuid: string, entries: ManualPaymentEntry[], recordedBy: string): Promise<number> {
  await db.transaction(async (tx) => {
    await tx.delete(jobPayments).where(and(eq(jobPayments.jobUuid, jobUuid), eq(jobPayments.source, "manual")))
    if (entries.length) {
      await tx.insert(jobPayments).values(
        entries.map((e) => {
          const tip = e.tipAmount ?? 0
          return {
            jobUuid,
            externalId: null,
            source: "manual",
            method: e.method,
            amount: e.amount.toFixed(2),
            tipAmount: tip.toFixed(2),
            paidAt: e.paidAt ? new Date(e.paidAt) : null,
            paidAtFromPayload: Boolean(e.paidAt),
            invoiceId: null,
            reference: e.reference ?? null,
            recordedBy,
            // The admin types the charge as Workiz shows it, tip included, so the service part is the remainder.
            raw: tip > 0 ? { [TIP_INCLUSION_RAW_KEY]: "included" } : null,
          }
        }),
      )
    }
  })
  await logSyncEvent("payments", {
    jobUuid,
    ok: true,
    summary: entries.length
      ? `Admin confirmed ${entries.length} payment(s) (recovery entry): ${entries.map((e) => `$${e.amount.toFixed(2)} ${e.method}${e.tipAmount ? ` incl. $${e.tipAmount.toFixed(2)} tip` : ""}`).join(", ")}`
      : "Admin cleared confirmed payments",
    details: { entries, recordedBy },
  })
  return entries.length
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
 * Process one raw Workiz job end to end: merge stored payments, snapshot, compute payouts.
 * Safe to call repeatedly; settled payouts are never rewritten (the engine flags source changes).
 */
export async function processRawJob(raw: WorkizRawJob, source: SyncSource, ctx?: Partial<SyncContext> & { via?: string }): Promise<JobSyncResult> {
  const context = ctx?.settings && ctx.catalog && ctx.openingCutoff !== undefined ? (ctx as SyncContext) : await loadSyncContext(ctx?.settings)
  const { settings, catalog, openingCutoff } = context

  // The job payload has no payment records; merge whatever a webhook or an admin has
  // recorded for this job so a re-fetch never erases the known payment type.
  const uuid = typeof raw.UUID === "string" ? raw.UUID : null
  const externalPayments = uuid ? await loadExternalPayments(uuid, settings) : []
  const normalized = normalizeJob(raw, settings, catalog, { externalPayments })
  await saveJobSnapshot(normalized, raw, source)
  const engine = await upsertPayoutsForJob(normalized, settings, source, { openingCutoff })

  await logSyncEvent(`job:${source}`, {
    jobUuid: normalized.uuid,
    ok: true,
    summary: `${normalized.serialId ?? normalized.uuid} · ${normalized.status ?? "?"} · total ${normalized.jobTotal.toFixed(2)} · payouts +${engine.created}/~${engine.updated}/=${engine.unchanged}${engine.held ? ` · held ${engine.held}` : ""}${engine.sourceChanges ? ` · ${engine.sourceChanges} settled row(s) changed in Workiz` : ""}${ctx?.via ? ` · via ${ctx.via}` : ""}`,
    details: { engine, warnings: normalized.warnings, via: ctx?.via ?? null },
  })

  return { uuid: normalized.uuid, normalized, engine }
}

/**
 * Re-run the payout engine from the job snapshot already stored, without calling Workiz. Used
 * after an Undo so each payout returns to its correct open state immediately; the next
 * scheduled sync still refreshes the job from Workiz as usual.
 */
export async function reevaluateStoredJob(uuid: string, via: string): Promise<JobSyncResult | null> {
  const [row] = await db.select({ raw: workizJobs.raw }).from(workizJobs).where(eq(workizJobs.uuid, uuid)).limit(1)
  if (!row?.raw || typeof row.raw !== "object") return null
  const context = await loadSyncContext()
  return processRawJob(row.raw as WorkizRawJob, "rest", { ...context, via })
}

/** Fetch a single job from Workiz by UUID and process it. */
export async function syncJobByUuid(uuid: string, source: SyncSource = "rest", opts?: { via?: string }): Promise<JobSyncResult> {
  const { client, settings } = await getWorkizClient()
  const raw = await client.getJob(uuid)
  if (!raw) throw new Error(`Workiz job ${uuid} not found`)
  const context = await loadSyncContext(settings)
  return processRawJob(raw, source, { ...context, via: opts?.via })
}

export type DocumentSyncResult =
  | { resolved: true; result: JobSyncResult; stored: number; skipped: number }
  | { resolved: false; reason: string }

/**
 * Invoice and estimate webhooks are the one Workiz surface that names the payment type, and
 * estimate events are how an online deposit paid weeks before the job reaches us. Resolve the
 * job (payload uuid → learned JOB-… map), store the payments, then run the normal processing
 * path. `resolved: false` means the job's UUID is not known yet; the caller parks the event
 * and it is replayed once a job/invoice event teaches the id.
 */
export async function syncDocumentWebhook(args: { parsed: Pick<ParsedWebhook, "uuidCandidates" | "jobInternalId" | "invoice" | "kind" | "serialId">; via: string }): Promise<DocumentSyncResult> {
  const { client, settings } = await getWorkizClient()
  const context = await loadSyncContext(settings)
  const invoice: InvoiceWebhookPayments | null = args.parsed.invoice
  const kind = args.parsed.kind === "estimate" ? "estimate" : "invoice"

  const candidates = [...args.parsed.uuidCandidates]
  const mapped = await resolveJobUuid(args.parsed.jobInternalId)
  if (mapped && !candidates.includes(mapped)) candidates.push(mapped)

  let lastError: string | null = null
  for (const candidate of candidates) {
    let raw: WorkizRawJob | null = null
    try {
      raw = await client.getJob(candidate)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (!/not found/i.test(lastError)) throw err
    }
    if (!raw?.UUID) continue
    await rememberJobIds({ internalId: args.parsed.jobInternalId, uuid: raw.UUID, serialId: typeof raw.SerialId === "string" || typeof raw.SerialId === "number" ? raw.SerialId : null })
    let stored = 0
    let skipped = 0
    if (invoice) {
      ;({ stored, skipped } = await recordExternalPayments(raw.UUID, invoice.payments, { tipInclusion: invoice.tipInclusion }))
      await logSyncEvent("payments", {
        jobUuid: raw.UUID,
        ok: true,
        summary: `${kind === "estimate" ? "Estimate" : "Invoice"} webhook (${args.via}) carried ${invoice.payments.length} payment record(s): stored ${stored}${skipped ? `, skipped ${skipped}` : ""}${invoice.tipInclusion !== "separate" ? ` · tip inclusion ${invoice.tipInclusion}` : ""}`,
        details: {
          kind,
          documentId: invoice.invoiceId,
          jobId: invoice.jobId,
          total: invoice.invoiceTotal,
          amountDue: invoice.amountDue,
          tipInclusion: invoice.tipInclusion,
          payments: invoice.payments.map((p) => ({ id: p.externalId, method: p.method, amount: p.amount, tipAmount: p.tipAmount, paidAt: p.paidAt, paidAtFromPayload: p.paidAtFromPayload })),
        },
      })
    } else {
      await logSyncEvent("payments", { jobUuid: raw.UUID, ok: true, summary: `${kind === "estimate" ? "Estimate" : "Invoice"} webhook (${args.via}) included no payments array; job re-synced from the balance only`, details: { candidates } })
    }
    const result = await processRawJob(raw, "webhook", { ...context, via: args.via })
    return { resolved: true, result, stored, skipped }
  }
  const reason = args.parsed.jobInternalId
    ? `Job ${args.parsed.jobInternalId} is not mapped to a Workiz UUID yet; the ${kind} event is parked until a job or invoice event for it arrives`
    : `No job UUID in the ${kind} payload${lastError ? ` (${lastError})` : ""}`
  return { resolved: false, reason }
}

/**
 * Replay parked document events whose JOB-… id has since been learned (or for one internal id
 * right after a job event taught it). Bounded; each event is attempted at most a few times.
 */
export type ReplaySummary = { replayed: number; resolved: number; stillUnresolved: number; failed: number; quotaHit: boolean }

export async function replayUnresolvedEvents(opts: { internalId?: string; limit?: number; via?: string } = {}): Promise<ReplaySummary> {
  const summary: ReplaySummary = { replayed: 0, resolved: 0, stillUnresolved: 0, failed: 0, quotaHit: false }
  const pending = await pendingUnresolvedEvents({ internalId: opts.internalId, limit: opts.limit ?? 25 })
  for (const ev of pending) {
    if (summary.quotaHit) {
      summary.stillUnresolved++
      continue
    }
    summary.replayed++
    try {
      await bumpWebhookEventAttempt(ev.id)
      const parsed = parseWebhookBody(ev.payload)
      const outcome = await syncDocumentWebhook({ parsed, via: `${opts.via ?? "replay"} · ${parsed.triggerType ?? ev.triggerType ?? "event"}${parsed.ruleName ? ` · rule "${parsed.ruleName}"` : ""}` })
      if (outcome.resolved) {
        summary.resolved++
        await markWebhookEvent(ev.id, "processed", { jobUuid: outcome.result.uuid })
      } else {
        summary.stillUnresolved++
        if (ev.attempts + 1 >= 20) await markWebhookEvent(ev.id, "failed", { error: `Gave up after ${ev.attempts + 1} attempts: ${outcome.reason}` })
      }
    } catch (err) {
      if (isWorkizQuotaError(err)) {
        // A quota blip is not the event's fault: leave it parked for the next run.
        summary.quotaHit = true
        summary.stillUnresolved++
        continue
      }
      summary.failed++
      await markWebhookEvent(ev.id, "failed", { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return summary
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
  lookbackDays: number
  /** Open jobs (payout pending/hold/ready or owner text not out) re-fetched by UUID, stalest first. */
  revisited: number
  /** Listed jobs whose status, money, dates, tags and crew matched the stored snapshot; not re-fetched. */
  unchanged: number
  /** `job/get` calls spent this run: the Workiz quota cost. */
  detailFetches: number
  detailBudget: number
  /** Jobs that were due but left for the next run because the budget ran out or Workiz returned 429. */
  deferred: number
  /** Workiz answered 429 (account API quota); the run stopped calling Workiz and left the rest for next time. */
  quotaHit: boolean
  /** Settled payouts whose Workiz inputs changed this run (flagged for review, never rewritten). */
  sourceChanges: number
  replay: ReplaySummary
  /** Who started the run (cron, admin, resume) and when; kept in the audit row. */
  trigger: string
  startedAt: string
  finishedAt: string
  /** True only when every phase completed: no failed job, no quota cut-off, no deferred work left behind by a 429. */
  complete: boolean
}

/** Jobs that still owe something (an open payout), stalest detail fetch first. */
async function openJobUuids(limit: number): Promise<string[]> {
  const fromPayouts = await db
    .select({ uuid: payouts.jobUuid })
    .from(payouts)
    .where(inArray(payouts.status, ["pending", "hold", "ready"]))
    .groupBy(payouts.jobUuid)
  const open = Array.from(new Set(fromPayouts.map((r) => r.uuid)))
  if (!open.length) return []
  const rows = await db.select({ uuid: workizJobs.uuid, updatedAt: workizJobs.updatedAt }).from(workizJobs).where(inArray(workizJobs.uuid, open))
  const fetchedAt = new Map(rows.map((r) => [r.uuid, r.updatedAt.getTime()]))
  return open.sort((a, b) => (fetchedAt.get(a) ?? 0) - (fetchedAt.get(b) ?? 0)).slice(0, limit)
}

export type ReconcileOptions = { lookbackDays?: number; maxJobs?: number; maxRevisits?: number; maxDetailFetches?: number; trigger?: string }

/**
 * Scheduled reconciliation (Vercel Cron → /api/cron/reconcile, and the admin "Sync now"), in
 * three bounded phases that together spend at most `maxDetailFetches` job/get calls and stop at
 * the first 429. Only one run holds the lease at a time; a second caller gets
 * `SyncInProgressError` instead of racing the first.
 *  1. list every job scheduled in the lookback window (floored at 30 days; one call per 100 jobs)
 *     and re-fetch only the ones that are new or whose listing differs from the stored snapshot;
 *  2. re-fetch open jobs the listing did not refresh, stalest first — old deposits, jobs
 *     scheduled long ago and finished today, held jobs waiting for payment details;
 *  3. parked estimate/invoice events whose job id has since been learned.
 * The audit row is `ok` only when the run was complete; a cut-off run is logged as incomplete
 * so the dashboard shows the last GENUINELY successful sync.
 */
export async function reconcileRecentJobs(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const trigger = opts.trigger ?? "manual"
  const lease = await acquireSyncLease(trigger)
  if ("busy" in lease) throw new SyncInProgressError(lease.busy.holder, lease.busy.since)
  try {
    return await runReconcile(opts, trigger)
  } finally {
    await releaseSyncLease(lease.token)
  }
}

async function runReconcile(opts: ReconcileOptions, trigger: string): Promise<ReconcileSummary> {
  const startedAt = new Date()
  const { client, settings } = await getWorkizClient()
  const context = await loadSyncContext(settings)
  const lookback = Math.max(MIN_RECONCILE_LOOKBACK_DAYS, opts.lookbackDays ?? settings.reconcileLookbackDays)
  const start = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000)
  const startDate = start.toISOString().slice(0, 10)
  const maxJobs = opts.maxJobs ?? 300
  const budget = Math.max(1, opts.maxDetailFetches ?? DEFAULT_RECONCILE_DETAIL_BUDGET)

  const summary: ReconcileSummary = {
    scanned: 0,
    processed: 0,
    failed: 0,
    created: 0,
    updated: 0,
    held: 0,
    unmappedTeamIds: [],
    errors: [],
    startDate,
    lookbackDays: lookback,
    revisited: 0,
    unchanged: 0,
    detailFetches: 0,
    detailBudget: budget,
    deferred: 0,
    quotaHit: false,
    sourceChanges: 0,
    replay: { replayed: 0, resolved: 0, stillUnresolved: 0, failed: 0, quotaHit: false },
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    complete: false,
  }
  const unmapped = new Set<string>()
  const refreshed = new Set<string>()

  const handle = async (raw: WorkizRawJob, via: string) => {
    const result = await processRawJob(raw, "rest", { ...context, via })
    refreshed.add(result.uuid)
    summary.processed++
    summary.created += result.engine.created
    summary.updated += result.engine.updated
    summary.held += result.engine.held
    summary.sourceChanges += result.engine.sourceChanges
    result.engine.unmappedTeamIds.forEach((id) => unmapped.add(id))
  }

  const noteQuota = (uuid: string | null, err: unknown) => {
    if (summary.quotaHit) return
    summary.quotaHit = true
    summary.errors.push({ uuid, error: `${err instanceof Error ? err.message : String(err)} — the run stopped calling Workiz; everything left over is picked up next run.` })
  }

  /** One job/get inside the budget. `fallback` is the listing payload, used only when Workiz returns no detail. */
  const fetchDetail = async (uuid: string, via: string, fallback?: WorkizRawJob): Promise<"fetched" | "deferred" | "failed"> => {
    if (summary.quotaHit || summary.detailFetches >= budget) {
      summary.deferred++
      return "deferred"
    }
    summary.detailFetches++
    try {
      const detail = await client.getJob(uuid)
      const raw = detail ?? fallback
      if (raw) await handle(raw, via)
      return "fetched"
    } catch (err) {
      if (isWorkizQuotaError(err)) {
        noteQuota(uuid, err)
        summary.deferred++
        return "deferred"
      }
      summary.failed++
      summary.errors.push({ uuid, error: err instanceof Error ? err.message : String(err) })
      return "failed"
    }
  }

  // Phase 1: list the window (cheap), then fetch only what is new or changed.
  const listed: Array<{ uuid: string; raw: WorkizRawJob }> = []
  let offset = 0
  let hasMore = true
  let listingFailed: string | null = null
  while (hasMore && summary.scanned < maxJobs) {
    let page: Awaited<ReturnType<typeof client.listJobs>>
    try {
      page = await client.listJobs({ startDate, offset, records: 100 })
    } catch (err) {
      if (isWorkizQuotaError(err)) {
        noteQuota(null, err)
        break
      }
      // A failed listing page is an incomplete run, not "no changes": nothing stored is touched.
      listingFailed = err instanceof Error ? err.message : String(err)
      summary.errors.push({ uuid: null, error: `Workiz job listing failed at offset ${offset}: ${listingFailed}` })
      break
    }
    for (const job of page.jobs) {
      if (summary.scanned >= maxJobs) break
      summary.scanned++
      if (typeof job.UUID === "string" && job.UUID) listed.push({ uuid: job.UUID, raw: job })
    }
    hasMore = page.hasMore && page.jobs.length > 0
    offset += page.jobs.length
  }

  const storedRaw = new Map<string, WorkizRawJob | null>()
  if (listed.length) {
    const rows = await db
      .select({ uuid: workizJobs.uuid, raw: workizJobs.raw })
      .from(workizJobs)
      .where(inArray(workizJobs.uuid, listed.map((l) => l.uuid)))
    for (const row of rows) storedRaw.set(row.uuid, (row.raw ?? null) as WorkizRawJob | null)
  }

  const unchanged: string[] = []
  for (const { uuid, raw } of listed) {
    const verdict = compareListing(raw, storedRaw.get(uuid))
    if (verdict.verdict === "unchanged") {
      summary.unchanged++
      unchanged.push(uuid)
      continue
    }
    await fetchDetail(uuid, "reconcile", raw)
  }

  if (unchanged.length) {
    await db.update(workizJobs).set({ lastSeenAt: new Date() }).where(inArray(workizJobs.uuid, unchanged))
  }

  // Phase 2: open jobs the listing did not refresh, stalest first.
  for (const uuid of await openJobUuids(opts.maxRevisits ?? DEFAULT_RECONCILE_MAX_REVISITS)) {
    if (refreshed.has(uuid)) continue
    const outcome = await fetchDetail(uuid, "reconcile-revisit")
    if (outcome !== "deferred") summary.revisited++
  }

  // Phase 3: parked estimate/invoice events.
  if (!summary.quotaHit && !listingFailed) {
    try {
      summary.replay = await replayUnresolvedEvents({ via: "reconcile" })
      if (summary.replay.quotaHit) noteQuota(null, new Error("Workiz API quota reached while replaying parked webhook events"))
    } catch (err) {
      summary.errors.push({ uuid: null, error: `Replay of parked events failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  summary.unmappedTeamIds = Array.from(unmapped)
  summary.finishedAt = new Date().toISOString()
  // Budget-deferred work is normal and expected (it is picked up next run); a 429 or a failed
  // listing/detail call is not — those leave the checkpoint where it was.
  summary.complete = summary.failed === 0 && !summary.quotaHit && !listingFailed
  await logSyncEvent("reconcile", {
    ok: summary.complete,
    summary: `${summary.complete ? "Synced" : "INCOMPLETE sync"} (${trigger}) · listed ${summary.scanned} (${lookback}d): ${summary.unchanged} unchanged, fetched ${summary.detailFetches}/${budget}, revisited ${summary.revisited}, deferred ${summary.deferred}, failed ${summary.failed}${summary.quotaHit ? " · WORKIZ QUOTA HIT" : ""}${listingFailed ? " · LISTING FAILED" : ""} · payouts +${summary.created}/~${summary.updated}, held ${summary.held}${summary.sourceChanges ? `, ${summary.sourceChanges} settled changed` : ""} · parked events replayed ${summary.replay.replayed}`,
    details: summary,
  })
  return summary
}

export type SyncStatus = {
  /** Most recent reconcile that completed every phase. */
  lastSuccessAt: string | null
  lastSuccessSummary: string | null
  /** Most recent reconcile attempt of any outcome. */
  lastAttemptAt: string | null
  lastAttemptOk: boolean | null
  lastAttemptSummary: string | null
  /** A lease is currently held (a run is in flight). */
  running: { holder: string; since: string } | null
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const [lastSuccess] = await db
    .select({ createdAt: syncEvents.createdAt, summary: syncEvents.summary })
    .from(syncEvents)
    .where(and(eq(syncEvents.kind, "reconcile"), eq(syncEvents.ok, true)))
    .orderBy(sql`${syncEvents.id} desc`)
    .limit(1)
  const [lastAttempt] = await db
    .select({ createdAt: syncEvents.createdAt, summary: syncEvents.summary, ok: syncEvents.ok })
    .from(syncEvents)
    .where(eq(syncEvents.kind, "reconcile"))
    .orderBy(sql`${syncEvents.id} desc`)
    .limit(1)
  const [lease] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SYNC_LEASE_KEY)).limit(1)
  const held = (lease?.value ?? {}) as { holder?: string | null; since?: string | null; expiresAt?: string | null }
  const running = held.holder && held.expiresAt && new Date(held.expiresAt).getTime() > Date.now() ? { holder: held.holder, since: held.since ?? "" } : null
  return {
    lastSuccessAt: lastSuccess?.createdAt.toISOString() ?? null,
    lastSuccessSummary: lastSuccess?.summary ?? null,
    lastAttemptAt: lastAttempt?.createdAt.toISOString() ?? null,
    lastAttemptOk: lastAttempt?.ok ?? null,
    lastAttemptSummary: lastAttempt?.summary ?? null,
    running,
  }
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
