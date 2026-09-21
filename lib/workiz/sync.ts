import { and, eq, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { colorSealItems, jobPayments, payouts, syncEvents, workizJobs, workizTeamMappings, type NormalizedPayment } from "@/lib/db/schema"
import { notifyPayout, type NotifyOutcome } from "@/lib/notifications/send"
import { upsertPayoutsForJob, type EngineResult } from "@/lib/payout/engine"
import { getWorkizSettings, type WorkizSettings } from "@/lib/settings"
import { WorkizClient, type WorkizRawJob } from "./client"
import { normalizeJob, type ColorSealCatalog, type NormalizedJob } from "./normalize"
import { externalRowsToPayments, type ExternalPaymentInput, type InvoiceWebhookPayments, type ManualPaymentEntry } from "./payments"
import { explainNotApplied, planPayoutReadyTag, verifyTagApplied, type TagSkipReason, type TagVerdict } from "./tags"

export type SyncSource = "rest" | "webhook"

export type TagOutcome =
  | { action: "skip"; reason: TagSkipReason | "no-client" }
  | { action: "add"; tag: string; verdict: TagVerdict }
  | { action: "add"; tag: string; error: string }

export type JobSyncResult = {
  uuid: string
  normalized: NormalizedJob
  engine: EngineResult
  notifications: NotifyOutcome[]
  tag: TagOutcome
}

async function jobHasReadyPayout(jobUuid: string): Promise<boolean> {
  const [row] = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.jobUuid, jobUuid), eq(payouts.status, "ready")))
    .limit(1)
  return Boolean(row)
}

/**
 * Add the payout-ready tag to a job in Workiz so the admin's Workiz automation can text them.
 * Idempotent: the tag already being on the job is the "done" marker. Never throws — a tagging
 * problem must not fail the payout sync — but every attempt is written to sync_events.
 */
export async function applyPayoutReadyTag(args: {
  client: WorkizClient
  uuid: string
  serialId: string | null
  existingTags: readonly string[]
  settings: WorkizSettings
  /** Admin self-test: tag even without a ready payout and even when the feature is off. */
  force?: boolean
  via?: string
}): Promise<TagOutcome> {
  const { client, uuid, serialId, existingTags, settings } = args
  const label = serialId ?? uuid
  const enabled = Boolean(args.force) || settings.payoutReadyTagEnabled
  if (!enabled) return { action: "skip", reason: "disabled" }
  const plan = planPayoutReadyTag({
    enabled,
    tag: settings.payoutReadyTag,
    existingTags,
    hasReadyPayout: Boolean(args.force) || (await jobHasReadyPayout(uuid)),
  })
  if (plan.action === "skip") return plan

  try {
    await client.updateJob(uuid, { Tags: plan.tags })
    const fresh = await client.getJob(uuid)
    const after = Array.isArray(fresh?.Tags) ? (fresh.Tags as unknown[]).map(String) : []
    const verdict = verifyTagApplied(after, plan.tag)
    await logSyncEvent("job:tag", {
      jobUuid: uuid,
      ok: verdict === "applied",
      summary:
        verdict === "applied"
          ? `Tagged ${label} with "${plan.tag}"${args.via ? ` · via ${args.via}` : ""}`
          : `Tag "${plan.tag}" not applied to ${label} — create it in Workiz first`,
      details: { tag: plan.tag, before: existingTags, after, verdict, via: args.via ?? null, forced: Boolean(args.force) },
    })
    return { action: "add", tag: plan.tag, verdict }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logSyncEvent("job:tag", {
      jobUuid: uuid,
      ok: false,
      summary: `Tagging ${label} failed: ${error}`,
      details: { tag: plan.tag, before: existingTags, error, via: args.via ?? null, forced: Boolean(args.force) },
    })
    return { action: "add", tag: plan.tag, error }
  }
}

export function describeTagOutcome(outcome: TagOutcome): string {
  if (outcome.action === "skip") return `skipped (${outcome.reason})`
  if ("error" in outcome) return `failed: ${outcome.error}`
  return outcome.verdict === "applied" ? `applied "${outcome.tag}"` : explainNotApplied(outcome.tag)
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

/** Stored invoice-webhook and admin-confirmed payments for a job, in normalizer shape. */
export async function loadExternalPayments(jobUuid: string, settings: WorkizSettings): Promise<NormalizedPayment[]> {
  const rows = await db.select().from(jobPayments).where(eq(jobPayments.jobUuid, jobUuid)).orderBy(jobPayments.paidAt, jobPayments.id)
  return externalRowsToPayments(rows, settings.cardMethodKeywords)
}

/**
 * Persist payments delivered by an invoice webhook. Keyed by Workiz's payment id, so a
 * retried or duplicated webhook updates the same row instead of doubling the paid total.
 * Records without an id cannot be de-duplicated safely and are skipped with a log entry.
 */
export async function recordExternalPayments(jobUuid: string, inputs: ExternalPaymentInput[]): Promise<{ stored: number; skipped: number }> {
  let stored = 0
  let skipped = 0
  for (const p of inputs) {
    if (!p.externalId) {
      skipped++
      continue
    }
    const now = new Date()
    const values = {
      jobUuid,
      externalId: p.externalId,
      source: p.source,
      method: p.method,
      amount: p.amount.toFixed(2),
      tipAmount: p.tipAmount.toFixed(2),
      paidAt: p.paidAt ? new Date(p.paidAt) : null,
      invoiceId: p.invoiceId,
      reference: p.reference,
      recordedBy: p.recordedBy,
      raw: (p.raw as object) ?? null,
      updatedAt: now,
    }
    if (values.paidAt && Number.isNaN(values.paidAt.getTime())) values.paidAt = null
    await db
      .insert(jobPayments)
      .values(values)
      .onConflictDoUpdate({
        target: [jobPayments.jobUuid, jobPayments.externalId],
        targetWhere: sql`${jobPayments.externalId} is not null`,
        set: { method: values.method, amount: values.amount, tipAmount: values.tipAmount, paidAt: values.paidAt, invoiceId: values.invoiceId, reference: values.reference, raw: values.raw, updatedAt: now },
      })
    stored++
  }
  if (skipped) await logSyncEvent("payments", { jobUuid, ok: false, summary: `${skipped} webhook payment record(s) had no id and were not stored`, details: { skipped } })
  return { stored, skipped }
}

/**
 * Replace the admin-confirmed payments for a job with a new set. Re-submitting the same
 * form is idempotent, and clearing the set (empty array) removes the confirmation.
 */
export async function replaceManualPayments(jobUuid: string, entries: ManualPaymentEntry[], recordedBy: string): Promise<number> {
  await db.transaction(async (tx) => {
    await tx.delete(jobPayments).where(and(eq(jobPayments.jobUuid, jobUuid), eq(jobPayments.source, "manual")))
    if (entries.length) {
      await tx.insert(jobPayments).values(
        entries.map((e) => ({
          jobUuid,
          externalId: null,
          source: "manual",
          method: e.method,
          amount: e.amount.toFixed(2),
          tipAmount: "0",
          paidAt: e.paidAt ? new Date(e.paidAt) : null,
          invoiceId: null,
          reference: e.reference ?? null,
          recordedBy,
          raw: null,
        })),
      )
    }
  })
  await logSyncEvent("payments", {
    jobUuid,
    ok: true,
    summary: entries.length ? `Admin confirmed ${entries.length} payment(s): ${entries.map((e) => `$${e.amount.toFixed(2)} ${e.method}`).join(", ")}` : "Admin cleared confirmed payments",
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
 * Process one raw Workiz job end to end. Safe to call repeatedly.
 */
export async function processRawJob(
  raw: WorkizRawJob,
  source: SyncSource,
  ctx?: { settings?: WorkizSettings; catalog?: ColorSealCatalog; client?: WorkizClient; via?: string },
): Promise<JobSyncResult> {
  const settings = ctx?.settings ?? (await getWorkizSettings())
  const catalog = ctx?.catalog ?? (await loadColorSealCatalog())

  // The job payload has no payment records; merge whatever an invoice webhook or an admin
  // has recorded for this job so a re-fetch never erases the known payment type.
  const uuid = typeof raw.UUID === "string" ? raw.UUID : null
  const externalPayments = uuid ? await loadExternalPayments(uuid, settings) : []
  const normalized = normalizeJob(raw, settings, catalog, { externalPayments })
  await saveJobSnapshot(normalized, raw, source)
  const engine = await upsertPayoutsForJob(normalized, settings, source)

  const notifications: NotifyOutcome[] = []
  const touched = engine.created + engine.updated
  if (touched > 0) {
    for (const id of engine.payoutIds) notifications.push(await notifyPayout(id))
  }

  const tag: TagOutcome = ctx?.client
    ? await applyPayoutReadyTag({
        client: ctx.client,
        uuid: normalized.uuid,
        serialId: normalized.serialId,
        existingTags: normalized.tags,
        settings,
        via: ctx.via ?? source,
      })
    : { action: "skip", reason: "no-client" }

  await logSyncEvent(`job:${source}`, {
    jobUuid: normalized.uuid,
    ok: true,
    summary: `${normalized.serialId ?? normalized.uuid} · ${normalized.status ?? "?"} · total ${normalized.jobTotal.toFixed(2)} · payouts +${engine.created}/~${engine.updated}/=${engine.unchanged}${engine.held ? ` · held ${engine.held}` : ""}${tag.action === "add" ? ` · tag ${"verdict" in tag ? tag.verdict : "error"}` : ""}${ctx?.via ? ` · via ${ctx.via}` : ""}`,
    details: { engine, warnings: normalized.warnings, via: ctx?.via ?? null, tag, notifications: notifications.map((n) => ({ id: n.notificationId, status: n.status, reason: n.reason })) },
  })

  return { uuid: normalized.uuid, normalized, engine, notifications, tag }
}

/** Fetch a single job from Workiz by UUID and process it. */
export async function syncJobByUuid(uuid: string, source: SyncSource = "rest", opts?: { via?: string }): Promise<JobSyncResult> {
  const { client, settings } = await getWorkizClient()
  const raw = await client.getJob(uuid)
  if (!raw) throw new Error(`Workiz job ${uuid} not found`)
  const catalog = await loadColorSealCatalog()
  return processRawJob(raw, source, { settings, catalog, client, via: opts?.via })
}

/**
 * An `invoice_*` webhook is the one Workiz surface that names the payment type. Resolve the
 * job (Workiz's example puts the job uuid in `data.uuid`; other candidates get a turn), store
 * the payments, then run the normal processing path. Returns null when no candidate is a job,
 * after logging the invoice ids so the real payload shape can be confirmed from sync_events.
 */
export async function syncInvoiceWebhook(args: { uuidCandidates: string[]; invoice: InvoiceWebhookPayments | null; via: string }): Promise<JobSyncResult | null> {
  const { client, settings } = await getWorkizClient()
  const catalog = await loadColorSealCatalog()
  let lastError: string | null = null
  for (const candidate of args.uuidCandidates) {
    let raw: WorkizRawJob | null = null
    try {
      raw = await client.getJob(candidate)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (!/not found/i.test(lastError)) throw err
    }
    if (!raw?.UUID) continue
    if (args.invoice) {
      const { stored, skipped } = await recordExternalPayments(raw.UUID, args.invoice.payments)
      await logSyncEvent("payments", {
        jobUuid: raw.UUID,
        ok: true,
        summary: `Invoice webhook (${args.via}) carried ${args.invoice.payments.length} payment record(s): stored ${stored}${skipped ? `, skipped ${skipped}` : ""}`,
        details: { invoiceId: args.invoice.invoiceId, jobId: args.invoice.jobId, invoiceTotal: args.invoice.invoiceTotal, amountDue: args.invoice.amountDue, payments: args.invoice.payments.map((p) => ({ id: p.externalId, method: p.method, amount: p.amount, tipAmount: p.tipAmount, paidAt: p.paidAt })) },
      })
    } else {
      await logSyncEvent("payments", { jobUuid: raw.UUID, ok: true, summary: `Invoice webhook (${args.via}) included no payments array; job re-synced from the balance only`, details: { candidates: args.uuidCandidates } })
    }
    return processRawJob(raw, "webhook", { settings, catalog, client, via: args.via })
  }
  await logSyncEvent("webhook", {
    jobUuid: args.uuidCandidates[0] ?? null,
    ok: false,
    summary: `Invoice webhook (${args.via}) could not be matched to a job${lastError ? `: ${lastError}` : ""}`,
    details: { candidates: args.uuidCandidates, invoiceId: args.invoice?.invoiceId ?? null, jobId: args.invoice?.jobId ?? null, paymentCount: args.invoice?.payments.length ?? null },
  })
  return null
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
        const result = await processRawJob(detail ?? listed, "rest", { settings, catalog, client, via: "reconcile" })
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
