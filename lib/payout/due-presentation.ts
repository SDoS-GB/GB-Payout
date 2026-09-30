import type { NormalizedPayment, PaymentSource } from "@/lib/db/schema"
import { paymentMethodLabel } from "./presentation"

/**
 * Pure helpers for the Due page's per-job summary. They only describe stored data; no payout
 * arithmetic happens here.
 */

export type CustomerPaymentLine = {
  key: string
  /** "Deposit" / "Final" for the first and last of several; "Payment 2" for the ones between; "Payment" when there is one. */
  label: string
  method: string
  isCard: boolean
  methodKnown: boolean
  /** What the customer handed over in this transaction, tip included. */
  amount: number
  /** The part of `amount` that was a tip (0 when none was recorded). */
  tipAmount: number
  /** Recorded payment time; null when Workiz or the admin gave none. Never substituted. */
  date: string | null
  source: PaymentSource | undefined
  tipOnly: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Stored payments keep a card payment and the tip it carried as two records that share an id
 * (manual rows use `<id>` and `<id>:tip`). Fold them back into the transactions the customer
 * actually made, oldest first, and label deposit and final payments when there are several.
 */
export function groupCustomerPayments(payments: NormalizedPayment[] | null | undefined): CustomerPaymentLine[] {
  const groups = new Map<string, CustomerPaymentLine>()
  ;(payments ?? []).forEach((p, index) => {
    const baseId = p.id ? p.id.replace(/:tip$/, "") : null
    const key = baseId ? `id:${baseId}` : `idx:${index}`
    const existing = groups.get(key)
    if (existing) {
      existing.amount = round2(existing.amount + p.amount)
      if (p.isTip) existing.tipAmount = round2(existing.tipAmount + p.amount)
      else existing.tipOnly = false
      if (!existing.date && p.date) existing.date = p.date
      if (existing.methodKnown && p.methodKnown === false) existing.methodKnown = false
      return
    }
    groups.set(key, {
      key,
      label: "Payment",
      method: p.method,
      isCard: p.isCard,
      methodKnown: p.methodKnown !== false,
      amount: round2(p.amount),
      tipAmount: p.isTip ? round2(p.amount) : 0,
      date: p.date ?? null,
      source: p.source,
      tipOnly: p.isTip,
    })
  })

  const lines = Array.from(groups.values())
  // Oldest first; undated records keep their stored order after the dated ones.
  lines.sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date)
    if (a.date) return -1
    if (b.date) return 1
    return 0
  })
  if (lines.length >= 2) {
    lines.forEach((l, i) => {
      l.label = i === 0 ? "Deposit" : i === lines.length - 1 ? "Final" : `Payment ${i + 1}`
    })
  }
  return lines.map((l) => (l.tipOnly ? { ...l, label: `${l.label} (tip only)` } : l))
}

export function customerPaymentMethod(line: Pick<CustomerPaymentLine, "method" | "isCard">): string {
  return paymentMethodLabel(line.method, line.isCard)
}

export type JobMoneyInput = {
  jobTotal: string | number | null
  taxAmount: string | number | null
  discountAmount: string | number | null
  colorSealTotal: string | number | null
  cardTipAmount: string | number | null
  nonCardTipAmount: string | number | null
  /** Workiz's own JobTotalPrice, which folds in tips and any tax. */
  invoiceTotal: number | null
}

export type JobMoneySummary = {
  /** The figure labelled "Job total": Workiz's total when it was saved, else services + tax. */
  jobTotal: number
  basis: "workiz-total" | "services-plus-tax"
  includesTip: boolean
  includesTax: boolean
  servicesAfterDiscount: number
  /** Color-sealing part of the services figure, after its share of discounts. */
  colorSealAfterDiscount: number
  discount: number
  /** Total tip the customer left, card and non-card together. */
  tip: number
  tax: number
}

const num = (v: string | number | null | undefined) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function jobMoneySummary(job: JobMoneyInput): JobMoneySummary {
  const services = round2(num(job.jobTotal))
  const tax = round2(num(job.taxAmount))
  const tip = round2(num(job.cardTipAmount) + num(job.nonCardTipAmount))
  const workizTotal = job.invoiceTotal != null && Number.isFinite(job.invoiceTotal) && job.invoiceTotal > 0 ? round2(job.invoiceTotal) : null
  const jobTotal = workizTotal ?? round2(services + tax)
  return {
    jobTotal,
    basis: workizTotal !== null ? "workiz-total" : "services-plus-tax",
    includesTip: workizTotal !== null && tip > 0,
    includesTax: tax > 0,
    servicesAfterDiscount: services,
    colorSealAfterDiscount: round2(num(job.colorSealTotal)),
    discount: round2(num(job.discountAmount)),
    tip,
    tax,
  }
}

export type PayoutMathInput = {
  /** Stored payout row fields (strings from numeric columns are fine). */
  jobTotal: string | number
  colorSealTotal: string | number
  nonColorRate: string | number
  colorRate: string | number
  tipShare: string | number
  nonColorPayout: string | number
  colorPayout: string | number
  tipPayout: string | number
  totalPayout: string | number
  cardTipAmount: string | number
  nonCardTipAmount: string | number
  breakdown: unknown
  /** Invoice-wide payment facts from the job snapshot. */
  job: { cardServiceAmount: string | number | null; nonCardServiceAmount: string | number | null; jobTotal: string | number | null } | null
}

export type PayoutMath = {
  /** This technician's eligible service amount after discounts (their segment). */
  serviceBase: number
  colorBase: number
  regularBase: number
  /** Card-paid share of the invoice's service subtotal, 0..1. */
  cardShare: number
  /** Card dollars the fee is charged on (service, invoice-wide). */
  cardPaid: number
  /** Percentage points of the 3.5% actually applied to service dollars (cardShare x 3.5). */
  effectiveFeePercent: number
  /** Dollars withheld from THIS payout by the card fee (service commission + card tip share). */
  feeWithheld: number
  regularRate: number
  colorRate: number
  tipShare: number
  regularPayout: number
  colorPayout: number
  tipPayout: number
  totalPayout: number
  hasColor: boolean
  hasTip: boolean
  hasCard: boolean
}

/** Read the saved calculation back for display; no arithmetic beyond formatting-safe rounding. */
export function payoutMath(p: PayoutMathInput): PayoutMath {
  const b = (p.breakdown && typeof p.breakdown === "object" ? p.breakdown : {}) as Record<string, unknown>
  const invoiceFee = (b.invoiceFee && typeof b.invoiceFee === "object" ? b.invoiceFee : null) as { cardShare?: number; cardPaid?: number } | null
  const serviceBase = round2(num(p.jobTotal))
  const colorBase = round2(num(p.colorSealTotal))
  const jobCard = num(p.job?.cardServiceAmount)
  const jobServices = num(p.job?.jobTotal)
  const cardShare = typeof invoiceFee?.cardShare === "number" ? invoiceFee.cardShare : typeof b.cardServiceShare === "number" ? (b.cardServiceShare as number) : jobServices > 0 ? Math.min(1, jobCard / jobServices) : 0
  const cardPaid = typeof invoiceFee?.cardPaid === "number" ? round2(invoiceFee.cardPaid) : round2(jobCard)
  const feeWithheld = typeof b.cardFeeAdjustment === "number" ? Math.round((b.cardFeeAdjustment as number) * 100) / 100 : 0
  const tipTotal = round2(num(p.cardTipAmount) + num(p.nonCardTipAmount))
  return {
    serviceBase,
    colorBase,
    regularBase: round2(serviceBase - colorBase),
    cardShare,
    cardPaid,
    effectiveFeePercent: Math.round(cardShare * 3.5 * 1000) / 1000,
    feeWithheld,
    regularRate: num(p.nonColorRate),
    colorRate: num(p.colorRate),
    tipShare: num(p.tipShare),
    regularPayout: round2(num(p.nonColorPayout)),
    colorPayout: round2(num(p.colorPayout)),
    tipPayout: round2(num(p.tipPayout)),
    totalPayout: round2(num(p.totalPayout)),
    hasColor: colorBase > 0,
    hasTip: tipTotal > 0 || num(p.tipPayout) > 0,
    hasCard: cardShare > 0 || num(p.cardTipAmount) > 0,
  }
}

export const percent = (fraction: number, digits = 0) => `${(fraction * 100).toFixed(digits).replace(/\.0+$/, "")}%`

/** Short qualifier printed next to "Job total" so the figure is never mistaken for the service subtotal. */
export function jobTotalQualifier(s: JobMoneySummary): string {
  if (s.basis === "services-plus-tax") return s.includesTax ? "services after discount + tax" : "services after discount"
  const parts: string[] = []
  if (s.includesTip) parts.push("tip")
  if (s.includesTax) parts.push("tax")
  return parts.length ? `Workiz total, incl. ${parts.join(" and ")}` : "Workiz total"
}
