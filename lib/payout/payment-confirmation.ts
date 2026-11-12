import type { NormalizedPayment } from "@/lib/db/schema"
import { CREDIT_CARD_LABEL, manualMethodFor, type ManualPaymentMethod } from "@/lib/workiz/payment-method"
import { groupCustomerPayments } from "./due-presentation"
import { originalPaymentMethod } from "./presentation"

/**
 * What the "Confirm payments from Workiz" form starts with. Pure: the form only edits it.
 */
export type ConfirmationSeedRow = {
  /** A method the app recognises, or "" when a person has to choose. Never a guess. */
  method: ManualPaymentMethod | ""
  /** The charge as Workiz shows it on the Payments tab, tip included. */
  amount: number
  /** The part of `amount` that was a tip. */
  tip: number
  paidAt: string | null
  /** What Workiz called the method when that differs from the option shown ("charge"). */
  workizMethod: string | null
}

/**
 * One row per payment the customer made. An existing admin confirmation is shown as it was
 * saved; otherwise the rows come from the payments Workiz reported. A method is filled in only
 * when it is recognised ("Credit", "Charge" and "Credit Charge" are all Credit Card); anything
 * else is left for the admin to choose.
 */
export function confirmationSeedRows(confirmed: NormalizedPayment[], reported: NormalizedPayment[]): ConfirmationSeedRow[] {
  const source = confirmed.length ? confirmed : reported
  return groupCustomerPayments(source).map((line) => ({
    method: !line.methodKnown ? "" : line.isCard ? CREDIT_CARD_LABEL : manualMethodFor(line.method),
    amount: line.amount,
    tip: line.tipAmount,
    paidAt: line.date,
    // An unrecognised method is always quoted, so the admin can see what has to be decided.
    workizMethod: line.methodKnown ? originalPaymentMethod({ method: line.method, isCard: line.isCard, source: line.source }) : line.source === "manual" ? null : line.method.trim() || null,
  }))
}
