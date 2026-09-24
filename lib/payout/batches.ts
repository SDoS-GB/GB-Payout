import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm"
import { db } from "@/lib/db"
import {
  paymentBatches,
  payoutSettlements,
  payouts,
  syncEvents,
  technicianProfiles,
  workizJobs,
  type PaymentBatchRow,
  type PayoutRow,
  type PayoutSettlementRow,
} from "@/lib/db/schema"
import { round2, selectionTotal, validateSelection, type SelectionItem, type StaleItem } from "./batch-rules"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type RecordBatchInput = {
  profileId: number
  items: SelectionItem[]
  method: string
  /** YYYY-MM-DD in the business timezone. */
  paidOn: string
  reference?: string | null
  idempotencyKey: string
  actor: string
}

export type RecordBatchResult =
  | { ok: true; batch: PaymentBatchRow; settledPayoutIds: number[]; replayed: boolean }
  | { ok: false; kind: "stale"; stale: StaleItem[] }
  | { ok: false; kind: "error"; error: string }

class StaleSelection extends Error {
  constructor(public readonly stale: StaleItem[]) {
    super("stale selection")
  }
}

async function audit(tx: Tx | typeof db, kind: string, summary: string, details: unknown, jobUuid: string | null = null) {
  await tx.insert(syncEvents).values({ kind, jobUuid, ok: true, summary, details: details as object })
}

/** The payout row as history keeps it: money columns and breakdown, no volatile bookkeeping. */
function snapshotOf(row: PayoutRow) {
  const { updatedAt, createdAt, reviewedAt, reviewedBy, notifiedAt, batchId, settledKind, ...rest } = row
  void updatedAt
  void createdAt
  void reviewedAt
  void reviewedBy
  void notifiedAt
  void batchId
  void settledKind
  return rest
}

/**
 * Settles the selected payouts in one transaction: a batch row, one settlement per payout, and
 * the payout rows flipped to paid. Anything stale (amount, status, technician, job data) aborts
 * the whole batch with the list of affected rows; nothing is recorded at a different amount.
 * `idempotencyKey` makes a retried or double-tapped request return the batch already saved.
 */
export async function recordPaymentBatch(input: RecordBatchInput): Promise<RecordBatchResult> {
  const ids = input.items.map((i) => i.payoutId)
  if (ids.length === 0) return { ok: false, kind: "error", error: "Nothing selected" }
  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.select().from(paymentBatches).where(eq(paymentBatches.idempotencyKey, input.idempotencyKey)).limit(1)
      if (existing[0]) {
        const settled = await tx.select({ payoutId: payoutSettlements.payoutId }).from(payoutSettlements).where(eq(payoutSettlements.batchId, existing[0].id))
        return { ok: true as const, batch: existing[0], settledPayoutIds: settled.map((s) => s.payoutId), replayed: true }
      }

      // Lock the rows so a concurrent sync or second tab waits for this decision.
      const rows = await tx.select().from(payouts).where(inArray(payouts.id, ids)).for("update")
      const check = validateSelection(input.profileId, input.items, rows)
      if (!check.ok) throw new StaleSelection(check.stale)

      const total = selectionTotal(input.items)
      const now = new Date()
      const [batch] = await tx
        .insert(paymentBatches)
        .values({
          profileId: input.profileId,
          kind: "payment",
          status: "recorded",
          method: input.method,
          paidOn: input.paidOn,
          // The owner settles every selected payout in full, so the transfer equals the calculated total.
          paidAmount: total.toFixed(2),
          calculatedTotal: total.toFixed(2),
          itemCount: input.items.length,
          reference: input.reference?.trim() || null,
          idempotencyKey: input.idempotencyKey,
          recordedAt: now,
          recordedBy: input.actor,
        })
        .returning()

      const byId = new Map(rows.map((r) => [r.id, r]))
      await tx.insert(payoutSettlements).values(
        input.items.map((item) => {
          const row = byId.get(item.payoutId) as PayoutRow
          return {
            batchId: batch.id,
            payoutId: row.id,
            profileId: row.profileId,
            jobUuid: row.jobUuid,
            amount: round2(Number(row.totalPayout)).toFixed(2),
            exactAmount: row.totalPayout,
            calcVersion: calcVersionOf(row),
            inputHash: row.inputHash,
            snapshot: snapshotOf(row),
            status: "settled",
            createdAt: now,
          }
        }),
      )

      const flipped = await tx
        .update(payouts)
        .set({ status: "paid", paidAt: now, paidBy: input.actor, batchId: batch.id, settledKind: "payment", updatedAt: now })
        .where(and(inArray(payouts.id, ids), eq(payouts.status, "ready")))
        .returning({ id: payouts.id })
      if (flipped.length !== ids.length) {
        throw new StaleSelection(ids.filter((id) => !flipped.some((f) => f.id === id)).map((id) => ({ payoutId: id, reason: "Changed while saving", currentStatus: null, currentAmount: null })))
      }

      await audit(tx, "batch:record", `Batch #${batch.id}: paid ${input.items.length} payout${input.items.length === 1 ? "" : "s"} $${total.toFixed(2)} by ${input.method} on ${input.paidOn}`, {
        batchId: batch.id,
        profileId: input.profileId,
        payoutIds: ids,
        method: input.method,
        paidOn: input.paidOn,
        total,
        reference: input.reference ?? null,
        actor: input.actor,
      })
      return { ok: true as const, batch, settledPayoutIds: ids, replayed: false }
    })
  } catch (err) {
    if (err instanceof StaleSelection) return { ok: false, kind: "stale", stale: err.stale }
    // The partial unique index on payout_settlements fired: another request settled one of these first.
    if (isUniqueViolation(err)) return { ok: false, kind: "stale", stale: ids.map((id) => ({ payoutId: id, reason: "Already settled by another request", currentStatus: null, currentAmount: null })) }
    return { ok: false, kind: "error", error: err instanceof Error ? err.message : String(err) }
  }
}

export type OpeningBatchInput = {
  profileId: number
  payoutIds: number[]
  cutoffAt: Date
  actor: string
  label: string
  /** "initialization" for the one-time run, "late-import" for a pre-cutoff job first seen later. */
  source: "initialization" | "late-import"
  /** Real payment facts when they were ever recorded; all null means "unknown". */
  recorded?: { method?: string | null; paidOn?: string | null; paidAmount?: number | null; reference?: string | null }
}

/**
 * Settles payouts the owner declared already paid before the cutoff. The real transfer stays
 * unknown unless facts were recorded; the calculated total is stored separately and labelled.
 */
export async function recordOpeningBatch(input: OpeningBatchInput, tx?: Tx): Promise<{ batch: PaymentBatchRow; settledPayoutIds: number[] }> {
  const run = async (t: Tx | typeof db) => {
    const rows = await t.select().from(payouts).where(inArray(payouts.id, input.payoutIds)).for("update")
    const eligible = rows.filter((r) => r.profileId === input.profileId && (r.status === "ready" || r.status === "hold"))
    if (eligible.length === 0) throw new Error("No open payouts to settle")
    const total = selectionTotal(eligible.map((r) => ({ amount: round2(Number(r.totalPayout)) })))
    const now = new Date()
    const [batch] = await t
      .insert(paymentBatches)
      .values({
        profileId: input.profileId,
        kind: "opening",
        status: "recorded",
        method: input.recorded?.method ?? null,
        paidOn: input.recorded?.paidOn ?? null,
        paidAmount: input.recorded?.paidAmount != null ? input.recorded.paidAmount.toFixed(2) : null,
        calculatedTotal: total.toFixed(2),
        itemCount: eligible.length,
        reference: input.recorded?.reference ?? null,
        idempotencyKey: null,
        recordedAt: now,
        recordedBy: input.actor,
        details: { label: input.label, cutoffAt: input.cutoffAt.toISOString(), source: input.source, provisional: eligible.filter((r) => r.status === "hold").map((r) => ({ payoutId: r.id, holdReason: r.holdReason })) },
      })
      .returning()
    await t.insert(payoutSettlements).values(
      eligible.map((row) => ({
        batchId: batch.id,
        payoutId: row.id,
        profileId: row.profileId,
        jobUuid: row.jobUuid,
        amount: round2(Number(row.totalPayout)).toFixed(2),
        exactAmount: row.totalPayout,
        calcVersion: calcVersionOf(row),
        inputHash: row.inputHash,
        snapshot: snapshotOf(row),
        status: "settled",
        createdAt: now,
      })),
    )
    const ids = eligible.map((r) => r.id)
    await t
      .update(payouts)
      .set({ status: "paid", paidAt: input.cutoffAt, paidBy: `${input.actor} (opening balance)`, batchId: batch.id, settledKind: "opening", updatedAt: now })
      .where(inArray(payouts.id, ids))
    await audit(t, "opening:settle", `${input.label}: ${ids.length} payout${ids.length === 1 ? "" : "s"} (calculated $${total.toFixed(2)}) settled as previously paid through ${input.cutoffAt.toISOString()}`, {
      batchId: batch.id,
      profileId: input.profileId,
      payoutIds: ids,
      cutoffAt: input.cutoffAt.toISOString(),
      source: input.source,
      actor: input.actor,
    })
    return { batch, settledPayoutIds: ids }
  }
  return tx ? run(tx) : db.transaction(run)
}

export type ReverseBatchResult = { ok: true; payoutIds: number[]; jobUuids: string[] } | { ok: false; error: string }

/**
 * Undo / correction: the batch and its settlements are marked reversed (never deleted) and every
 * payout goes back to an open state with its fingerprint cleared, so the next evaluation from the
 * stored job snapshot decides whether it is due, on hold or pending again.
 */
export async function reverseBatch(batchId: number, actor: string, reason: string | null): Promise<ReverseBatchResult> {
  try {
    return await db.transaction(async (tx) => {
      const [batch] = await tx.select().from(paymentBatches).where(eq(paymentBatches.id, batchId)).for("update")
      if (!batch) throw new Error("Payment batch not found")
      if (batch.status === "reversed") throw new Error(`Batch #${batchId} was already reversed`)
      const items = await tx.select().from(payoutSettlements).where(and(eq(payoutSettlements.batchId, batchId), eq(payoutSettlements.status, "settled")))
      const now = new Date()
      await tx.update(payoutSettlements).set({ status: "reversed", reversedAt: now }).where(and(eq(payoutSettlements.batchId, batchId), eq(payoutSettlements.status, "settled")))
      const ids = items.map((i) => i.payoutId)
      if (ids.length) {
        await tx
          .update(payouts)
          .set({ status: "pending", holdReason: "Payment reversed; re-evaluating", paidAt: null, paidBy: null, batchId: null, settledKind: null, inputHash: null, updatedAt: now })
          .where(and(inArray(payouts.id, ids), eq(payouts.batchId, batchId)))
      }
      await tx.update(paymentBatches).set({ status: "reversed", reversedAt: now, reversedBy: actor, reversalReason: reason?.trim() || null }).where(eq(paymentBatches.id, batchId))
      await audit(tx, "batch:reverse", `Batch #${batchId} reversed (${ids.length} payout${ids.length === 1 ? "" : "s"}, $${Number(batch.calculatedTotal).toFixed(2)})${reason ? `: ${reason}` : ""}`, {
        batchId,
        profileId: batch.profileId,
        payoutIds: ids,
        kind: batch.kind,
        reason: reason ?? null,
        actor,
      })
      return { ok: true as const, payoutIds: ids, jobUuids: Array.from(new Set(items.map((i) => i.jobUuid))) }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function calcVersionOf(row: PayoutRow): string | null {
  const b = row.breakdown as { calcVersion?: unknown } | null
  return b && typeof b.calcVersion === "string" ? b.calcVersion : null
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code
  return code === "23505"
}

// --- History --------------------------------------------------------------------

export type BatchFilter = {
  profileId?: number | null
  /** Job number, customer, job UUID or note/reference. */
  search?: string
  /** Inclusive YYYY-MM-DD bounds on the effective paid date (falls back to the recording date when unknown). */
  from?: string | null
  to?: string | null
  kind?: "all" | "payment" | "opening"
  includeReversed?: boolean
  limit?: number
  ids?: number[]
}

export type BatchItem = PayoutSettlementRow & {
  job: { serialId: string | null; clientName: string | null; address: string | null; jobType: string | null; status: string | null; lastStatusUpdate: string | null } | null
  payoutStatus: string | null
  /** The payout was settled again in a later batch after this one was reversed. */
  resettledBatchId: number | null
}

export type BatchSummary = PaymentBatchRow & {
  profileName: string
  items: BatchItem[]
  /** Hold reasons carried into an opening batch, so a provisional calculation is never shown as verified. */
  provisional: Array<{ payoutId: number; holdReason: string | null }>
  label: string | null
  source: string | null
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, (c) => `\\${c}`)

export async function listBatches(filter: BatchFilter = {}): Promise<BatchSummary[]> {
  const conditions: SQL[] = []
  if (filter.ids) {
    if (filter.ids.length === 0) return []
    conditions.push(inArray(paymentBatches.id, filter.ids))
  }
  if (filter.profileId != null) conditions.push(eq(paymentBatches.profileId, filter.profileId))
  if (filter.kind && filter.kind !== "all") conditions.push(eq(paymentBatches.kind, filter.kind))
  if (!filter.includeReversed) conditions.push(eq(paymentBatches.status, "recorded"))
  const effectiveDate = sql<string>`coalesce(${paymentBatches.paidOn}, to_char(${paymentBatches.recordedAt} at time zone 'America/New_York', 'YYYY-MM-DD'))`
  if (filter.from) conditions.push(gte(effectiveDate, filter.from))
  if (filter.to) conditions.push(lte(effectiveDate, filter.to))
  const search = filter.search?.trim()
  if (search) {
    const like = `%${escapeLike(search)}%`
    const matchingBatches = db
      .select({ id: payoutSettlements.batchId })
      .from(payoutSettlements)
      .leftJoin(workizJobs, eq(payoutSettlements.jobUuid, workizJobs.uuid))
      .where(or(ilike(workizJobs.serialId, like), ilike(workizJobs.clientName, like), ilike(payoutSettlements.jobUuid, like)))
    conditions.push(or(inArray(paymentBatches.id, matchingBatches), ilike(paymentBatches.reference, like), sql`cast(${paymentBatches.id} as text) = ${search}`) as SQL)
  }

  const batches = await db
    .select({ batch: paymentBatches, profileName: technicianProfiles.name })
    .from(paymentBatches)
    .leftJoin(technicianProfiles, eq(paymentBatches.profileId, technicianProfiles.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(effectiveDate), desc(paymentBatches.recordedAt), desc(paymentBatches.id))
    .limit(filter.limit ?? 200)
  if (batches.length === 0) return []

  const batchIds = batches.map((b) => b.batch.id)
  const items = await db
    .select({
      item: payoutSettlements,
      payoutStatus: payouts.status,
      payoutBatchId: payouts.batchId,
      job: {
        serialId: workizJobs.serialId,
        clientName: workizJobs.clientName,
        address: workizJobs.address,
        jobType: workizJobs.jobType,
        status: workizJobs.status,
        lastStatusUpdate: sql<string | null>`${workizJobs.raw}->>'LastStatusUpdate'`,
      },
    })
    .from(payoutSettlements)
    .leftJoin(payouts, eq(payoutSettlements.payoutId, payouts.id))
    .leftJoin(workizJobs, eq(payoutSettlements.jobUuid, workizJobs.uuid))
    .where(inArray(payoutSettlements.batchId, batchIds))
    .orderBy(payoutSettlements.id)

  return batches.map(({ batch, profileName }) => {
    const details = (batch.details ?? {}) as { label?: string; source?: string; provisional?: Array<{ payoutId: number; holdReason: string | null }> }
    return {
      ...batch,
      profileName: profileName ?? "Unknown",
      items: items
        .filter((i) => i.item.batchId === batch.id)
        .map((i) => ({
          ...i.item,
          job: i.job?.serialId !== undefined ? i.job : null,
          payoutStatus: i.payoutStatus ?? null,
          resettledBatchId: i.item.status === "reversed" && i.payoutBatchId != null && i.payoutBatchId !== batch.id ? i.payoutBatchId : null,
        })),
      provisional: details.provisional ?? [],
      label: details.label ?? null,
      source: details.source ?? null,
    }
  })
}

export async function getBatch(id: number): Promise<BatchSummary | null> {
  const [batch] = await listBatches({ includeReversed: true, kind: "all", limit: 1, ids: [id] })
  return batch ?? null
}
