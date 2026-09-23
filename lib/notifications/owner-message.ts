import type { NormalizedPayment } from "@/lib/db/schema"
import { formatCurrency } from "@/lib/payout/calculator"
import { paymentMethodLabel } from "@/lib/payout/presentation"
import { OWNER_NOTE_HEADER } from "@/lib/workiz/payout-note"
import { parseWorkizDate } from "@/lib/workiz/time"

/**
 * The owner's "payout ready" text: one message per job, every technician's own amount on
 * its own line, never a combined crew total. Pure: the server module hashes the snapshot
 * key, persists the row and talks to Workiz; this file only decides and formats.
 *
 * Delivery goes through the owner's existing Workiz texting: the app tags the job and writes
 * this block into the job description, and the owner's Workiz automation ("tag added → send
 * text to team member → {Job description}") sends the SMS from the business number.
 */

export const OWNER_MESSAGE_HEADER = OWNER_NOTE_HEADER

export type OwnerMessageTech = {
  id: number
  name: string
  /** ready | paid | pending | hold | void */
  status: string
  total: number
  tip: number
  holdReason: string | null
  ownership?: { reason?: string | null; workType?: string | null } | null
  segmentKind?: string | null
  segmentMarker?: string | null
}

export type OwnerMessageJob = {
  uuid: string
  serialId: string | null
  clientName: string | null
  jobType: string | null
  status: string | null
  fullyPaid: boolean
  jobTotal: number
  /** Card + non-card tip the client left, before any split. */
  tipTotal: number
  payments: NormalizedPayment[]
  /** Workiz `LastStatusUpdate` wall-clock string; the only completion timestamp Workiz has. */
  lastStatusUpdate: string | null
}

export type OwnerNotificationInput = {
  job: OwnerMessageJob
  techs: OwnerMessageTech[]
  /** Workiz team ids on the job that are not mapped to a technician (and not excluded). */
  unmappedTeamIds: string[]
  sender: {
    /** `workiz.payoutReadyTagEnabled` — the production switch for owner texts. */
    enabled: boolean
    tag: string
    hasCredentials: boolean
  }
  recipient: { configured: boolean; label: string | null; masked: string | null }
  timeZone: string
}

export type OwnerNotificationDecision =
  | { state: "blocked"; reason: string; message: string | null; snapshotKey: string | null }
  | { state: "preview_only"; reason: string; message: string; snapshotKey: string }
  | { state: "ready"; message: string; snapshotKey: string }

const money = (n: number) => formatCurrency(Math.round(n * 100) / 100)

/** Everything the owner asked to see, one fact per line, ASCII-only so the SMS stays in GSM-7. */
export function buildOwnerMessage(input: Pick<OwnerNotificationInput, "job" | "techs" | "timeZone">): string {
  const { job } = input
  const techs = input.techs.filter((t) => t.status === "ready" || t.status === "paid")
  const lines = [OWNER_MESSAGE_HEADER]
  lines.push(`Job #${job.serialId ?? job.uuid} - ${job.clientName?.trim() || "client"}`)
  const completed = completionDate(job.lastStatusUpdate, input.timeZone)
  lines.push(completed ? `Completed ${completed}` : "Completed (date unavailable)")
  lines.push(paymentsLine(job.payments, job.jobTotal))
  const cardPaid = job.payments.some((p) => p.isCard)
  lines.push(cardPaid ? "Card fee applied proportionally." : "No card fee.")
  if (job.tipTotal > 0) {
    const shares = techs.filter((t) => t.tip > 0).map((t) => `${t.name} ${money(t.tip)}`)
    lines.push(`Tip ${money(job.tipTotal)}${shares.length ? ` (${shares.join(", ")})` : ""}`)
  }
  for (const tech of sortedTechs(techs)) {
    const scope = techScope(tech)
    lines.push(`${tech.name}: ${money(tech.total)}${scope ? ` (${scope})` : ""}${tech.status === "paid" ? " - already paid" : ""}`)
  }
  return lines.map(toGsmSafe).join("\n")
}

function sortedTechs(techs: OwnerMessageTech[]): OwnerMessageTech[] {
  return [...techs].sort((a, b) => a.name.localeCompare(b.name))
}

function techScope(tech: OwnerMessageTech): string | null {
  const workType = tech.ownership?.workType
  if (workType && tech.ownership?.reason === "work-type") return `whole job, ${workType}`
  if (workType && tech.segmentKind === "crew") return `tip share only, ${workType}`
  if (tech.segmentKind === "dedicated") return `${tech.segmentMarker ? `*${tech.segmentMarker.split(",")[0].trim()}*` : "marked"} items`
  if (tech.segmentKind === "crew") return "crew work"
  return null
}

function paymentsLine(payments: NormalizedPayment[], jobTotal: number): string {
  const service = payments.filter((p) => !p.isTip)
  if (service.length === 0) return `Client payments: unavailable (Workiz did not report the method for ${money(jobTotal)})`
  const byMethod = new Map<string, number>()
  for (const p of service) {
    const label = paymentMethodLabel(p.method, p.isCard)
    byMethod.set(label, (byMethod.get(label) ?? 0) + p.amount)
  }
  const parts = Array.from(byMethod.entries())
    .sort((a, b) => (a[0] === "Card" ? -1 : b[0] === "Card" ? 1 : a[0].localeCompare(b[0])))
    .map(([label, amount]) => `${label} ${money(amount)}`)
  return `Client payments: ${parts.join("; ")}`
}

function completionDate(lastStatusUpdate: string | null, timeZone: string): string | null {
  const d = parseWorkizDate(lastStatusUpdate, timeZone)
  if (!d) return null
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

/** Intl inserts narrow no-break spaces; those and other non-ASCII glyphs would force the SMS into 70-char segments. */
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

/**
 * Canonical description of the payout set a message represents. Same key = same message; the
 * server hashes it and refuses to send when the stored key no longer matches the current one.
 */
export function snapshotKeyOf(input: Pick<OwnerNotificationInput, "job" | "techs">): string {
  const techs = [...input.techs]
    .sort((a, b) => a.id - b.id)
    .map((t) => [t.id, t.name, t.status, t.total.toFixed(2), t.tip.toFixed(2)])
  const payments = [...input.job.payments]
    .map((p) => [p.isCard ? "card" : "other", p.isTip ? "tip" : "service", p.amount.toFixed(2)])
    .sort((a, b) => a.join("|").localeCompare(b.join("|")))
  return JSON.stringify({ v: 1, job: input.job.uuid, total: input.job.jobTotal.toFixed(2), status: input.job.status, techs, payments })
}

/**
 * Decide what the owner notification for a job should be right now. Blockers are listed in
 * the order an admin would fix them; the first one wins and is shown verbatim in diagnostics.
 * "Zero payouts updated" is never a blocker: an unchanged, ready, unsent job stays `ready`.
 */
export function evaluateOwnerNotification(input: OwnerNotificationInput): OwnerNotificationDecision {
  const { job, techs, sender, recipient } = input
  const blocked = (reason: string, withMessage = false): OwnerNotificationDecision => ({
    state: "blocked",
    reason,
    message: withMessage ? buildOwnerMessage(input) : null,
    snapshotKey: withMessage ? snapshotKeyOf(input) : null,
  })

  if (techs.length === 0) return blocked("No payout has been calculated for this job yet")

  const open = techs.filter((t) => t.status === "pending" || t.status === "hold")
  if (open.length) {
    const first = open.sort((a, b) => (a.status === "hold" ? -1 : 1) - (b.status === "hold" ? -1 : 1))[0]
    const why = first.holdReason ? ` - ${first.holdReason}` : ""
    return blocked(`Waiting: ${first.name}'s payout is ${first.status === "hold" ? "on hold" : "pending"}${why}${open.length > 1 ? ` (+${open.length - 1} more)` : ""}`)
  }
  if (input.unmappedTeamIds.length) return blocked(`Unmapped Workiz team member(s) on this job: ${input.unmappedTeamIds.join(", ")}. Map or exclude them in Team mapping`)

  const ready = techs.filter((t) => t.status === "ready")
  if (ready.length === 0) return blocked(techs.every((t) => t.status === "void") ? "Every payout on this job is void" : "Every payout on this job is already marked paid")

  if (!job.fullyPaid) return blocked("Workiz does not show this job as fully paid")
  if (job.payments.filter((p) => !p.isTip).length === 0) return blocked("Payment method unavailable: no payment records (card vs check/cash/Zelle unknown)")

  const message = buildOwnerMessage(input)
  const snapshotKey = snapshotKeyOf(input)

  if (!sender.hasCredentials) return { state: "blocked", reason: "Workiz API token is not configured (Admin > Workiz)", message, snapshotKey }
  if (!sender.tag.trim()) return { state: "blocked", reason: "Payout-ready tag name is empty (Admin > Workiz > Text me when a payout is ready)", message, snapshotKey }
  if (!recipient.configured) return { state: "blocked", reason: "Owner recipient not configured (Admin > Owner texts). Pick the Workiz team member your automation texts", message, snapshotKey }
  if (!sender.enabled) return { state: "preview_only", reason: "Owner texts are switched off (Admin > Workiz > Tag jobs in Workiz). Message is stored, nothing is sent", message, snapshotKey }
  return { state: "ready", message, snapshotKey }
}

/** Bounded back-off for provider failures: 1m, 5m, 15m, 1h, 6h, then give up. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length

/** When to try again after `attemptsSoFar` failed attempts, or null when retries are exhausted. */
export function nextRetryAt(attemptsSoFar: number, now: Date = new Date()): Date | null {
  if (attemptsSoFar >= MAX_ATTEMPTS) return null
  return new Date(now.getTime() + RETRY_DELAYS_MS[Math.max(0, attemptsSoFar - 1)])
}

/** Owner-notification states and how the admin should read them. */
export const OWNER_STATES = ["blocked", "preview_only", "queued", "sending", "provider_accepted", "delivered", "failed"] as const
export type OwnerState = (typeof OWNER_STATES)[number]

export function describeOwnerState(status: string): { label: string; tone: "muted" | "warn" | "info" | "ok" | "error"; explanation: string } {
  switch (status) {
    case "blocked":
      return { label: "Blocked", tone: "warn", explanation: "Not eligible yet; the reason below says what is missing." }
    case "preview_only":
      return { label: "Preview only", tone: "muted", explanation: "Message is built and stored, but owner texts are switched off so nothing was sent." }
    case "queued":
      return { label: "Queued", tone: "info", explanation: "Eligible and waiting for the next delivery run (webhook, cron or Send now)." }
    case "sending":
      return { label: "Sending", tone: "info", explanation: "A delivery attempt is in progress." }
    case "provider_accepted":
      return { label: "Provider accepted", tone: "ok", explanation: "Workiz confirmed the tag and summary are on the job; your Workiz automation sends the SMS. Delivery is unconfirmed until you confirm receipt." }
    case "delivered":
      return { label: "Delivered", tone: "ok", explanation: "Receipt confirmed by the owner." }
    case "failed":
      return { label: "Failed", tone: "error", explanation: "Workiz rejected or timed out; see the last error and the scheduled retry." }
    default:
      return { label: status, tone: "muted", explanation: "" }
  }
}
