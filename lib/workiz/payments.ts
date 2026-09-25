import type { JobPaymentRow, NormalizedPayment, PaymentSource } from "@/lib/db/schema"

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
 *   - Workiz's *invoice* webhook payload carries `payments: [{ id, type, amount, tipAmount }]`
 *     (help-center article 39192462158993). Job webhooks do not.
 *
 * So the payment type can only reach the app through an invoice webhook or an admin
 * confirming what the Workiz Payments tab shows. Both are stored in `job_payments` and
 * merged into the job on every sync. Nothing here guesses a method.
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

export type DocumentKind = "invoice" | "estimate"

/**
 * Whether the `amount` on a Workiz payment record already contains its `tipAmount`.
 * Workiz's article shows `{ amount: 100, tipAmount: 10 }` without saying; the live account
 * has only tipless payments so far. Decided per event from the document's own totals:
 *   - sum(amount) == totalPrice − amountDue        → amounts EXCLUDE tips ("separate")
 *   - sum(amount) − sum(tip) == totalPrice − amountDue → amounts INCLUDE tips ("included")
 * Anything else (or no totals) is "unknown"; with a non-zero tip that holds the job for review
 * instead of guessing the tip in or out of the card-fee base.
 */
export type TipInclusion = "separate" | "included" | "unknown"

export function inferTipInclusion(payments: ReadonlyArray<Pick<ExternalPaymentInput, "amount" | "tipAmount">>, totalPrice: number | null, amountDue: number | null): TipInclusion {
  const tips = payments.reduce((s, p) => s + p.tipAmount, 0)
  if (tips <= 0) return "separate"
  if (totalPrice === null || amountDue === null) return "unknown"
  const collected = round2(totalPrice - amountDue)
  const gross = round2(payments.reduce((s, p) => s + p.amount, 0))
  if (Math.abs(gross - collected) <= 0.011) return "separate"
  if (Math.abs(round2(gross - tips) - collected) <= 0.011) return "included"
  return "unknown"
}

export type PaymentMethodClass = {
  /** Display label: Cash, Check, Zelle, Venmo, Cash App, Bank transfer, Card, Financing. */
  label: string
  isCard: boolean
  /** False when the text is not a method we can place on the card / non-card side. */
  known: boolean
}

/**
 * Methods Workiz lets a user log: the `addPayment` enum (cash / credit / check), Workiz Pay
 * card + ACH, and the offline list from "Collecting cash and other offline payments"
 * (Cash, Check, Credit (offline), Bank transfer, Cash App, Venmo, Zelle). Order matters:
 * "Cash App" must win over "Cash". Anything else is unknown and holds the payout.
 */
const KNOWN_METHODS: ReadonlyArray<readonly [RegExp, string, boolean]> = [
  [/credit|card|visa|master|amex|discover|stripe|workiz\s*pay|^cc$/i, "Card", true],
  [/cash\s*app/i, "Cash App", false],
  [/check|cheque/i, "Check", false],
  [/cash/i, "Cash", false],
  [/zelle/i, "Zelle", false],
  [/venmo/i, "Venmo", false],
  [/ach|bank|wire/i, "Bank transfer", false],
]

/** Methods an admin may confirm by hand; mirrors what the Workiz Payments tab can show. */
export const MANUAL_PAYMENT_METHODS = ["Cash", "Check", "Zelle", "Venmo", "Cash App", "Bank transfer", "Card"] as const
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number]

export function classifyPaymentMethod(method: string | null | undefined, cardKeywords: readonly string[] = []): PaymentMethodClass {
  const m = (method ?? "").trim()
  if (!m) return { label: "Unknown method", isCard: false, known: false }
  const lower = m.toLowerCase()
  if (cardKeywords.some((k) => k.trim() && lower.includes(k.trim().toLowerCase()))) return { label: "Card", isCard: true, known: true }
  for (const [re, label, isCard] of KNOWN_METHODS) if (re.test(m)) return { label, isCard, known: true }
  return { label: m.charAt(0).toUpperCase() + m.slice(1), isCard: false, known: false }
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
 * Pull the payment records out of an `invoice_*` or `estimate_*` webhook `data` object. Returns
 * null when the payload has no `payments` array at all (so "not included" stays distinct from
 * "empty"). Estimates are how deposits reach us: a client paying a deposit online pays it on the
 * estimate, weeks before the job is done, and that record never appears on the job payload.
 */
export function extractDocumentPayments(data: Record<string, unknown> | null | undefined, receivedAt?: string | null, kind: DocumentKind = "invoice"): InvoiceWebhookPayments | null {
  if (!data) return null
  const list = pick(data, "payments", "Payments")
  if (!Array.isArray(list)) return null
  const documentId = str(pick(data, "id", "invoiceId", "invoice_id", "estimateId", "estimate_id"))
  const source: PaymentSource = kind === "estimate" ? "estimate-webhook" : "invoice-webhook"
  const payments: ExternalPaymentInput[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const r = entry as Record<string, unknown>
    const amount = round2(num(pick(r, "amount", "Amount", "total", "Total")))
    if (amount <= 0) continue
    const explicitDate = str(pick(r, "date", "Date", "paidAt", "paid_at", "createdAt", "created_at", "created", "timestamp"))
    payments.push({
      externalId: str(pick(r, "id", "Id", "ID", "paymentId", "payment_id")),
      source,
      method: str(pick(r, "type", "Type", "method", "Method", "paymentMethod", "payment_method")) ?? "",
      amount,
      tipAmount: round2(Math.max(0, num(pick(r, "tipAmount", "tip_amount", "tip", "Tip")))),
      paidAt: explicitDate ?? receivedAt ?? null,
      paidAtFromPayload: explicitDate !== null,
      invoiceId: documentId,
      reference: str(pick(r, "reference", "Reference", "confirmation")),
      recordedBy: null,
      raw: r,
    })
  }
  // Invoices report `totalPrice`; estimates report `total`. Both report `amountDue` when they know it.
  const total = pick(data, "totalPrice", "total_price", "total", "Total")
  const due = pick(data, "amountDue", "amount_due")
  const invoiceTotal = total === undefined ? null : round2(num(total))
  const amountDue = due === undefined ? null : round2(num(due))
  return {
    kind,
    invoiceId: documentId,
    jobId: str(pick(data, "jobId", "job_id", "jobID")),
    invoiceTotal,
    amountDue,
    tipInclusion: inferTipInclusion(payments, invoiceTotal, amountDue),
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

export function externalRowsToPayments(rows: ReadonlyArray<Pick<JobPaymentRow, "id" | "externalId" | "source" | "method" | "amount" | "tipAmount" | "paidAt" | "recordedBy"> & Partial<Pick<JobPaymentRow, "raw">>>, cardKeywords: readonly string[]): NormalizedPayment[] {
  const out: NormalizedPayment[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const amount = round2(num(row.amount))
    if (amount <= 0) continue
    const id = row.externalId ?? `${row.source}:${row.id}`
    if (seen.has(id)) continue
    seen.add(id)
    const cls = classifyPaymentMethod(row.method, cardKeywords)
    const source = row.source as PaymentSource
    const date = row.paidAt ? row.paidAt.toISOString() : null
    const base = { id, method: row.method, isCard: cls.isCard, methodKnown: cls.known, source, date, recordedBy: row.recordedBy ?? null }
    const tip = round2(num(row.tipAmount))
    if (tip <= 0) {
      out.push({ ...base, amount, isTip: false })
      continue
    }
    const inclusion = tipInclusionOfRow(row.raw)
    // "included": the amount already contains the tip, so the service part is the remainder
    //             (a payment that was entirely tip leaves no service row).
    // "separate": amount is the service payment and the tip is on top of it.
    // "unknown": kept as separate (the smaller card-fee base) but flagged so the payout is held.
    const service = inclusion === "included" ? round2(Math.max(0, amount - tip)) : amount
    if (service > 0) out.push({ ...base, amount: service, isTip: false, tipAmbiguous: inclusion === "unknown" || undefined })
    out.push({ ...base, id: `${id}:tip`, amount: tip, isTip: true, tipAmbiguous: inclusion === "unknown" || undefined })
  }
  return out
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
    const method = (e.method ?? "").trim()
    if (!MANUAL_PAYMENT_METHODS.includes(method as ManualPaymentMethod)) return { ok: false, error: `"${method || "blank"}" is not a payment method Workiz records; choose ${MANUAL_PAYMENT_METHODS.join(", ")}` }
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
