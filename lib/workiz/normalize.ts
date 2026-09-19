import type { NormalizedLineItem, NormalizedPayment } from "@/lib/db/schema"
import type { WorkizSettings } from "@/lib/settings"
import type { WorkizRawJob } from "./client"

/**
 * Everything the payout engine needs from a Workiz job, expressed in the same
 * units the manual calculator has always used:
 *   - jobTotal:        service revenue after discounts, before tax, excluding tips
 *   - colorSealTotal:  the color-sealing part of jobTotal (after its share of discounts)
 *   - cardServiceAmount / nonCardServiceAmount: how jobTotal was paid
 *   - cardTipAmount:   tips paid by card (fee applies, business owes tech)
 *   - nonCardTipAmount: tips paid by check/cash/Zelle to the business (no fee, business owes tech)
 */
export type NormalizedJob = {
  uuid: string
  serialId: string | null
  status: string | null
  subStatus: string | null
  paymentDueDate: Date | null
  jobDateTime: Date | null
  jobEndDateTime: Date | null
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
  invoiceStatus: string | null
  teamIds: string[]
  teamNames: string[]
  tags: string[]
  lineItems: NormalizedLineItem[]
  payments: NormalizedPayment[]
  /** Human-readable reasons the engine should hold this payout for review. */
  warnings: string[]
}

const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.-]/g, "")
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

const date = (v: unknown): Date | null => {
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

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

const round2 = (n: number) => Math.round(n * 100) / 100

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
    // Workiz may put the free-text a dispatcher types (including technician markers) in a
    // separate field from the product name, so keep it for marker matching.
    const rawDescription = str(pick(r, "Description", "description", "Notes", "notes", "Note", "note", "Comment", "comment"))
    const description = rawDescription && rawDescription !== name ? rawDescription : null
    const quantity = num(pick(r, "Quantity", "quantity", "Qty", "qty")) || 1
    const unitPrice = num(pick(r, "Price", "price", "UnitPrice", "unit_price", "Rate"))
    const explicitTotal = pick(r, "Total", "total", "LineTotal", "line_total", "Amount", "amount")
    const total = round2(explicitTotal !== undefined ? num(explicitTotal) : unitPrice * quantity)

    if (includesKeyword(name, settings.tipKeywords)) {
      tipItemsTotal += total
      continue // tips are never service revenue
    }

    let isColorSeal = false
    let matchedBy: NormalizedLineItem["matchedBy"] = "none"
    if (id && catalog.has(id)) {
      isColorSeal = Boolean(catalog.get(id))
      matchedBy = "catalog"
    } else if (includesKeyword(name, settings.colorSealKeywords)) {
      isColorSeal = true
      matchedBy = "keyword"
    }

    items.push({ id, name, description, quantity, unitPrice, total, isColorSeal, matchedBy })
  }
  return { items, tipItemsTotal: round2(tipItemsTotal) }
}

export function normalizePayments(raw: unknown, settings: WorkizSettings): NormalizedPayment[] {
  if (!Array.isArray(raw)) return []
  const out: NormalizedPayment[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const r = entry as Record<string, unknown>
    const amount = round2(num(pick(r, "Amount", "amount", "Total", "total", "PaymentAmount")))
    if (amount === 0) continue
    const method = str(pick(r, "Method", "method", "PaymentMethod", "payment_method", "Type", "type")) ?? "Unknown"
    const tipAmount = num(pick(r, "Tip", "tip", "TipAmount", "tip_amount"))
    const isCard = includesKeyword(method, settings.cardMethodKeywords)
    const isTipFlag = Boolean(pick(r, "IsTip", "is_tip")) || includesKeyword(str(pick(r, "Note", "note", "Description")) ?? "", settings.tipKeywords)
    const paidAt = str(pick(r, "Date", "date", "PaymentDate", "payment_date", "CreatedAt", "created_at"))

    if (tipAmount > 0 && tipAmount < amount) {
      // Workiz can attach a tip to a payment; split it so service and tip are tracked separately.
      out.push({ id: str(pick(r, "id", "Id", "ID")), amount: round2(amount - tipAmount), method, isCard, isTip: false, date: paidAt })
      out.push({ id: str(pick(r, "id", "Id", "ID")), amount: round2(tipAmount), method, isCard, isTip: true, date: paidAt })
      continue
    }
    out.push({ id: str(pick(r, "id", "Id", "ID")), amount, method, isCard, isTip: isTipFlag, date: paidAt })
  }
  return out
}

/**
 * Convert a raw Workiz job into calculator inputs. Pure: no I/O, no rounding of
 * anything the calculator later multiplies except the 2-decimal money inputs that
 * Workiz itself stores in cents.
 */
export function normalizeJob(raw: WorkizRawJob, settings: WorkizSettings, catalog: ColorSealCatalog): NormalizedJob {
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

  const { items: lineItems, tipItemsTotal } = normalizeLineItems(pick(r, "Items", "items", "LineItems", "line_items"), settings, catalog)
  const payments = normalizePayments(pick(r, "Payments", "payments"), settings)

  // --- Revenue -------------------------------------------------------------
  const rawJobTotal = num(pick(r, "JobTotal", "job_total", "Total"))
  const rawSubTotal = pick(r, "SubTotal", "sub_total")
  const subTotal = rawSubTotal !== undefined ? num(rawSubTotal) : null
  const taxRaw = pick(r, "TaxAmount", "tax_amount", "Tax", "tax")
  const taxAmount = taxRaw !== undefined ? num(taxRaw) : null
  const discountRaw = pick(r, "Discount", "discount", "DiscountAmount", "discount_amount", "DiscountTotal")
  let discountAmount = discountRaw !== undefined ? Math.abs(num(discountRaw)) : 0

  const itemsGross = round2(lineItems.reduce((s, i) => s + i.total, 0))
  const negativeItems = round2(lineItems.filter((i) => i.total < 0).reduce((s, i) => s + Math.abs(i.total), 0))
  if (discountAmount === 0 && negativeItems > 0) discountAmount = negativeItems

  // Service revenue after discounts, before tax, excluding tips.
  // Preference order: SubTotal (Workiz's pre-tax amount) -> JobTotal minus tax -> line items minus discounts.
  let jobTotal: number
  if (subTotal !== null && subTotal > 0) {
    jobTotal = subTotal
  } else if (rawJobTotal > 0) {
    // JobTotal is the invoice grand total; strip tax and any tip line items it contains.
    jobTotal = (taxAmount !== null ? rawJobTotal - taxAmount : rawJobTotal) - tipItemsTotal
  } else if (itemsGross > 0) {
    // itemsGross already excludes tip line items.
    jobTotal = itemsGross - discountAmount + negativeItems
  } else {
    jobTotal = 0
  }
  jobTotal = round2(Math.max(0, jobTotal))

  if (jobTotal === 0) warnings.push("Job total is zero")

  // --- Color seal ------------------------------------------------------------
  const positiveItemsGross = round2(lineItems.filter((i) => i.total > 0).reduce((s, i) => s + i.total, 0))
  const colorGross = round2(lineItems.filter((i) => i.isColorSeal && i.total > 0).reduce((s, i) => s + i.total, 0))
  let colorSealTotal = 0
  if (colorGross > 0) {
    // Discounts are applied proportionally so the color portion stays inside jobTotal.
    const ratio = positiveItemsGross > 0 ? Math.min(1, jobTotal / positiveItemsGross) : 1
    colorSealTotal = round2(colorGross * ratio)
  }
  if (lineItems.length === 0) {
    warnings.push("Workiz returned no line items; color-sealing split could not be determined")
  }
  const unmatched = lineItems.filter((i) => i.matchedBy === "none" && includesKeyword(i.name, ["seal"]) && !i.isColorSeal)
  if (unmatched.length) warnings.push(`Line items mention sealing but were not flagged as color seal: ${unmatched.map((u) => u.name).join(", ")}`)

  // --- Payments --------------------------------------------------------------
  const servicePayments = payments.filter((p) => !p.isTip)
  const tipPayments = payments.filter((p) => p.isTip)

  let cardServiceAmount = round2(servicePayments.filter((p) => p.isCard).reduce((s, p) => s + p.amount, 0))
  let nonCardServiceAmount = round2(servicePayments.filter((p) => !p.isCard).reduce((s, p) => s + p.amount, 0))
  const cardTipAmount = round2(tipPayments.filter((p) => p.isCard).reduce((s, p) => s + p.amount, 0) + 0)
  let nonCardTipAmount = round2(tipPayments.filter((p) => !p.isCard).reduce((s, p) => s + p.amount, 0))

  // Tip line items with no dedicated tip payment: attribute them to the dominant method.
  if (tipItemsTotal > 0 && cardTipAmount === 0 && nonCardTipAmount === 0) {
    if (cardServiceAmount >= nonCardServiceAmount && cardServiceAmount > 0) {
      // Card tip: move it out of the card service bucket if it was included.
      cardServiceAmount = round2(Math.max(0, cardServiceAmount - tipItemsTotal))
      return finalize({ cardTipAmount: tipItemsTotal, nonCardTipAmount })
    }
    nonCardServiceAmount = round2(Math.max(0, nonCardServiceAmount - tipItemsTotal))
    nonCardTipAmount = round2(nonCardTipAmount + tipItemsTotal)
  }

  return finalize({ cardTipAmount, nonCardTipAmount })

  function finalize(tips: { cardTipAmount: number; nonCardTipAmount: number }): NormalizedJob {
    const totalPaid = round2(payments.reduce((s, p) => s + p.amount, 0))
    const servicePaid = round2(cardServiceAmount + nonCardServiceAmount)
    const grandTotal = round2(jobTotal + (taxAmount ?? 0))

    // Payment info may lag or be absent. When we know the job is paid but have
    // no payment records, fall back to non-card so the fee is not deducted
    // without evidence, and flag it.
    if (servicePaid === 0 && jobTotal > 0) {
      warnings.push("No payment records returned; payout assumes non-card until payments sync")
      nonCardServiceAmount = jobTotal
    } else if (servicePaid > 0 && Math.abs(servicePaid - grandTotal) > 0.05 && Math.abs(servicePaid - jobTotal) > 0.05) {
      warnings.push(`Payments (${servicePaid.toFixed(2)}) do not match job total (${grandTotal.toFixed(2)})`)
    }

    // Payments include tax; scale service payments down to the pre-tax jobTotal so
    // the card/non-card split is expressed in the same units as jobTotal.
    const paidService = round2(cardServiceAmount + nonCardServiceAmount)
    if (paidService > 0 && jobTotal > 0 && Math.abs(paidService - jobTotal) > 0.005) {
      const scale = jobTotal / paidService
      cardServiceAmount = round2(cardServiceAmount * scale)
      nonCardServiceAmount = round2(jobTotal - cardServiceAmount)
    }

    const invoiceStatus = str(pick(r, "InvoiceStatus", "invoice_status", "PaymentStatus", "payment_status"))
    const fullyPaid =
      (invoiceStatus ? /paid/i.test(invoiceStatus) && !/un|partial|not/i.test(invoiceStatus) : false) ||
      (grandTotal > 0 && totalPaid + 0.005 >= grandTotal)

    const firstName = str(pick(r, "FirstName", "first_name"))
    const lastName = str(pick(r, "LastName", "last_name"))
    const clientName = str(pick(r, "ClientName", "client_name")) ?? ([firstName, lastName].filter(Boolean).join(" ") || null)

    const address = [str(r.Address), str(r.City), str(r.State), str(r.PostalCode)].filter(Boolean).join(", ") || null

    return {
      uuid: uuid as string,
      serialId: str(pick(r, "SerialId", "serial_id", "SerialID", "JobId")),
      status: str(pick(r, "Status", "status")),
      subStatus: str(pick(r, "SubStatus", "sub_status")),
      paymentDueDate: date(pick(r, "PaymentDueDate", "payment_due_date")),
      jobDateTime: date(pick(r, "JobDateTime", "job_date_time")),
      jobEndDateTime: date(pick(r, "JobEndDateTime", "job_end_date_time")),
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
