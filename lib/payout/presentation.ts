import type { NormalizedPayment } from "@/lib/db/schema"

/**
 * Pure, side-effect-free helpers shared by the admin read models and the
 * dashboard UI. Nothing here touches payout arithmetic: these only describe
 * stored data (labels, links, reasons) so both server and client render it the
 * same way.
 */

export const DEFAULT_BUSINESS_TIMEZONE = "America/New_York"

export const PAYOUT_STATUS_FILTERS = ["all", "ready", "hold", "pending", "paid", "void"] as const
export type PayoutStatusFilter = (typeof PAYOUT_STATUS_FILTERS)[number]

export type PayoutQuery = {
  status: PayoutStatusFilter
  profileId: number | null
  search: string
  page: number
  pageSize: number
}

export const DEFAULT_PAYOUT_QUERY: PayoutQuery = { status: "all", profileId: null, search: "", page: 1, pageSize: 25 }

/** Workiz's web app addresses a job by its UUID: https://app.workiz.com/job/{UUID}/ */
export function workizJobUrl(uuid: string | null | undefined): string | null {
  if (!uuid) return null
  const safe = uuid.trim()
  return /^[A-Za-z0-9_-]{3,64}$/.test(safe) ? `https://app.workiz.com/job/${encodeURIComponent(safe)}/` : null
}

export type CompletionState =
  | { state: "completed"; at: string }
  | { state: "not-completed"; status: string }
  | { state: "unknown"; reason: string }

/**
 * Workiz has no dedicated completion timestamp. The only verified signal is the
 * job's status: when it is one of the configured payable ("finished") statuses,
 * the last status-change time is when it was completed. Scheduled start/end and
 * sync times are never substituted.
 */
export function completionState(input: {
  status: string | null
  payableStatuses: string[]
  /** Already parsed in the business timezone (see lib/workiz/time.ts); null when Workiz gave nothing usable. */
  lastStatusUpdate: Date | null
}): CompletionState {
  const status = input.status?.trim() ?? ""
  if (!status) return { state: "unknown", reason: "Workiz did not return a job status" }
  const finished = input.payableStatuses.some((s) => s.trim().toLowerCase() === status.toLowerCase())
  if (!finished) return { state: "not-completed", status }
  if (!input.lastStatusUpdate || Number.isNaN(input.lastStatusUpdate.getTime())) {
    return { state: "unknown", reason: `Job is ${status} but Workiz did not return a usable status-change time` }
  }
  return { state: "completed", at: input.lastStatusUpdate.toISOString() }
}

const METHOD_LABELS: Array<[RegExp, string]> = [
  [/credit|card|visa|master|amex|discover|stripe|^cc$/i, "Card"],
  [/check|cheque/i, "Check"],
  [/cash/i, "Cash"],
  [/zelle/i, "Zelle"],
  [/venmo/i, "Venmo"],
  [/ach|bank|wire/i, "Bank transfer"],
  [/financ|wisetack|affirm/i, "Financing"],
]

export function paymentMethodLabel(method: string | null | undefined, isCard?: boolean): string {
  const m = (method ?? "").trim()
  if (isCard) return "Card"
  if (!m) return "Unknown method"
  for (const [re, label] of METHOD_LABELS) if (re.test(m)) return label
  return m.charAt(0).toUpperCase() + m.slice(1)
}

/** "Card + Check" for mixed jobs; "No payments recorded" when Workiz has none. */
export function paymentMethodsSummary(payments: NormalizedPayment[] | null | undefined): { label: string; mixed: boolean; count: number } {
  const service = (payments ?? []).filter((p) => !p.isTip)
  const all = service.length ? service : (payments ?? [])
  if (all.length === 0) return { label: "No payments recorded", mixed: false, count: 0 }
  const labels = Array.from(new Set(all.map((p) => paymentMethodLabel(p.method, p.isCard))))
  return { label: labels.join(" + "), mixed: labels.length > 1, count: all.length }
}

export type StatusExplanation = {
  headline: string
  detail: string
  action: string | null
}

/**
 * Turns the engine's stored hold/pending reason into the specific reason and
 * the action an admin must take. Reasons are matched on the exact strings the
 * engine writes (see lib/payout/engine.ts gateReason and upsertPayoutsForJob).
 */
export function explainPayoutStatus(input: {
  status: string
  holdReason: string | null
  jobStatus: string | null
  fullyPaid: boolean | null
  totalPaid: number
  grandTotal: number
  paidAt: Date | string | null
  paidBy: string | null
}): StatusExplanation {
  const reason = input.holdReason?.trim() ?? ""
  const remaining = Math.max(0, input.grandTotal - input.totalPaid)

  switch (input.status) {
    case "ready":
      return {
        headline: "Ready to pay",
        detail: "Job is in a finished status, the customer has paid in full, and every team member on the job is mapped. Amount is final.",
        action: "Mark paid once the technician has been paid.",
      }
    case "paid":
      return {
        headline: "Paid to technician",
        detail: input.paidAt ? `Recorded as paid${input.paidBy ? ` by ${input.paidBy}` : ""}.` : "Recorded as paid.",
        action: null,
      }
    case "void":
      return { headline: "Voided", detail: reason || "This payout was voided by an admin and will not be paid.", action: null }
  }

  if (/not payable/i.test(reason)) {
    return {
      headline: input.status === "hold" ? "On hold: job not finished" : "Pending: job not finished",
      detail: `Workiz job status is "${input.jobStatus ?? "unknown"}", which is not one of the payable statuses. The amount is provisional.`,
      action: "Finish the job in Workiz (move it to a payable status), then re-sync.",
    }
  }
  if (/not fully paid/i.test(reason)) {
    return {
      headline: input.status === "hold" ? "On hold: customer balance outstanding" : "Pending: customer balance outstanding",
      detail:
        input.fullyPaid === false
          ? `Customer has paid $${input.totalPaid.toFixed(2)} of $${input.grandTotal.toFixed(2)}; $${remaining.toFixed(2)} is still outstanding.`
          : "Workiz reports the invoice is not fully paid.",
      action: "Collect the remaining balance in Workiz, then re-sync the job.",
    }
  }
  if (/unmapped team members?/i.test(reason)) {
    const ids = reason.match(/\(([^)]+)\)/)?.[1]
    return {
      headline: "On hold: unmapped team member",
      detail: `Workiz team id${ids && ids.includes(",") ? "s" : ""} ${ids ?? ""} on this job are not linked to a technician profile, so the split cannot be trusted.`.replace(/\s+/g, " "),
      action: "Link the team member in Team mapping (or mark them Excluded), then re-sync the job.",
    }
  }
  if (/total is zero/i.test(reason)) {
    return { headline: "On hold: job total is zero", detail: "Workiz returned no billable service amount for this job.", action: "Check the job's line items in Workiz, then re-sync." }
  }
  if (/segment check failed|double-counted|marker/i.test(reason)) {
    return {
      headline: "On hold: line-item ownership could not be verified",
      detail: reason,
      action: "Fix the technician markers on the Workiz line items so every item is owned once, then re-sync.",
    }
  }
  if (/held by admin/i.test(reason) || input.status === "hold") {
    return { headline: "On hold: admin review", detail: reason || "Held for manual review.", action: "Review the payout, then Release it or Void it." }
  }
  return {
    headline: "Pending",
    detail: reason || "Waiting for the job to finish and the customer to pay in full.",
    action: "Re-sync the job after it is finished and paid.",
  }
}

export type LineItemOwnership = "this-technician" | "crew" | "dedicated" | "whole-job"

/**
 * Which technician a line item was credited to when this payout was
 * calculated. Uses the item indexes saved in the payout snapshot when present
 * and falls back to the saved item names for older snapshots.
 */
export function lineItemOwnership(input: {
  segmentKind: string
  segmentItemIndexes: number[] | null
  segmentItemNames: string[] | null
  itemIndex: number
  itemName: string
}): LineItemOwnership {
  if (input.segmentKind === "job") return "whole-job"
  const inSegment = input.segmentItemIndexes
    ? input.segmentItemIndexes.includes(input.itemIndex)
    : (input.segmentItemNames ?? []).includes(input.itemName)
  if (inSegment) return "this-technician"
  return input.segmentKind === "crew" ? "dedicated" : "crew"
}
