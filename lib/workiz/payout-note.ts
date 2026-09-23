import type { NormalizedPayment } from "@/lib/db/schema"
import { formatCurrency } from "@/lib/payout/calculator"
import { paymentMethodLabel } from "@/lib/payout/presentation"
import { markerLabel } from "@/lib/payout/segments"
import { parseWorkizDate } from "./time"

/**
 * The payout summary this app writes into a job's Workiz **Job description** (API field
 * `JobNotes`) at the moment it tags the job payout-ready.
 *
 * Why the description: a Workiz text-message automation can only insert Workiz's own short
 * codes (client name, assigned tech, job type, job description, job total, balance, ...).
 * There is no short code for the payment method, the tip, the payout amount or a tag, so the
 * only way for the admin's text to say "pay Arthur $9.65, paid by card on Sep 21" is for this
 * block to already be in the description when the automation reads it. The admin's automation
 * message is then just the Job description short code.
 *
 * Writing `JobNotes` through `job/update` was verified live on 2026-09-21 (job 7HKYSL): the text
 * reads back byte for byte and tags / LastStatusUpdate are untouched. The block is kept to plain
 * ASCII so the SMS stays in the 160-character GSM alphabet instead of dropping to 70 per segment.
 */

export const PAYOUT_NOTE_HEADER = "PAYOUT READY (GB app)"

export type PayoutNoteTech = {
  name: string
  /** Total the technician is owed for this job, tip share included. */
  total: number
  /** Portion of `total` that is the technician's tip share. */
  tip: number
  segmentKind: string
  segmentMarker: string | null
  /** Why this technician is paid on this job, from the saved payout snapshot. */
  ownership?: { reason?: string | null; workType?: string | null } | null
}

export type PayoutNoteInput = {
  serialId: string | null
  uuid: string
  jobType: string | null
  clientName: string | null
  jobTotal: number
  /** Job-level tip the client left (card + non-card), before any technician split. */
  tipTotal: number
  payments: NormalizedPayment[]
  /** Ready payouts on the job; empty on an admin test tag. */
  techs: PayoutNoteTech[]
  timeZone: string
}

/** Everything the admin asked to see in one text, one fact per line. */
export function buildPayoutNote(input: PayoutNoteInput): string {
  const lines = [PAYOUT_NOTE_HEADER]

  if (input.techs.length === 0) {
    lines.push("Pay: no ready payout on this job (test tag)")
  } else {
    for (const tech of input.techs) {
      const scope = segmentScope(tech)
      const included = tech.tip > 0 ? "total and tip included" : "total"
      lines.push(`Pay ${tech.name} ${formatCurrency(tech.total)} (${scope ? `${scope}, ` : ""}${included})`)
    }
  }

  const jobParts = [`Job #${input.serialId ?? input.uuid}`, input.jobType?.trim(), input.clientName?.trim()].filter((p): p is string => Boolean(p))
  lines.push(jobParts.join(" - "))

  lines.push(paymentLine(input))

  const tipLine = tipSummary(input)
  if (tipLine) lines.push(tipLine)

  return lines.map(toGsmSafe).join("\n")
}

function segmentScope(tech: PayoutNoteTech): string | null {
  const workType = tech.ownership?.workType
  if (workType && tech.ownership?.reason === "work-type") return `whole job, ${workType}`
  if (workType && tech.segmentKind === "crew") return `tip only, ${workType}`
  const marker = markerLabel(tech.segmentMarker)
  if (tech.segmentKind === "dedicated") return `${marker ?? "marked"} items`
  if (tech.segmentKind === "crew") return marker ? `crew, excl. ${marker}` : "crew"
  return null
}

function paymentLine(input: PayoutNoteInput): string {
  const service = input.payments.filter((p) => !p.isTip)
  const records = service.length ? service : input.payments
  if (records.length === 0) return `Paid ${formatCurrency(input.jobTotal)} - payment method not on file`

  const collected = records.reduce((sum, p) => sum + p.amount, 0)
  const byMethod = new Map<string, number>()
  for (const p of records) {
    const label = paymentMethodLabel(p.method, p.isCard)
    byMethod.set(label, (byMethod.get(label) ?? 0) + p.amount)
  }
  const when = latestPaymentDate(records, input.timeZone)
  const suffix = when ? ` on ${when}` : ""

  if (byMethod.size === 1) {
    const [label] = byMethod.keys()
    return `Paid ${formatCurrency(collected)} by ${label}${suffix}`
  }
  const split = Array.from(byMethod.entries())
    .map(([label, amount]) => `${formatCurrency(amount)} ${label}`)
    .join(" + ")
  return `Paid ${formatCurrency(collected)}: ${split}${suffix}`
}

function tipSummary(input: PayoutNoteInput): string | null {
  const fromRecords = input.payments.filter((p) => p.isTip).reduce((sum, p) => sum + p.amount, 0)
  const tipTotal = input.tipTotal > 0 ? input.tipTotal : fromRecords
  if (tipTotal <= 0) return null
  // Who gets what only matters once the tip is split or someone on the job is excluded (Tim).
  const shares = input.techs.filter((t) => t.tip > 0).map((t) => `${t.name} ${formatCurrency(t.tip)}`)
  const none = input.techs.filter((t) => t.tip <= 0).map((t) => t.name)
  if (shares.length === 0 || input.techs.length < 2) return `Tip ${formatCurrency(tipTotal)}`
  return `Tip ${formatCurrency(tipTotal)} (${shares.join(", ")}${none.length ? `; ${none.join(", ")} none` : ""})`
}

function latestPaymentDate(records: NormalizedPayment[], timeZone: string): string | null {
  let latest: Date | null = null
  for (const p of records) {
    const d = parseWorkizDate(p.date, timeZone)
    if (d && (!latest || d.getTime() > latest.getTime())) latest = d
  }
  if (!latest) return null
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(latest)
  } catch {
    return latest.toISOString().slice(0, 16).replace("T", " ")
  }
}

/** Intl inserts narrow no-break spaces before AM/PM; those and other non-ASCII glyphs would force the SMS into 70-char segments. */
function toGsmSafe(line: string): string {
  return line
    .replace(/[\u00a0\u202f\u2009]/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
}

const BLOCK_PATTERN = new RegExp(`${escapeRegExp(PAYOUT_NOTE_HEADER)}[\\s\\S]*?(?:\\n[ \\t]*\\r?\\n|$)`, "g")

export function hasPayoutNote(description: string | null | undefined): boolean {
  return typeof description === "string" && description.includes(PAYOUT_NOTE_HEADER)
}

/**
 * Put the block at the top of the description so the text message leads with it, keeping
 * whatever the office typed below. An earlier block (admin re-test, released hold) is replaced,
 * never stacked, so the description carries exactly one current summary.
 */
export function mergePayoutNote(existingDescription: string | null | undefined, note: string): string {
  const rest = (existingDescription ?? "").replace(BLOCK_PATTERN, "").replace(/^\s+/, "").replace(/\s+$/, "")
  return rest ? `${note}\n\n${rest}` : note
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
