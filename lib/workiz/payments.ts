import type { JobPaymentRow, NormalizedPayment, PaymentSource } from "@/lib/db/schema"
import { MANUAL_PAYMENT_METHODS, classifyPaymentMethod, paymentOutcome, resolvePaymentMethod, type ManualPaymentMethod } from "./payment-method"

export { CREDIT_CARD_LABEL, MANUAL_PAYMENT_METHODS, classifyPaymentMethod, manualMethodFor, normalizeMethodText, paymentOutcome, resolvePaymentMethod } from "./payment-method"
export type { ManualPaymentMethod, PaymentMethodClass, PaymentOutcome } from "./payment-method"

/**
 * Payment records and how the customer paid, independent of the job payload.
 *
 * Verified 2026-09-21 against the live API and Workiz's published docs:
 *   - `job/get` and `job/all` return `JobTotalPrice` and `JobAmountDue` only. There is no
 *     payments array, no method field, and no read endpoint for payments (`job/payments`,
 *     `payment/all`, `invoice/all` … all answer "Invalid end point"). `job/addPayment` is
 *     the only payment endpoint and it writes.
 *   - The undocumented `invoice/get/{id}` exists but needs an invoice id we cannot list, and
 *     payments logged on the job's Payments tab (cash/check/Zelle, the common case here)
 *     belong to no invoice at all.
 *
 * Verified 2026-11-12 against stored live webhook events: invoice, estimate AND job webhooks
 * carry `payments: [{ id, type, amount, tipAmount, status, date, … }]` next to the document's
 * own `subTotal`, `tipAmount`, `totalPrice` and `amountDue`. The same payment keeps its
 * "PAY-…" id in every event that repeats it.
 *
 * So the payment type reaches the app through a webhook or an admin confirming what the
 * Workiz Payments tab shows. Both are stored in `job_payments` and merged into the job on
 * every sync. Nothing here guesses a method.
 */

export type ExternalPaymentInput = {
  externalId: string | null
  source: PaymentSource
  method: string
  amount: number
  tipAmount: number
  /** ISO or Workiz wall-clock string; null when the source did not include one. */
  paidAt: string | null
  /**
   * True when `paidAt` is the payment's own date from the payload. False when it is only the
   * time the event arrived (Workiz's live invoice payloads carry no per-payment date), in which
   * case a stored earlier date must be kept on re-delivery.
   */
  paidAtFromPayload: boolean
  /** Invoice ("IV-…") or estimate ("ES-…") the payment was reported on. */
  invoiceId: string | null
  reference: string | null
  recordedBy: string | null
  raw?: unknown
}

export type DocumentKind = "invoice" | "estimate" | "job"

const DOCUMENT_SOURCE: Record<DocumentKind, PaymentSource> = { invoice: "invoice-webhook", estimate: "estimate-webhook", job: "job-webhook" }

/** The document's own money fields, when the event carried them (live events do). */
export type DocumentTotals = {
  subTotal?: number | null
  discountAmount?: number | null
  taxAmount?: number | null
  serviceFeeAmount?: number | null
  /** The document-level tip Workiz reports beside `totalPrice`. */
  tipAmount?: number | null
}

const MONEY_MATCH = 0.011
const near = (a: number, b: number) => Math.abs(a - b) <= MONEY_MATCH

/**
 * Whether Workiz's `totalPrice` already contains the tip. Live events (#924916: subTotal
 * 1464.49 + tip 153.77 = totalPrice 1618.26) show that it does; this checks the event's own
 * arithmetic instead of assuming it. Null when the event did not carry the fields to tell.
 */
function totalContainsTip(totalPrice: number, doc: DocumentTotals): boolean | null {
  if (doc.subTotal === null || doc.subTotal === undefined || doc.tipAmount === null || doc.tipAmount === undefined) return null
  const extras = (doc.taxAmount ?? 0) + (doc.serviceFeeAmount ?? 0)
  // `subTotal` is before discounts on jobs; accept either reading of it.
  const bases = [round2(doc.subTotal + extras), round2(doc.subTotal - (doc.discountAmount ?? 0) + extras)]
  if (doc.tipAmount > 0 && bases.some((base) => near(totalPrice, round2(base + (doc.tipAmount as number))))) return true
  if (bases.some((base) => near(totalPrice, base))) return false
  return null
}

/**
 * Whether the `amount` on a Workiz payment record already contains its `tipAmount`, decided per
 * event from the document's own totals (`collected` = totalPrice − amountDue):
 *   - the total contains the tip (live events):
 *       sum(amount) == collected              → amounts INCLUDE tips ("included")
 *       sum(amount) + sum(tip) == collected   → amounts EXCLUDE tips ("separate")
 *   - the total does not contain the tip, or the event cannot say (older events):
 *       sum(amount) == collected              → amounts EXCLUDE tips ("separate")
 *       sum(amount) − sum(tip) == collected   → amounts INCLUDE tips ("included")
 * Anything else (or no totals) is "unknown"; with a non-zero tip that holds the job for review
 * instead of guessing the tip in or out of the card-fee base.
 */
export type TipInclusion = "separate" | "included" | "unknown"

export function inferTipInclusion(payments: ReadonlyArray<Pick<ExternalPaymentInput, "amount" | "tipAmount">>, totalPrice: number | null, amountDue: number | null, doc: DocumentTotals = {}): TipInclusion {
  const tips = round2(payments.reduce((s, p) => s + p.tipAmount, 0))
  if (tips <= 0) return "separate"
  if (totalPrice === null || amountDue === null) return "unknown"
  const collected = round2(totalPrice - amountDue)
  const gross = round2(payments.reduce((s, p) => s + p.amount, 0))
  if (totalContainsTip(totalPrice, doc) === true) {
    if (near(gross, collected)) return "included"
    if (near(round2(gross + tips), collected)) return "separate"
    return "unknown"
  }
  if (near(gross, collected)) return "separate"
  if (near(round2(gross - tips), collected)) return "included"
  return "unknown"
}

const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[^0-9.eE-]/g, ""))
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length ? s : null
}
const pick = (obj: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k]
  return undefined
}
const round2 = (n: number) => Math.round(n * 100) / 100

export type InvoiceWebhookPayments = {
  kind: DocumentKind
  /** Invoice or estimate id ("IV-…" / "ES-…"). */
  invoiceId: string | null
  /** Workiz internal job id ("JOB-…"); resolvable only through the learned id map (workiz_job_ids). */
  jobId: string | null
  invoiceTotal: number | null
  amountDue: number | null
  /** Whether each payment's `amount` already contains its tip, decided from the document totals. */
  tipInclusion: TipInclusion
  payments: ExternalPaymentInput[]
}

/** Alias kept for readers of the invoice-only name; estimates carry the same `payments[]`. */
export type DocumentWebhookPayments = InvoiceWebhookPayments

/**
 * Pull the payment records out of a webhook `data` object: an invoice, an estimate, or the job
 * itself (live `job_status_*` events repeat the job's payments). Returns null when the payload
 * has no `payments` array at all (so "not included" stays distinct from "empty"). Estimates are
 * how deposits reach us: a client paying a deposit online pays it on the estimate, weeks before
 * the job is done.
 *
 * Every record is kept with the method exactly as Workiz sent it; failed and refunded records
 * are kept too (for troubleshooting) and left out when the job is calculated.
 */
export function extractDocumentPayments(data: Record<string, unknown> | null | undefined, receivedAt?: string | null, kind: DocumentKind = "invoice"): InvoiceWebhookPayments | null {
  if (!data) return null
  const list = pick(data, "payments", "Payments")
  if (!Array.isArray(list)) return null
  // A job's own id is not a document id; only invoices and estimates have one worth keeping.
  const documentId = kind === "job" ? null : str(pick(data, "id", "invoiceId", "invoice_id", "estimateId", "estimate_id"))
  const source = DOCUMENT_SOURCE[kind]
  const payments: ExternalPaymentInput[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const r = entry as Record<string, unknown>
    const amount = round2(num(pick(r, "amount", "Amount", "total", "Total")))
    if (amount <= 0) continue
    const explicitDate = str(pick(r, "date", "Date", "paidAt", "paid_at", "createdAt", "created_at", "created", "timestamp"))
    const tipAmount = round2(Math.max(0, num(pick(r, "tipAmount", "tip_amount", "tip", "Tip"))))
    const method = resolvePaymentMethod(r).original
    const id = str(pick(r, "id", "Id", "ID", "paymentId", "payment_id"))
    payments.push({
      // Without Workiz's id, a record that states its own date is still the same record every
      // time it is repeated; one with neither cannot be told apart from a second payment.
      externalId: id ?? (explicitDate ? `no-id:${explicitDate}|${amount.toFixed(2)}|${tipAmount.toFixed(2)}` : null),
      source,
      method,
      amount,
      tipAmount,
      paidAt: explicitDate ?? receivedAt ?? null,
      paidAtFromPayload: explicitDate !== null,
      invoiceId: documentId,
      reference: str(pick(r, "reference", "Reference", "confirmation", "confirmationCode")),
      recordedBy: null,
      raw: r,
    })
  }
  // Invoices and jobs report `totalPrice`; estimates report `total`. All report `amountDue` when they know it.
  const optional = (...keys: string[]) => {
    const value = pick(data, ...keys)
    return value === undefined ? null : round2(num(value))
  }
  const invoiceTotal = optional("totalPrice", "total_price", "total", "Total")
  const amountDue = optional("amountDue", "amount_due")
  // Refunded or failed records are not money collected, so they take no part in the totals check.
  const received = payments.filter((p) => paymentOutcome(p.raw as Record<string, unknown>) === "received")
  return {
    kind,
    invoiceId: documentId,
    jobId: kind === "job" ? null : str(pick(data, "jobId", "job_id", "jobID")),
    invoiceTotal,
    amountDue,
    tipInclusion: inferTipInclusion(received, invoiceTotal, amountDue, {
      subTotal: optional("subTotal", "sub_total"),
      discountAmount: optional("discountAmount", "discount_amount"),
      taxAmount: optional("taxAmount", "tax_amount"),
      serviceFeeAmount: optional("serviceFeeAmount", "service_fee_amount"),
      tipAmount: optional("tipAmount", "tip_amount"),
    }),
    payments,
  }
}

/** Invoice-only entry point kept for existing callers and tests. */
export function extractInvoiceWebhookPayments(data: Record<string, unknown> | null | undefined, receivedAt?: string | null): InvoiceWebhookPayments | null {
  return extractDocumentPayments(data, receivedAt, "invoice")
}

/**
 * Turn stored `job_payments` rows into the payment shape the normalizer already understands.
 * A tip attached to a payment is split off exactly as the job-payload path does.
 */
/** Key under which the per-event tip-inclusion verdict is kept inside a stored row's `raw`. */
export const TIP_INCLUSION_RAW_KEY = "_tipInclusion"

export function tipInclusionOfRow(raw: unknown): TipInclusion {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[TIP_INCLUSION_RAW_KEY] : undefined
  return v === "included" || v === "unknown" ? v : "separate"
}

export type StoredPaymentRow = Pick<JobPaymentRow, "id" | "externalId" | "source" | "method" | "amount" | "tipAmount" | "paidAt" | "recordedBy"> & Partial<Pick<JobPaymentRow, "raw" | "paidAtFromPayload">>

/** A Workiz record for money that came in and went back; never counted as a payment. */
export type ReversedPayment = { amount: number; method: string; status: string | null }

export type PaymentEvidence = {
  /** The payments the job is calculated from: each one counted once. */
  payments: NormalizedPayment[]
  reversed: ReversedPayment[]
  /** Workiz records left out because an admin's confirmation already covers the same money. */
  supersededByConfirmation: number
}

type Candidate = { row: StoredPaymentRow; id: string; amount: number; tip: number; inclusion: TipInclusion }

/** What the customer handed over in this transaction, tip included, as the Payments tab shows it. */
const chargedAmount = (c: Candidate) => (c.inclusion === "separate" ? round2(c.amount + c.tip) : c.amount)

/**
 * Decide which stored records are the job's payments.
 *   1. A failed charge is not a payment; a refunded or charged-back one is reported, not counted.
 *   2. One Workiz payment is one record however many events repeated it: the same id, or the
 *      same amount, tip and Workiz timestamp under a different id.
 *   3. An admin's confirmation is a transcription of the same Payments tab. When it accounts
 *      for at least as much money as the Workiz records, those records describe money already
 *      counted; otherwise only the Workiz records it matches to the cent are left out.
 */
export function selectPaymentEvidence(rows: ReadonlyArray<StoredPaymentRow>, cardKeywords: readonly string[]): PaymentEvidence {
  const reversed: ReversedPayment[] = []
  const manual: Candidate[] = []
  let workiz: Candidate[] = []
  const seenIds = new Set<string>()
  const seenTransactions = new Set<string>()

  for (const row of rows) {
    const amount = round2(num(row.amount))
    if (amount <= 0) continue
    const isManual = row.source === "manual"
    const record = row.raw && typeof row.raw === "object" ? (row.raw as Record<string, unknown>) : null
    if (!isManual) {
      const outcome = paymentOutcome(record)
      if (outcome === "failed") continue
      if (outcome === "reversed") {
        reversed.push({ amount, method: row.method, status: str(record?.status) })
        continue
      }
    }
    const id = row.externalId ?? `${row.source}:${row.id}`
    if (seenIds.has(id)) continue
    seenIds.add(id)
    const tip = round2(num(row.tipAmount))
    if (!isManual && row.paidAtFromPayload && row.paidAt) {
      const transaction = `${row.paidAt.toISOString()}|${amount.toFixed(2)}|${tip.toFixed(2)}`
      if (seenTransactions.has(transaction)) continue
      seenTransactions.add(transaction)
    }
    const candidate: Candidate = { row, id, amount, tip, inclusion: tip > 0 ? tipInclusionOfRow(row.raw) : "separate" }
    if (isManual) manual.push(candidate)
    else workiz.push(candidate)
  }

  const reported = workiz.length
  if (manual.length && workiz.length) {
    const confirmed = round2(manual.reduce((s, c) => s + chargedAmount(c), 0))
    const fromWorkiz = round2(workiz.reduce((s, c) => s + chargedAmount(c), 0))
    if (confirmed + 0.05 >= fromWorkiz) {
      workiz = []
    } else {
      const unmatched = [...workiz]
      for (const entry of manual) {
        const index = unmatched.findIndex((c) => Math.abs(chargedAmount(c) - chargedAmount(entry)) <= 0.005)
        if (index >= 0) unmatched.splice(index, 1)
      }
      workiz = unmatched
    }
  }

  const payments: NormalizedPayment[] = []
  const ordered = [...workiz, ...manual].sort((a, b) => (a.row.paidAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.row.paidAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.row.id - b.row.id)
  for (const { row, id, amount, tip, inclusion } of ordered) {
    const cls = classifyPaymentMethod(row.method, cardKeywords)
    const base = {
      id,
      // `method` stays exactly what Workiz (or the admin) recorded; `methodLabel` is how it was read.
      method: row.method,
      methodLabel: cls.label,
      isCard: cls.isCard,
      methodKnown: cls.known,
      source: row.source as PaymentSource,
      date: row.paidAt ? row.paidAt.toISOString() : null,
      recordedBy: row.recordedBy ?? null,
    }
    if (tip <= 0) {
      payments.push({ ...base, amount, isTip: false })
      continue
    }
    // "included": the amount already contains the tip, so the service part is the remainder
    //             (a payment that was entirely tip leaves no service row).
    // "separate": amount is the service payment and the tip is on top of it.
    // "unknown": kept as separate (the smaller card-fee base) but flagged so the payout is held.
    const service = inclusion === "included" ? round2(Math.max(0, amount - tip)) : amount
    if (service > 0) payments.push({ ...base, amount: service, isTip: false, tipAmbiguous: inclusion === "unknown" || undefined })
    payments.push({ ...base, id: `${id}:tip`, amount: tip, isTip: true, tipAmbiguous: inclusion === "unknown" || undefined })
  }
  return { payments, reversed, supersededByConfirmation: reported - workiz.length }
}

export function externalRowsToPayments(rows: ReadonlyArray<StoredPaymentRow>, cardKeywords: readonly string[]): NormalizedPayment[] {
  return selectPaymentEvidence(rows, cardKeywords).payments
}

/**
 * Combine payments from the job payload with externally sourced ones. The same Workiz
 * payment id seen through two channels is one payment; records without ids are kept.
 */
export function mergePayments(primary: NormalizedPayment[], extra: NormalizedPayment[]): NormalizedPayment[] {
  if (extra.length === 0) return primary
  const seen = new Set(primary.map((p) => p.id).filter((x): x is string => Boolean(x)))
  const out = [...primary]
  for (const p of extra) {
    if (p.id && seen.has(p.id)) continue
    if (p.id) seen.add(p.id)
    out.push(p)
  }
  return out
}

export type ManualPaymentEntry = {
  method: string
  /** The charge as Workiz shows it on the Payments tab — tip included. */
  amount: number
  /** The part of `amount` that was a tip (Workiz's Tip field), 0 or omitted when none. */
  tipAmount?: number
  paidAt: string | null
  reference?: string | null
}

/**
 * Validate what an admin typed from the Workiz Payments tab. The entries must add up to the
 * Workiz invoice total: the admin is transcribing Workiz, not deciding how much was paid. A tip
 * is part of the payment it rode on (Workiz folds it into that charge and into the job total).
 */
export function validateManualPayments(entries: ManualPaymentEntry[], invoiceTotal: number | null): { ok: true; entries: ManualPaymentEntry[] } | { ok: false; error: string } {
  if (entries.length === 0) return { ok: false, error: "Add at least one payment" }
  const cleaned: ManualPaymentEntry[] = []
  for (const e of entries) {
    const typed = (e.method ?? "").trim()
    // "Charge", "Credit" and the older "Card" option are all stored as Credit Card.
    const recognised = classifyPaymentMethod(typed)
    if (!recognised.known || !MANUAL_PAYMENT_METHODS.includes(recognised.label as ManualPaymentMethod)) return { ok: false, error: `"${typed || "blank"}" is not a payment method Workiz records; choose ${MANUAL_PAYMENT_METHODS.join(", ")}` }
    const method = recognised.label
    const amount = round2(num(e.amount))
    if (!(amount > 0)) return { ok: false, error: "Each payment amount must be greater than zero" }
    const tipAmount = round2(num(e.tipAmount ?? 0))
    if (tipAmount < 0) return { ok: false, error: "A tip cannot be negative" }
    if (tipAmount > amount + 0.005) return { ok: false, error: `The $${tipAmount.toFixed(2)} tip is larger than the $${amount.toFixed(2)} payment it is part of; enter the payment amount as Workiz shows it, tip included` }
    let paidAt: string | null = null
    if (e.paidAt) {
      const d = new Date(e.paidAt)
      if (Number.isNaN(d.getTime())) return { ok: false, error: "Payment date is not a valid date" }
      paidAt = d.toISOString()
    }
    cleaned.push({ method, amount, tipAmount, paidAt, reference: str(e.reference) })
  }
  if (invoiceTotal !== null && invoiceTotal > 0) {
    const sum = round2(cleaned.reduce((s, e) => s + e.amount, 0))
    if (Math.abs(sum - invoiceTotal) > 0.05) {
      return { ok: false, error: `Payments total $${sum.toFixed(2)} but the Workiz invoice total is $${invoiceTotal.toFixed(2)}; enter every payment shown on the Workiz Payments tab` }
    }
  }
  return { ok: true, entries: cleaned }
}

export type PaymentEvidenceState =
  /** Individual payment records exist (job payload, invoice webhook or admin confirmation). */
  | "records"
  /** Workiz gave a balance but no records: paid status is known, the method is not. */
  | "unavailable"
  /** Neither records nor a balance. */
  | "none"

export function paymentEvidenceState(payments: ReadonlyArray<NormalizedPayment> | null | undefined, amountDue: number | null | undefined): PaymentEvidenceState {
  if (payments && payments.length > 0) return "records"
  if (amountDue !== null && amountDue !== undefined && Number.isFinite(amountDue)) return "unavailable"
  return "none"
}
