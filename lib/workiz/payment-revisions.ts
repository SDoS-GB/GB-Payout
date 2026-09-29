import type { ExternalPaymentInput, TipInclusion } from "./payments"

export type PaymentRevision = {
  amount: number
  tipAmount: number
  method: string
  paymentState: string
  sourceUpdatedAt: Date | null
  tipInclusion: TipInclusion
}

export function paymentRevisionDecision(previous: PaymentRevision, incoming: PaymentRevision): "replace" | "same" | "stale" | "conflict" {
  const before = previous.sourceUpdatedAt?.getTime()
  const after = incoming.sourceUpdatedAt?.getTime()
  if (before != null && after != null && after < before) return "stale"
  const same = previous.amount === incoming.amount && previous.tipAmount === incoming.tipAmount
    && previous.method.trim().toLowerCase() === incoming.method.trim().toLowerCase()
    && previous.paymentState === incoming.paymentState
    && (previous.tipAmount === 0 || previous.tipInclusion === incoming.tipInclusion)
  if (same) return "same"
  if (after != null && (before == null || after > before)) return "replace"
  // Two different revisions without an ordering clock cannot safely resurrect a refunded
  // payment, undo a correction, or move a payment from card to cash.
  return "conflict"
}

export function paymentRevision(input: ExternalPaymentInput, inclusion: TipInclusion, sourceUpdatedAt: Date | null): PaymentRevision {
  return { amount: input.amount, tipAmount: input.tipAmount, method: input.method, paymentState: input.paymentState ?? "active", sourceUpdatedAt, tipInclusion: inclusion }
}
