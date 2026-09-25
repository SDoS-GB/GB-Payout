import type { NormalizedLineItem, NormalizedPayment, PaymentSource } from "@/lib/db/schema"
import type { WorkizSettings } from "@/lib/settings"
import { DEFAULT_BUSINESS_TIMEZONE } from "@/lib/payout/presentation"
import type { WorkizRawJob } from "./client"
import { classifyPaymentMethod, mergePayments } from "./payments"
import { parseWorkizDate } from "./time"

/**
 * Everything the payout engine needs from a Workiz job, expressed in the same
 * units the manual calculator has always used:
 *   - jobTotal:        service revenue after discounts, before tax, excluding tips
 *   - colorSealTotal:  the color-sealing part of jobTotal (after its share of discounts)
 *   - cardServiceAmount / nonCardServiceAmount: how jobTotal was paid
 *   - cardTipAmount:   tips paid by card (fee applies, business owes tech)
 *   - nonCardTipAmount: tips paid by check/cash/Zelle to the business (no fee, business owes tech)
 *
 * Verified against live `job/get/` payloads (Sept 2026):
 *   - `SubTotal` is the sum of the non-discount line items, BEFORE discounts and tax.
 *   - Discounts arrive as line items with `Type: "DISCOUNT_TYPE"` and a POSITIVE price.
 *   - `JobTotalPrice` = SubTotal - discounts (+ tax/fees Workiz does not itemize).
 *   - `JobAmountDue` is the customer balance. No `Payments`, `Discount`, `TaxAmount`
 *     or `InvoiceStatus` field is returned, so the job payload alone never reveals the
 *     payment method. Payment records reach `normalizeJob` through `externalPayments`
 *     (invoice webhooks, admin confirmations — see lib/workiz/payments.ts).
 */
export type NormalizedJob = {
  uuid: string
  serialId: string | null
  status: string | null
  subStatus: string | null
  paymentDueDate: Date | null
  jobDateTime: Date | null
  jobEndDateTime: Date | null
  /** Workiz `LastStatusUpdate`; the completion time when the status is payable (Workiz has no dedicated completion stamp). */
  lastStatusUpdate: Date | null
  clientId: string | null
  clientName: string | null
  address: string | null
  jobType: string | null
  jobSource: string | null
  jobTotal: number
  subTotal: number | null
  taxAmount: number | null
  discountAmount: number
  colorSealTotal: number
  cardServiceAmount: number
  nonCardServiceAmount: number
  cardTipAmount: number
  nonCardTipAmount: number
  totalPaid: number
  fullyPaid: boolean
  /** Workiz invoice grand total (`JobTotalPrice`), null when the payload had none. */
  invoiceTotal: number | null
  /** Workiz customer balance (`JobAmountDue`), null when the payload had none. */
  amountDue: number | null
  /** What established `fullyPaid`. "balance" means only a $0 Workiz balance, with no payment records. */
  paidEvidence: "payments" | "invoice-status" | "balance" | "none"
  invoiceStatus: string | null
  teamIds: string[]
  teamNames: string[]
  tags: string[]
  lineItems: NormalizedLineItem[]
  payments: NormalizedPayment[]
  /** Human-readable reasons the engine should hold this payout for review (see isBlockingWarning). */
  warnings: string[]
}

const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.eE-]/g, "")
    const n = Number.parseFloat(cleaned)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length ? s : null
}

const date = (v: unknown, timeZone: string): Date | null => parseWorkizDate(str(v), timeZone || DEFAULT_BUSINESS_TIMEZONE)

const pick = (obj: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k]
  }
  return undefined
}

const includesKeyword = (haystack: string, keywords: string[]) => {
  const h = haystack.toLowerCase()
  return keywords.some((k) => k && h.includes(k.toLowerCase()))
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whole-word match so "Multiple" or "Stipulated" never read as a tip. */
const hasKeywordWord = (haystack: string, keywords: string[]) =>
  keywords.some((k) => k.trim() && new RegExp(`(^|[^a-z0-9])${escapeRegExp(k.trim().toLowerCase())}s?(?=$|[^a-z0-9])`, "i").test(haystack))

const round2 = (n: number) => Math.round(n * 100) / 100

/** Workiz's own marker for a discount line (`Type: "DISCOUNT_TYPE"`). */
const isDiscountType = (type: string | null, name: string) => (type ? /discount/i.test(type) : /^\s*discount\s*$/i.test(name))

/**
 * Warnings that describe the job but must not, by themselves, hold a payout.
 * Everything else in `warnings` blocks release until an admin reviews it.
 */
export const INFORMATIONAL_WARNING_PREFIXES = ["Line items mention sealing", "Workiz invoice total exceeds"] as const

export const PAYMENT_METHOD_UNKNOWN_PREFIX = "Payment method unknown"
export const UNITEMIZED_DISCOUNT_PREFIX = "Unitemized discount"
export const TIP_METHOD_UNCLEAR_PREFIX = "Tip payment method unclear"

export function isBlockingWarning(warning: string): boolean {
  return !INFORMATIONAL_WARNING_PREFIXES.some((prefix) => warning.startsWith(prefix))
}

export type ColorSealCatalog = Map<string, boolean>

export function normalizeLineItems(
  raw: unknown,
  settings: WorkizSettings,
  catalog: ColorSealCatalog,
): { items: NormalizedLineItem[]; tipItemsTotal: number } {
  if (!Array.isArray(raw)) return { items: [], tipItemsTotal: 0 }
  const items: NormalizedLineItem[] = []
  let tipItemsTotal = 0

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const r = entry as Record<string, unknown>
    const id = str(pick(r, "id", "Id", "ID", "ItemId", "ProductId", "product_id"))
    const name = str(pick(r, "Name", "name", "Title", "title", "Description", "description")) ?? "Line item"
    // Workiz keeps the product's marketing text in Description; dispatch may also type a
    // technician marker there, so it is kept for marker matching.
    const rawDescription = str(pick(r, "Description", "description", "Notes", "notes", "Note", "note", "Comment", "comment"))
    const description = rawDescription && rawDescription !== name ? rawDescription : null
    const type = str(pick(r, "Type", "type"))
    const quantity = num(pick(r, "Quantity", "quantity", "Qty", "qty")) || 1
    const unitPrice = num(pick(r, "Price", "price", "UnitPrice", "unit_price", "Rate"))
    const explicitTotal = pick(r, "Total", "total", "LineTotal", "line_total", "Amount", "amount")
    // Extended amount: Workiz's Price is per unit, so quantity is applied exactly once.
    let total = round2(explicitTotal !== undefined ? num(explicitTotal) : unitPrice * quantity)

    const isDiscount = isDiscountType(type, name)
    if (isDiscount) total = -Math.abs(total)

    if (!isDiscount && hasKeywordWord(name, settings.tipKeywords)) {
      tipItemsTotal += total
      continue // tips are never service revenue
    }

    let isColorSeal = false
    let matchedBy: NormalizedLineItem["matchedBy"] = "none"
    if (!isDiscount) {
      if (id && catalog.has(id)) {
        isColorSeal = Boolean(catalog.get(id))
        matchedBy = "catalog"
      } else if (includesKeyword(name, settings.colorSealKeywords)) {
        isColorSeal = true
        matchedBy = "keyword"
      }
    }

    items.push({ id, name, description, type, quantity, unitPrice, total, isColorSeal, isDiscount, matchedBy })
  }
  return { items, tipItemsTotal: round2(tipItemsTotal) }
}

export function normalizePayments(raw: unknown, settings: WorkizSettings, source: PaymentSource = "workiz-job"): NormalizedPayment[] {
  if (!Array.isArray(raw)) return []
  const out: NormalizedPayment[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const r = entry as Record<string, unknown>
    const amount = round2(num(pick(r, "Amount", "amount", "Total", "total", "PaymentAmount")))
    if (amount === 0) continue
    const id = str(pick(r, "id", "Id", "ID", "PaymentId", "payment_id"))
    // The same payment echoed twice (webhook + refetch) must not double the paid total.
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const method = str(pick(r, "Method", "method", "PaymentMethod", "payment_method", "Type", "type")) ?? "Unknown"
    const tipAmount = num(pick(r, "Tip", "tip", "TipAmount", "tip_amount"))
    // A manual cash/check/Zelle entry has no processor id or settlement status; the method text
    // alone decides the side. Unrecognised text is kept, flagged, and held — never assumed cash.
    const cls = classifyPaymentMethod(method, settings.cardMethodKeywords)
    const isTipFlag = Boolean(pick(r, "IsTip", "is_tip")) || hasKeywordWord(str(pick(r, "Note", "note", "Description")) ?? "", settings.tipKeywords)
    const paidAt = str(pick(r, "Date", "date", "PaymentDate", "payment_date", "CreatedAt", "created_at"))
    const base = { id, method, isCard: cls.isCard, methodKnown: cls.known, source, date: paidAt }

    if (tipAmount > 0 && tipAmount < amount) {
      // Workiz can attach a tip to a payment; split it so service and tip are tracked separately.
      out.push({ ...base, amount: round2(amount - tipAmount), isTip: false })
      out.push({ ...base, amount: round2(tipAmount), isTip: true })
      continue
    }
    out.push({ ...base, amount, isTip: isTipFlag })
  }
  return out
}

export type NormalizeOptions = {
  /** Payment records from outside the job payload (invoice webhooks, admin confirmations). */
  externalPayments?: NormalizedPayment[]
}

/**
 * Convert a raw Workiz job into calculator inputs. Pure: no I/O, no rounding of
 * anything the calculator later multiplies except the 2-decimal money inputs that
 * Workiz itself stores in cents.
 */
export function normalizeJob(raw: WorkizRawJob, settings: WorkizSettings, catalog: ColorSealCatalog, opts: NormalizeOptions = {}): NormalizedJob {
  const r = raw as Record<string, unknown>
  const warnings: string[] = []

  const uuid = str(pick(r, "UUID", "uuid", "Uuid"))
  if (!uuid) throw new Error("Workiz job is missing UUID")

  const team = Array.isArray(r.Team) ? (r.Team as Array<Record<string, unknown>>) : []
  const teamIds = team.map((t) => str(pick(t, "id", "Id", "ID"))).filter((x): x is string => Boolean(x))
  const teamNames = team.map((t) => str(pick(t, "Name", "name"))).filter((x): x is string => Boolean(x))
  if (teamIds.length === 0 && teamNames.length > 0) {
    warnings.push("Workiz returned team names without ids; mapping by id is not possible for this job")
  }

  const tags = Array.isArray(r.Tags) ? (r.Tags as unknown[]).map((t) => String(t)).filter(Boolean) : []

  const { items: lineItems, tipItemsTotal } = normalizeLineItems(pick(r, "LineItems", "line_items", "Items", "items"), settings, catalog)
  const payments = mergePayments(normalizePayments(pick(r, "Payments", "payments"), settings), opts.externalPayments ?? [])

  // --- Revenue -------------------------------------------------------------
  const invoiceTotalRaw = pick(r, "JobTotalPrice", "JobTotal", "job_total", "Total")
  const invoiceTotal = invoiceTotalRaw !== undefined ? round2(num(invoiceTotalRaw)) : null
  const rawSubTotal = pick(r, "SubTotal", "sub_total")
  const subTotal = rawSubTotal !== undefined ? round2(num(rawSubTotal)) : null
  const taxRaw = pick(r, "TaxAmount", "tax_amount", "Tax", "tax")
  const taxAmount = taxRaw !== undefined ? num(taxRaw) : null
  const discountRaw = pick(r, "Discount", "discount", "DiscountAmount", "discount_amount", "DiscountTotal")

  const positiveItemsGross = round2(lineItems.filter((i) => i.total > 0).reduce((s, i) => s + i.total, 0))
  const negativeItems = round2(lineItems.filter((i) => i.total < 0).reduce((s, i) => s + Math.abs(i.total), 0))
  let discountAmount = discountRaw !== undefined ? Math.abs(num(discountRaw)) : 0
  if (discountAmount === 0 && negativeItems > 0) discountAmount = negativeItems

  // Service revenue after discounts, before tax, excluding tips.
  // Preference order: SubTotal minus discounts and tip lines -> invoice total minus tax and tip lines -> line items minus discounts.
  let jobTotal: number
  if (subTotal !== null && subTotal > 0) {
    jobTotal = subTotal - discountAmount - tipItemsTotal
  } else if (invoiceTotal !== null && invoiceTotal > 0) {
    jobTotal = (taxAmount !== null ? invoiceTotal - taxAmount : invoiceTotal) - tipItemsTotal
  } else if (positiveItemsGross > 0) {
    jobTotal = positiveItemsGross - discountAmount
  } else {
    jobTotal = 0
  }
  jobTotal = round2(Math.max(0, jobTotal))

  if (invoiceTotal !== null && jobTotal > 0) {
    // JobTotalPrice should be the service total plus anything Workiz adds on top (tax, fees, invoiced tips).
    const expected = round2(jobTotal + tipItemsTotal + (taxAmount ?? 0))
    const diff = round2(invoiceTotal - expected)
    if (diff > 0.05) {
      warnings.push(
        `Workiz invoice total exceeds the service total by $${diff.toFixed(2)} ($${invoiceTotal.toFixed(2)} vs $${expected.toFixed(2)}); Workiz does not itemize tax or fees, so commission is calculated on the service total only`,
      )
    } else if (diff < -0.05) {
      // Live job #924820: SubTotal 475, no discount line, JobTotalPrice 425. Workiz applied a
      // job-level discount or write-off it does not itemize. Commission is owed on what the
      // customer was actually charged, so the shortfall is treated as one more whole-job
      // discount, and the payout is held until an admin confirms it was a discount, not a write-off.
      const shortfall = -diff
      discountAmount = round2(discountAmount + shortfall)
      jobTotal = round2(Math.max(0, jobTotal - shortfall))
      warnings.push(
        `${UNITEMIZED_DISCOUNT_PREFIX}: Workiz invoice total $${invoiceTotal.toFixed(2)} is $${shortfall.toFixed(2)} less than the itemized service total $${expected.toFixed(2)}; treated as a whole-job discount, confirm it is not a write-off`,
      )
    }
  }

  if (jobTotal === 0) warnings.push("Job total is zero")

  // --- Color seal ------------------------------------------------------------
  const colorGross = round2(lineItems.filter((i) => i.isColorSeal && i.total > 0).reduce((s, i) => s + i.total, 0))
  let colorSealTotal = 0
  if (colorGross > 0) {
    // Whole-job discounts are applied proportionally so the color portion stays inside jobTotal.
    const ratio = positiveItemsGross > 0 ? Math.min(1, jobTotal / positiveItemsGross) : 1
    colorSealTotal = round2(colorGross * ratio)
  }
  if (lineItems.length === 0) {
    warnings.push("Workiz returned no line items; color-sealing split could not be determined")
  }
  const unmatched = lineItems.filter((i) => i.matchedBy === "none" && !i.isDiscount && includesKeyword(i.name, ["seal"]) && !i.isColorSeal)
  if (unmatched.length) warnings.push(`Line items mention sealing but were not flagged as color seal (treated as regular work): ${unmatched.map((u) => u.name).join(", ")}`)

  // --- Payments --------------------------------------------------------------
  const servicePayments = payments.filter((p) => !p.isTip)
  const tipPayments = payments.filter((p) => p.isTip)

  let cardServiceAmount = round2(servicePayments.filter((p) => p.isCard).reduce((s, p) => s + p.amount, 0))
  let nonCardServiceAmount = round2(servicePayments.filter((p) => !p.isCard).reduce((s, p) => s + p.amount, 0))
  const cardTipAmount = round2(tipPayments.filter((p) => p.isCard).reduce((s, p) => s + p.amount, 0) + 0)
  let nonCardTipAmount = round2(tipPayments.filter((p) => !p.isCard).reduce((s, p) => s + p.amount, 0))

  const amountDueRaw = pick(r, "JobAmountDue", "AmountDue", "amount_due")
  const amountDue = amountDueRaw !== undefined ? round2(num(amountDueRaw)) : null

  // A tip that is an invoice line but has no payment record of its own takes the method of the
  // payment(s) that covered the invoice. One method: unambiguous. Several methods: the tip's
  // share of the card fee cannot be known, so it is split in the same proportion and held for review.
  if (tipItemsTotal > 0 && cardTipAmount === 0 && nonCardTipAmount === 0) {
    if (cardServiceAmount > 0 && nonCardServiceAmount > 0) {
      const share = cardServiceAmount / (cardServiceAmount + nonCardServiceAmount)
      const cardPart = round2(tipItemsTotal * share)
      const otherPart = round2(tipItemsTotal - cardPart)
      cardServiceAmount = round2(Math.max(0, cardServiceAmount - cardPart))
      nonCardServiceAmount = round2(Math.max(0, nonCardServiceAmount - otherPart))
      warnings.push(
        `${TIP_METHOD_UNCLEAR_PREFIX}: the $${tipItemsTotal.toFixed(2)} tip is an invoice line but the invoice was paid by more than one method (card $${(cardServiceAmount + cardPart).toFixed(2)}, other $${(nonCardServiceAmount + otherPart).toFixed(2)}); the tip is split in the same proportion ($${cardPart.toFixed(2)} card / $${otherPart.toFixed(2)} other) until an admin confirms how it was paid`,
      )
      return finalize({ cardTipAmount: cardPart, nonCardTipAmount: otherPart })
    }
    if (cardServiceAmount > 0) {
      // Card tip: move it out of the card service bucket if it was included.
      cardServiceAmount = round2(Math.max(0, cardServiceAmount - tipItemsTotal))
      return finalize({ cardTipAmount: tipItemsTotal, nonCardTipAmount })
    }
    nonCardServiceAmount = round2(Math.max(0, nonCardServiceAmount - tipItemsTotal))
    nonCardTipAmount = round2(nonCardTipAmount + tipItemsTotal)
  }

  return finalize({ cardTipAmount, nonCardTipAmount })

  function finalize(tips: { cardTipAmount: number; nonCardTipAmount: number }): NormalizedJob {
    let totalPaid = round2(payments.reduce((s, p) => s + p.amount, 0))
    const servicePaid = round2(cardServiceAmount + nonCardServiceAmount)
    const tipPaid = round2(tips.cardTipAmount + tips.nonCardTipAmount)
    // The invoice the customer owes: Workiz's own figure when present, else service + known tax.
    const invoiceDue = invoiceTotal !== null && invoiceTotal > 0 ? invoiceTotal : round2(jobTotal + (taxAmount ?? 0))

    const invoiceStatus = str(pick(r, "InvoiceStatus", "invoice_status", "PaymentStatus", "payment_status"))
    const statusSaysPaid = invoiceStatus ? /paid/i.test(invoiceStatus) && !/un|partial|not/i.test(invoiceStatus) : false

    let fullyPaid = false
    let paidEvidence: NormalizedJob["paidEvidence"] = "none"

    if (payments.length > 0) {
      // Only money applied to the invoice counts. Tip payments cover the invoice only when the tip is itself an invoice line.
      const paidTowardInvoice = round2(servicePaid + (tipItemsTotal > 0 ? tipPaid : 0))
      fullyPaid = invoiceDue > 0 && paidTowardInvoice + 0.005 >= invoiceDue
      paidEvidence = "payments"

      // A payment whose method text we cannot classify is kept on the non-card side only
      // provisionally; the warning holds the payout until an admin confirms card or not.
      const unknown = servicePayments.filter((p) => p.methodKnown === false)
      if (unknown.length) {
        const methods = Array.from(new Set(unknown.map((p) => p.method))).join(", ")
        const sum = round2(unknown.reduce((s, p) => s + p.amount, 0))
        warnings.push(`${PAYMENT_METHOD_UNKNOWN_PREFIX}: $${sum.toFixed(2)} was recorded with a method that is not recognised (${methods}); confirm whether it was paid by card before release`)
      }
      const ambiguousTips = tipPayments.filter((p) => p.tipAmbiguous)
      if (ambiguousTips.length) {
        const sum = round2(ambiguousTips.reduce((s, p) => s + p.amount, 0))
        warnings.push(`${TIP_METHOD_UNCLEAR_PREFIX}: Workiz reported a $${sum.toFixed(2)} tip but its totals do not show whether the payment amount already included it; confirm the tip before release`)
      }

      if (amountDue !== null) {
        // Workiz's balance is the authority on WHETHER the customer has paid; the records only
        // say HOW. A record set that claims full payment while Workiz still shows a balance is
        // not paid; a $0 balance that the records do not cover is paid but partly untyped.
        if (amountDue > 0.005 && fullyPaid) {
          fullyPaid = false
          warnings.push(`Workiz still shows $${amountDue.toFixed(2)} due although payment records total $${paidTowardInvoice.toFixed(2)}; the Workiz balance decides paid status`)
        } else if (amountDue <= 0.005 && !fullyPaid && invoiceDue > 0) {
          const untyped = round2(invoiceDue - paidTowardInvoice)
          fullyPaid = true
          totalPaid = round2(totalPaid + untyped)
          nonCardServiceAmount = round2(nonCardServiceAmount + untyped)
          warnings.push(`${PAYMENT_METHOD_UNKNOWN_PREFIX}: Workiz shows the $${invoiceDue.toFixed(2)} invoice paid in full but payment records cover only $${paidTowardInvoice.toFixed(2)}; the remaining $${untyped.toFixed(2)} has no payment type and is provisional as non-card`)
        }
      }
      if (servicePaid > 0 && Math.abs(servicePaid - invoiceDue) > 0.05 && Math.abs(servicePaid - jobTotal) > 0.05 && !fullyPaid) {
        warnings.push(`Payments (${servicePaid.toFixed(2)}) do not match job total (${invoiceDue.toFixed(2)})`)
      }
    } else if (amountDue !== null && invoiceTotal !== null && invoiceTotal > 0 && jobTotal > 0) {
      // Live job payloads carry no payment records at all (verified 2026-09-21 on #924886, which
      // Workiz's own UI shows as paid $50 cash): the balance is the only paid signal. This is
      // "details unavailable", not "the customer has not paid".
      totalPaid = round2(Math.max(0, invoiceTotal - Math.max(0, amountDue)))
      fullyPaid = amountDue <= 0.005
      paidEvidence = "balance"
      nonCardServiceAmount = jobTotal
      warnings.push(
        `${PAYMENT_METHOD_UNKNOWN_PREFIX}: payment details unavailable from Workiz — its job API reports only the balance ($${Math.max(0, amountDue).toFixed(2)} due of $${invoiceTotal.toFixed(2)}), not the payment type, so card vs cash/check/Zelle cannot be determined. Create a Workiz invoice (its webhook reports the type) or confirm the payment in the payout details; amount is provisional as non-card until then`,
      )
    } else if (jobTotal > 0) {
      nonCardServiceAmount = jobTotal
      warnings.push(`${PAYMENT_METHOD_UNKNOWN_PREFIX}: payment details unavailable — Workiz returned neither payment records nor a balance for this job; amount is provisional as non-card until confirmed`)
    }

    if (!fullyPaid && statusSaysPaid) {
      fullyPaid = true
      paidEvidence = "invoice-status"
    }

    // Payments include tax; scale service payments down to the pre-tax jobTotal so
    // the card/non-card split is expressed in the same units as jobTotal.
    const paidService = round2(cardServiceAmount + nonCardServiceAmount)
    if (paidService > 0 && jobTotal > 0 && Math.abs(paidService - jobTotal) > 0.005) {
      const scale = jobTotal / paidService
      cardServiceAmount = round2(cardServiceAmount * scale)
      nonCardServiceAmount = round2(jobTotal - cardServiceAmount)
    }

    const firstName = str(pick(r, "FirstName", "first_name"))
    const lastName = str(pick(r, "LastName", "last_name"))
    const clientName = str(pick(r, "ClientName", "client_name")) ?? ([firstName, lastName].filter(Boolean).join(" ") || null)

    const address = [str(r.Address), str(r.City), str(r.State), str(r.PostalCode)].filter(Boolean).join(", ") || null

    return {
      uuid: uuid as string,
      serialId: str(pick(r, "SerialId", "serial_id", "SerialID", "JobId")),
      status: str(pick(r, "Status", "status")),
      subStatus: str(pick(r, "SubStatus", "sub_status")),
      paymentDueDate: date(pick(r, "PaymentDueDate", "payment_due_date"), settings.businessTimezone),
      jobDateTime: date(pick(r, "JobDateTime", "job_date_time"), settings.businessTimezone),
      jobEndDateTime: date(pick(r, "JobEndDateTime", "job_end_date_time"), settings.businessTimezone),
      lastStatusUpdate: date(pick(r, "LastStatusUpdate", "last_status_update"), settings.businessTimezone),
      clientId: str(pick(r, "ClientId", "client_id")),
      clientName,
      address,
      jobType: str(pick(r, "JobType", "job_type")),
      jobSource: str(pick(r, "JobSource", "job_source")),
      jobTotal,
      subTotal,
      taxAmount,
      discountAmount: round2(discountAmount),
      colorSealTotal,
      cardServiceAmount,
      nonCardServiceAmount,
      cardTipAmount: tips.cardTipAmount,
      nonCardTipAmount: tips.nonCardTipAmount,
      totalPaid,
      fullyPaid,
      invoiceTotal,
      amountDue,
      paidEvidence,
      invoiceStatus,
      teamIds,
      teamNames,
      tags,
      lineItems,
      payments,
      warnings,
    }
  }
}

export function isPayableStatus(status: string | null, settings: WorkizSettings): boolean {
  if (!status) return false
  const s = status.trim().toLowerCase()
  return settings.payableStatuses.some((p) => p.trim().toLowerCase() === s)
}
