import { and, eq, sql } from "drizzle-orm"
import { db, type Database } from "@/lib/db"
import { jobPayments, syncEvents } from "@/lib/db/schema"
import { lockPayoutJob } from "@/lib/payout/lock"
import type { WorkizSettings } from "@/lib/settings"
import { paymentRevision, paymentRevisionDecision } from "./payment-revisions"
import { TIP_INCLUSION_RAW_KEY, externalRowsToPayments, tipInclusionOfRow, type ExternalPaymentInput, type TipInclusion } from "./payments"
import { parseWorkizDate } from "./time"

export async function paymentEvidence(uuid: string, settings: WorkizSettings, database: Database = db) {
  const rows = await database.select().from(jobPayments).where(eq(jobPayments.jobUuid, uuid)).orderBy(jobPayments.id)
  const provider = rows.filter((p) => p.source !== "manual")
  // A full manual transcription is a replacement evidence set, not additional customer money.
  const selected = provider.length ? provider : rows
  const issues = selected.flatMap((p) => [
    ...(p.reviewReason ? [p.reviewReason] : []),
    ...(p.paymentState !== "active" ? [`Payment adjustment requires review: ${p.externalId ?? p.id} is ${p.paymentState}; verify refund/void and remaining payments in Workiz`] : []),
  ])
  return { payments: externalRowsToPayments(selected.filter((p) => p.paymentState === "active"), settings.cardMethodKeywords), issues }
}

export async function persistPayments(uuid: string, inputs: ExternalPaymentInput[], options: { tipInclusion?: TipInclusion; timezone?: string; database?: Database } = {}) {
  const apply = async (tx: Database) => {
    await lockPayoutJob(tx, uuid)
    const result = { stored: 0, skipped: 0, stale: 0, conflicts: 0 }
    for (const p of inputs) {
      if (!p.externalId) throw new Error("Payment has no stable Workiz ID; event retained, payout cannot be released")
      if (!Number.isFinite(p.amount) || !Number.isFinite(p.tipAmount) || p.tipAmount < 0) throw new Error(`Invalid amount on Workiz payment ${p.externalId}`)
      const inclusion = options.tipInclusion ?? (p.tipAmount > 0 ? "unknown" : "separate")
      const timeZone = options.timezone ?? "America/New_York"
      const sourceUpdatedAt = parseWorkizDate(p.sourceUpdatedAt ?? null, timeZone)
      const paidAt = p.paidAtFromPayload ? parseWorkizDate(p.paidAt, timeZone) : null
      const [previous] = await tx.select().from(jobPayments).where(eq(jobPayments.externalId, p.externalId)).limit(1)
      if (previous && previous.jobUuid !== uuid) throw new Error(`Payment ${p.externalId} is already associated with a different job; mapping requires review`)
      const revision = paymentRevision(p, inclusion, sourceUpdatedAt)
      const decision = previous ? paymentRevisionDecision({ amount: Number(previous.amount), tipAmount: Number(previous.tipAmount), method: previous.method, paymentState: previous.paymentState, sourceUpdatedAt: previous.sourceUpdatedAt, tipInclusion: tipInclusionOfRow(previous.raw) }, revision) : "replace"
      if (decision === "stale") { result.stale++; continue }
      if (decision === "conflict") {
        await tx.update(jobPayments).set({ reviewReason: `Payment revision conflict: ${p.externalId} changed without a newer provider timestamp`, updatedAt: new Date() }).where(eq(jobPayments.id, previous!.id))
        result.conflicts++
        continue
      }
      const values = {
        jobUuid: uuid, externalId: p.externalId, source: p.source, method: p.method,
        amount: p.amount.toFixed(2), tipAmount: p.tipAmount.toFixed(2),
        paidAt: paidAt ?? previous?.paidAt ?? null,
        paidAtFromPayload: Boolean(paidAt) || previous?.paidAtFromPayload || false,
        sourceUpdatedAt: sourceUpdatedAt ?? previous?.sourceUpdatedAt ?? null,
        paymentState: p.paymentState ?? "active",
        reviewReason: decision === "same" ? previous?.reviewReason ?? null : null,
        invoiceId: p.invoiceId ?? previous?.invoiceId ?? null, reference: p.reference ?? previous?.reference ?? null,
        recordedBy: p.recordedBy, raw: { ...(p.raw as object ?? {}), [TIP_INCLUSION_RAW_KEY]: inclusion }, updatedAt: new Date(),
      }
      if (previous) await tx.update(jobPayments).set(values).where(eq(jobPayments.id, previous.id))
      else await tx.insert(jobPayments).values(values)
      result.stored++
    }
    await tx.insert(syncEvents).values({ kind: "payments:merge", jobUuid: uuid, ok: result.conflicts === 0, summary: `Payment records stored ${result.stored}, stale ${result.stale}, conflicts ${result.conflicts}`, details: result })
    return result
  }
  return options.database ? apply(options.database) : db.transaction(apply)
}
