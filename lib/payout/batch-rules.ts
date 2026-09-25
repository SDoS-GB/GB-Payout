/**
 * Pure rules for owner payment batches: how the technician is paid, what a "Paid" click may
 * settle, and how the selected total is summed. No database imports so client components and
 * tests can share them.
 */

export const TECH_PAYMENT_METHODS = ["Zelle", "Cash", "Check", "Other"] as const
export type TechPaymentMethod = (typeof TECH_PAYMENT_METHODS)[number]
/** Every new batch starts here, whatever the previous batch used. */
export const DEFAULT_TECH_PAYMENT_METHOD: TechPaymentMethod = "Zelle"

export const round2 = (n: number) => Math.round(n * 100) / 100
const toCents = (n: number) => Math.round(n * 100)

export type SelectionItem = { payoutId: number; amount: number; inputHash: string | null }
export type SelectionRow = { id: number; profileId: number; status: string; totalPayout: string | number; inputHash: string | null }
export type StaleItem = { payoutId: number; reason: string; currentStatus: string | null; currentAmount: number | null }

/** Sum of the exact displayed (rounded) amounts, in dollars, without float drift. */
export function selectionTotal(items: ReadonlyArray<{ amount: number }>): number {
  return items.reduce((cents, i) => cents + toCents(i.amount), 0) / 100
}

/**
 * Compares what the owner selected against the current database rows. Every mismatch is
 * reported (not just the first) so the UI can refresh exactly the affected rows and explain.
 */
export function validateSelection(
  profileId: number,
  items: ReadonlyArray<SelectionItem>,
  rows: ReadonlyArray<SelectionRow>,
  opts: { allowStatuses?: ReadonlyArray<string> } = {},
): { ok: true } | { ok: false; stale: StaleItem[] } {
  const allow = new Set(opts.allowStatuses ?? ["ready"])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const stale: StaleItem[] = []
  const seen = new Set<number>()
  for (const item of items) {
    if (seen.has(item.payoutId)) {
      stale.push({ payoutId: item.payoutId, reason: "Selected twice", currentStatus: null, currentAmount: null })
      continue
    }
    seen.add(item.payoutId)
    const row = byId.get(item.payoutId)
    if (!row) {
      stale.push({ payoutId: item.payoutId, reason: "Payout no longer exists", currentStatus: null, currentAmount: null })
      continue
    }
    const current = round2(Number(row.totalPayout))
    if (row.profileId !== profileId) {
      stale.push({ payoutId: item.payoutId, reason: "Belongs to a different technician", currentStatus: row.status, currentAmount: current })
      continue
    }
    if (!allow.has(row.status)) {
      stale.push({ payoutId: item.payoutId, reason: row.status === "paid" ? "Already paid" : `Status changed to ${row.status}`, currentStatus: row.status, currentAmount: current })
      continue
    }
    if (toCents(current) !== toCents(item.amount)) {
      stale.push({ payoutId: item.payoutId, reason: `Amount changed from $${item.amount.toFixed(2)} to $${current.toFixed(2)}`, currentStatus: row.status, currentAmount: current })
      continue
    }
    if (item.inputHash && row.inputHash && item.inputHash !== row.inputHash) {
      stale.push({ payoutId: item.payoutId, reason: "Job data changed since it was displayed", currentStatus: row.status, currentAmount: current })
    }
  }
  return stale.length ? { ok: false, stale } : { ok: true }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function isoDateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

/** Form-level validation for a new batch. Returns an error message or null. */
export function validateBatchForm(input: { method: string; paidOn: string; today: string; itemCount: number; reference?: string | null }): string | null {
  if (input.itemCount <= 0) return "Select at least one job payout"
  if (!(TECH_PAYMENT_METHODS as ReadonlyArray<string>).includes(input.method)) return `Payment method must be one of ${TECH_PAYMENT_METHODS.join(", ")}`
  if (!ISO_DATE.test(input.paidOn)) return "Paid date must be a calendar date"
  if (input.paidOn > input.today) return "Paid date cannot be in the future"
  if (input.reference && input.reference.length > 200) return "Note is too long (200 characters max)"
  return null
}
