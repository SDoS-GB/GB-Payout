"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, ExternalLink } from "lucide-react"
import type { PayoutRecord, reviewPayout } from "@/app/actions/admin"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { segmentLabel } from "@/lib/payout/segments"
import {
  PAYMENT_DETAILS_UNAVAILABLE,
  explainPayoutStatus,
  hasWorkizPaymentRecords,
  lineItemOwnership,
  paymentMethodLabel,
  paymentMethodsSummary,
  paymentSourceLabel,
  workizJobUrl,
} from "@/lib/payout/presentation"
import type { ManualPaymentEntry } from "@/lib/workiz/payments"
import { PaymentConfirmationForm } from "./payment-confirmation-form"
import { InlineMessage, StatusBadge, money, zonedDate, zonedDateTime } from "./shared"

type ReviewAction = Parameters<typeof reviewPayout>[1]

export type PaymentHandlers = {
  onConfirmPayments: (jobUuid: string, entries: ManualPaymentEntry[]) => void
  onClearPayments: (jobUuid: string) => void
}

/** Shape of the JSON snapshot the engine saves with every payout (lib/payout/engine.ts). */
type Snapshot = Partial<{
  nonColorPayout: number
  colorPayout: number
  tipPayout: number
  basePayout: number
  totalPayout: number
  nonColorAmount: number
  colorAmount: number
  cardServiceShare: number
  cardNonColorAmount: number
  cardColorAmount: number
  nonCardNonColorAmount: number
  nonCardColorAmount: number
  cardTipPayout: number
  nonCardTipPayout: number
  cardFeeAdjustment: number
  mode: string
  calcVersion: string
  warnings: string[]
  segment: Partial<{
    kind: string
    marker: string | null
    itemIndexes: number[]
    itemNames: string[]
    markerFields: string[]
    grossAmount: number
    itemDiscountAmount: number
    allocatedDiscountAmount: number
    share: number
  }>
  job: Partial<{ jobTotal: number; colorSealTotal: number; discountAmount: number; cardServiceAmount: number; markers: string[] }>
  verification: Partial<{ balanced: boolean; assignedItemCount: number; itemCount: number; doubleCountedItems: number }>
}>

const pct = (v: string | number | null | undefined) => `${(Number(v ?? 0) * 100).toFixed(Number(v ?? 0) * 100 % 1 === 0 ? 0 : 1)}%`
const num = (v: string | number | null | undefined) => Number(v ?? 0)
const differs = (a: number, b: number) => Math.abs(a - b) > 0.005

/** Where the latest stored Workiz job disagrees with the numbers this payout was calculated from. */
function snapshotMismatches(p: PayoutRecord, snap: Snapshot): string[] {
  const job = p.job
  if (!job) return ["The Workiz job for this payout is no longer stored; the saved snapshot cannot be re-verified."]
  const out: string[] = []
  const cmp = (label: string, saved: number | undefined, current: number) => {
    if (saved === undefined) return
    if (differs(saved, current)) out.push(`${label} was ${money(saved)} when calculated; Workiz now shows ${money(current)}.`)
  }
  if (snap.job) {
    cmp("Job service total", snap.job.jobTotal, num(job.jobTotal))
    cmp("Job discount", snap.job.discountAmount, num(job.discountAmount))
    cmp("Job color-seal total", snap.job.colorSealTotal, num(job.colorSealTotal))
    cmp("Card-paid service amount", snap.job.cardServiceAmount, num(job.cardServiceAmount))
  } else if (p.segmentKind === "job") {
    cmp("Job service total", num(p.jobTotal), num(job.jobTotal))
    cmp("Job discount", num(p.discountAmount), num(job.discountAmount))
    cmp("Job color-seal total", num(p.colorSealTotal), num(job.colorSealTotal))
    cmp("Card-paid service amount", num(p.cardServiceAmount), num(job.cardServiceAmount))
  }
  if (p.segmentKind === "job") {
    cmp("Card tips", num(p.cardTipAmount), num(job.cardTipAmount))
    cmp("Other tips", num(p.nonCardTipAmount), num(job.nonCardTipAmount))
  }
  if ((p.status === "ready" || p.status === "paid") && job.fullyPaid === false) out.push("Workiz now reports the invoice is not fully paid.")
  return out
}

export function PayoutDetailSheet({
  record,
  open,
  onOpenChange,
  timezone,
  pending,
  onAction,
  payments,
}: {
  record: PayoutRecord | null
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
  pending: boolean
  onAction: (id: number, action: ReviewAction, note?: string) => void
  payments: PaymentHandlers
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        {record && <PayoutDetail key={record.id} p={record} timezone={timezone} pending={pending} onAction={onAction} paymentHandlers={payments} />}
      </SheetContent>
    </Sheet>
  )
}

function PayoutDetail({
  p,
  timezone,
  pending,
  onAction,
  paymentHandlers,
}: {
  p: PayoutRecord
  timezone: string
  pending: boolean
  onAction: (id: number, action: ReviewAction, note?: string) => void
  paymentHandlers: PaymentHandlers
}) {
  const [note, setNote] = useState(p.adminNote ?? "")
  useEffect(() => setNote(p.adminNote ?? ""), [p.adminNote])

  const job = p.job
  const snap = (p.breakdown ?? {}) as Snapshot
  const segment = snap.segment ?? null
  const markers = snap.job?.markers ?? []
  const marker = p.segmentMarker ?? markers.join("/") ?? null
  const label = segmentLabel(p.segmentKind, marker)
  const provisional = p.status === "pending" || p.status === "hold"
  const notCalculated = num(p.jobTotal) <= 0 && num(p.totalPayout) === 0
  const workizUrl = workizJobUrl(p.jobUuid)
  const separateColorSeal = snap.colorAmount !== undefined ? snap.colorAmount > 0 || num(p.colorSealTotal) === 0 : num(p.colorPayout) > 0 || num(p.colorSealTotal) === 0
  const nonColorAmount = snap.nonColorAmount ?? (separateColorSeal ? num(p.jobTotal) - num(p.colorSealTotal) : num(p.jobTotal))
  const colorAmount = snap.colorAmount ?? (separateColorSeal ? num(p.colorSealTotal) : 0)
  const hasCardMoney = num(p.cardServiceAmount) > 0 || num(p.cardTipAmount) > 0
  const cardShare = snap.cardServiceShare ?? (num(p.jobTotal) > 0 ? num(p.cardServiceAmount) / num(p.jobTotal) : 0)
  const mismatches = snapshotMismatches(p, snap)
  const warnings = snap.warnings ?? []

  const payments = [...(job?.payments ?? [])].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
  const methods = paymentMethodsSummary(job?.payments)
  const paymentDates = Array.from(new Set(payments.map((x) => (x.date ? zonedDate(x.date, timezone) : null)).filter(Boolean) as string[]))
  const manualPayments = payments.filter((x) => x.source === "manual" && !x.isTip)
  const fromWorkiz = hasWorkizPaymentRecords(payments)
  // Offer the confirmation form only where it is the missing piece: an unpaid-to-tech payout
  // whose payment type Workiz did not supply (or that an admin already transcribed).
  const canConfirmPayments = Boolean(job) && (p.status === "pending" || p.status === "hold") && !fromWorkiz
  const jobTotal = num(job?.jobTotal)
  const tax = job?.taxAmount == null ? null : num(job.taxAmount)
  // Workiz's own invoice figure (JobTotalPrice) includes tax/fees it does not itemize; fall back to service + known tax.
  const workizInvoiceTotal = job?.invoiceTotal != null && Number.isFinite(job.invoiceTotal) && job.invoiceTotal > 0 ? job.invoiceTotal : null
  const grandTotal = workizInvoiceTotal ?? jobTotal + (tax ?? 0)
  const unitemized = workizInvoiceTotal !== null ? Math.max(0, workizInvoiceTotal - jobTotal - (tax ?? 0)) : 0
  const totalPaid = num(job?.totalPaid)
  const tipsTotal = num(job?.cardTipAmount) + num(job?.nonCardTipAmount)
  // Workiz's own balance figure is authoritative when the sync got no per-payment records.
  const workizDue = job?.amountDue != null && Number.isFinite(job.amountDue) ? Math.max(0, job.amountDue) : null
  const remaining = payments.length === 0 && workizDue !== null ? workizDue : Math.max(0, grandTotal - totalPaid)
  const collectedPerWorkiz = payments.length === 0 && workizDue !== null ? Math.max(0, grandTotal - workizDue) : null

  const explanation = explainPayoutStatus({
    status: p.status,
    holdReason: p.holdReason,
    jobStatus: job?.status ?? null,
    fullyPaid: job?.fullyPaid ?? null,
    totalPaid,
    grandTotal,
    paidAt: p.paidAt,
    paidBy: p.paidBy,
  })

  const ownerLabel = (kind: ReturnType<typeof lineItemOwnership>) => {
    switch (kind) {
      case "whole-job":
        return { text: p.splitCount > 1 ? `Whole job · shared by ${p.splitCount} technicians` : "Whole job", mine: true }
      case "this-technician":
        return { text: p.segmentKind === "dedicated" ? `${p.profileName} �� ${label ?? "marked work"}` : `${p.profileName} · crew work`, mine: true }
      case "crew":
        return { text: "Crew work · not this technician", mine: false }
      case "dedicated":
        return { text: `${segmentLabel("dedicated", markers.join("/") || marker) ?? "Marked work only"} · not this technician`, mine: false }
    }
  }

  return (
    <div className="flex flex-col">
      <SheetHeader className="gap-2 border-b bg-card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={p.status} />
          {provisional && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">Provisional amount</Badge>}
          {p.status === "paid" && p.paidAt && <span className="text-xs text-muted-foreground">Paid {zonedDateTime(p.paidAt, timezone)}</span>}
        </div>
        <SheetTitle className="text-lg">
          Job #{job?.serialId ?? p.jobUuid} · {p.profileName}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{job?.clientName ?? "Customer unavailable"}</span>
          {label && <span className="font-mono text-xs">{label}</span>}
          {workizUrl ? (
            <a href={workizUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
              Open in Workiz
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : (
            <span className="text-xs">Workiz link unavailable</span>
          )}
        </SheetDescription>
        <div className="flex items-baseline justify-between gap-3 rounded-md border bg-background px-3 py-2">
          <span className="text-sm text-muted-foreground">{provisional ? "Provisional amount owed to " : p.status === "paid" ? "Paid to " : "Amount owed to "}{p.profileName}</span>
          <span className={`text-xl font-semibold tabular-nums ${notCalculated ? "text-muted-foreground" : ""}`}>{notCalculated ? "Not calculated" : money(p.totalPayout)}</span>
        </div>
        {notCalculated && <p className="text-xs text-muted-foreground">Workiz returned a zero service total for this job, so no commission could be calculated.</p>}
      </SheetHeader>

      <div className="flex flex-col gap-6 p-5">
        {(mismatches.length > 0 || warnings.length > 0) && (
          <section aria-label="Warnings" className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              {mismatches.length ? "Latest Workiz data differs from this saved payout" : "Sync warnings saved with this payout"}
            </p>
            <ul className="list-disc pl-5 text-amber-900/90 dark:text-amber-100/90">
              {mismatches.map((m) => (
                <li key={m}>{m}</li>
              ))}
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            {mismatches.length > 0 && (
              <p className="text-xs text-amber-900/80 dark:text-amber-100/80">
                {p.status === "paid" || p.status === "void"
                  ? "Paid and voided payouts are never rewritten by a sync; review manually if the difference matters."
                  : "Re-sync the job to recalculate from the latest Workiz data."}
              </p>
            )}
          </section>
        )}

        <Section title="Status">
          <p className="font-medium">{explanation.headline}</p>
          <p className="text-sm text-muted-foreground">{explanation.detail}</p>
          {explanation.action && (
            <p className="text-sm">
              <span className="font-medium">Action needed:</span> {explanation.action}
            </p>
          )}
          <Facts
            rows={[
              ["Technician paid", p.status === "paid" ? `Yes · ${zonedDateTime(p.paidAt, timezone)}${p.paidBy ? ` by ${p.paidBy}` : ""}` : "Not yet"],
              ["Message to technician", p.lastNotification ? <span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={p.lastNotification.status} />{p.lastNotification.sentAt ? <span className="text-xs text-muted-foreground">sent {zonedDateTime(p.lastNotification.sentAt, timezone)}</span> : null}</span> : "None rendered yet"],
              p.adminNote ? ["Admin note", p.adminNote] : null,
              p.reviewedAt ? ["Last reviewed", `${zonedDateTime(p.reviewedAt, timezone)}${p.reviewedBy ? ` by ${p.reviewedBy}` : ""}`] : null,
            ]}
          />
          {p.lastNotification && (
            <p className="rounded border bg-muted/40 p-2 text-xs">
              {p.lastNotification.message}
              {p.lastNotification.error && <span className="text-destructive"> · {p.lastNotification.error}</span>}
            </p>
          )}
        </Section>

        <Section title="Job and customer">
          <Facts
            rows={[
              ["Job number", job?.serialId ? `#${job.serialId}` : "Unavailable"],
              ["Workiz UUID", <span className="font-mono text-xs">{p.jobUuid}</span>],
              ["Customer", job?.clientName ?? "Unavailable"],
              ["Service address", job?.address ?? "Unavailable"],
              ["Workiz job status", job?.status ? `${job.status}${job.subStatus ? ` · ${job.subStatus}` : ""}` : "Unavailable"],
              job?.jobType ? ["Job type", job.jobType] : null,
              ["Team on job", job?.teamNames?.length ? job.teamNames.join(", ") : job?.teamIds?.length ? job.teamIds.join(", ") : "Unavailable"],
            ]}
          />
          {p.siblings.length > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Other technicians on this job (separate payouts)</p>
              <ul className="flex flex-col gap-1">
                {p.siblings.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1">
                    <span>
                      {s.profileName}
                      {segmentLabel(s.segmentKind, s.segmentMarker) && <span className="ml-2 font-mono text-xs text-muted-foreground">{segmentLabel(s.segmentKind, s.segmentMarker)}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={s.status} />
                      <span className="tabular-nums">{money(s.totalPayout)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        <Section title="Dates" hint={`Shown in ${timezone}`}>
          <Facts
            rows={[
              ["Scheduled job", job?.jobDateTime ? `${zonedDateTime(job.jobDateTime, timezone)}${job.jobEndDateTime ? ` → ${zonedDateTime(job.jobEndDateTime, timezone)}` : ""}` : "Unavailable"],
              [
                "Actual completion",
                !p.completion
                  ? "Completion date unavailable"
                  : p.completion.state === "completed"
                    ? `${zonedDateTime(p.completion.at, timezone)} (status changed to ${job?.status})`
                    : p.completion.state === "not-completed"
                      ? `Not completed · Workiz status is "${p.completion.status}"`
                      : `Completion date unavailable · ${p.completion.reason}`,
              ],
              ["Customer payment dates", paymentDates.length ? paymentDates.join(", ") : payments.length ? "Payments recorded without dates" : PAYMENT_DETAILS_UNAVAILABLE],
              job?.paymentDueDate ? ["Payment due (Workiz)", zonedDate(job.paymentDueDate, timezone)] : null,
              ["Last Workiz sync", job?.lastSeenAt ? zonedDateTime(job.lastSeenAt, timezone) : "Unavailable"],
              ["Payout last updated", zonedDateTime(p.updatedAt, timezone)],
              ["Paid to technician", p.paidAt ? zonedDateTime(p.paidAt, timezone) : "Not paid yet"],
            ]}
          />
        </Section>

        <Section title="Work performed" hint={label ? `This payout covers ${label.toLowerCase()}` : undefined}>
          {job && job.lineItems.length > 0 ? (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line item</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Credited to</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {job.lineItems.map((item, index) => {
                    const owner = ownerLabel(
                      lineItemOwnership({
                        segmentKind: p.segmentKind,
                        segmentItemIndexes: segment?.itemIndexes ?? null,
                        segmentItemNames: segment?.itemNames ?? null,
                        itemIndex: index,
                        itemName: item.name,
                      }),
                    )
                    const looksLikeDiscount = item.total < 0 || /discount|coupon|promo/i.test(item.name)
                    return (
                      <TableRow key={`${item.id ?? "item"}-${index}`} className={owner.mine ? undefined : "text-muted-foreground"}>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-col gap-1">
                            <span className="text-sm">{item.name}</span>
                            <span className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                              {item.quantity !== 1 && <span>{item.quantity} × {money(item.unitPrice)}</span>}
                              {item.isColorSeal && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">Color seal</Badge>}
                              {looksLikeDiscount && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">Discount</Badge>}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right align-top tabular-nums">{money(item.total)}</TableCell>
                        <TableCell className="whitespace-normal align-top text-xs">{owner.text}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Workiz returned no line items for this job.</p>
          )}
          <Facts
            rows={[
              segment?.grossAmount !== undefined ? [label ? "This technician's items, before discounts" : "Items before discounts", money(segment.grossAmount)] : null,
              segment?.itemDiscountAmount ? ["Discounts on these items", `−${money(segment.itemDiscountAmount)}`] : null,
              segment?.allocatedDiscountAmount ? [label ? "Share of job-wide discount" : "Job-wide discount", `−${money(segment.allocatedDiscountAmount)}`] : null,
              ["Eligible service amount after discounts", money(p.jobTotal)],
              segment?.markerFields?.length ? ["Marker found in", segment.markerFields.join(", ")] : null,
              snap.verification
                ? ["Ownership check", snap.verification.balanced ? `Passed · ${snap.verification.assignedItemCount}/${snap.verification.itemCount} items credited exactly once` : `Failed · ${snap.verification.doubleCountedItems ?? 0} item(s) double-counted or totals do not balance`]
                : null,
            ]}
          />
        </Section>

        <Section title={`Individual payout · ${p.profileName}`} hint="Saved calculation. Historical rates are shown, not today's.">
          <Facts
            rows={[
              ["Eligible service amount", money(p.jobTotal)],
              separateColorSeal ? ["Regular work portion", money(nonColorAmount)] : [`${label && p.segmentKind === "dedicated" ? label : "Whole amount"} at one rate`, money(nonColorAmount)],
              separateColorSeal ? ["Color-sealing portion", money(colorAmount)] : null,
              ["Rates used", `${pct(p.nonColorRate)} regular${separateColorSeal ? ` · ${pct(p.colorRate)} color seal` : ""} · ${pct(p.tipShare)} of tips`],
              ["Commission on regular work", money(p.nonColorPayout)],
              separateColorSeal ? ["Commission on color sealing", money(p.colorPayout)] : null,
              [
                "Card-fee adjustment",
                snap.cardFeeAdjustment !== undefined
                  ? snap.cardFeeAdjustment > 0
                    ? `−${money(snap.cardFeeAdjustment)} · 3.5% on the ${pct(cardShare)} paid by card`
                    : "$0.00 · no card payments"
                  : hasCardMoney
                    ? `Unavailable · saved before fee tracking (${pct(cardShare)} paid by card)`
                    : "$0.00 · no card payments",
              ],
              ["Payable tip share", `${money(p.tipPayout)}${snap.cardTipPayout !== undefined ? ` (card ${money(snap.cardTipPayout)} + other ${money(snap.nonCardTipPayout)})` : ""}`],
            ]}
          />
          <div className="flex items-baseline justify-between gap-3 border-t pt-2">
            <span className="font-medium">{provisional ? "Provisional total" : "Final amount owed"}</span>
            <span className="text-lg font-semibold tabular-nums">{notCalculated ? "Not calculated" : money(p.totalPayout)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Snapshot {snap.calcVersion ?? "legacy"} · mode {p.calcMode ?? "—"} · {p.splitCount} technician{p.splitCount === 1 ? "" : "s"} on job · card-paid service {money(p.cardServiceAmount)} · other {money(p.nonCardServiceAmount)} · tips card {money(p.cardTipAmount)} / other {money(p.nonCardTipAmount)}
          </p>
        </Section>

        <Section title="Customer payments" hint="Job-level. These are what the customer paid the business, not what is owed to the technician.">
          {payments.length > 0 ? (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((pay, i) => (
                    <TableRow key={`${pay.id ?? "pay"}-${i}`}>
                      <TableCell className="text-sm">{pay.date ? zonedDateTime(pay.date, timezone) : <span className="text-muted-foreground">No date</span>}</TableCell>
                      <TableCell className="whitespace-normal text-sm">
                        {paymentMethodLabel(pay.method, pay.isCard)}
                        {pay.method && paymentMethodLabel(pay.method, pay.isCard).toLowerCase() !== pay.method.toLowerCase() ? <span className="ml-1 text-xs text-muted-foreground">({pay.method})</span> : null}
                        {pay.methodKnown === false && <span className="ml-1 text-xs text-destructive">not recognised</span>}
                      </TableCell>
                      <TableCell className="text-sm">{pay.isTip ? "Tip" : "Service"}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(pay.amount)}</TableCell>
                      <TableCell className="whitespace-normal text-xs text-muted-foreground">{paymentSourceLabel(pay)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-medium">{PAYMENT_DETAILS_UNAVAILABLE}</p>
              <p className="text-muted-foreground">
                {workizDue !== null
                  ? `Workiz's job API reports only the balance (${money(workizDue)} due of ${money(grandTotal)}), not individual payments or how they were made. ${collectedPerWorkiz !== null && collectedPerWorkiz > 0 ? `Its balance shows ${money(collectedPerWorkiz)} has been collected.` : ""}`.trim()
                  : "Workiz returned neither payment records nor a balance for this job."}
              </p>
            </div>
          )}
          {canConfirmPayments && (
            <PaymentConfirmationForm
              jobUuid={p.jobUuid}
              invoiceTotal={workizInvoiceTotal}
              existing={manualPayments}
              pending={pending}
              onConfirm={paymentHandlers.onConfirmPayments}
              onClear={paymentHandlers.onClearPayments}
            />
          )}
          <Facts
            rows={[
              ["Paid by", methods.count ? `${methods.label}${methods.mixed ? " (mixed)" : ""}${manualPayments.length && !fromWorkiz ? " · confirmed by admin" : ""}` : PAYMENT_DETAILS_UNAVAILABLE],
              ["Invoice subtotal", job?.subTotal != null ? money(job.subTotal) : "Not provided by Workiz"],
              ["Discount", job ? `−${money(job.discountAmount)}` : "Unavailable"],
              ["Tip", job ? money(tipsTotal) : "Unavailable"],
              ["Tax", tax != null ? money(tax) : unitemized > 0.005 ? `${money(unitemized)} · tax/fees not itemized by Workiz` : "Not provided by Workiz"],
              [workizInvoiceTotal !== null ? "Invoice total (Workiz)" : "Invoice total (service + tax)", job ? money(grandTotal) : "Unavailable"],
              ["Payments received", job ? (payments.length ? money(totalPaid) : collectedPerWorkiz !== null ? `${money(collectedPerWorkiz)} · per Workiz balance, payment details unavailable` : money(totalPaid)) : "Unavailable"],
              [
                "Remaining balance",
                job
                  ? job.fullyPaid
                    ? `${money(0)} · paid in full${job.invoiceStatus ? ` (${job.invoiceStatus})` : ""}`
                    : `${money(remaining)}${payments.length === 0 && workizDue !== null ? " · Workiz amount due" : ""}`
                  : "Unavailable",
              ],
            ]}
          />
        </Section>

        <Section title="Review">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Admin note (optional)" rows={2} className="text-sm" aria-label="Admin note" />
          <div className="flex flex-wrap gap-2">
            {p.status !== "ready" && p.status !== "paid" && (
              <Button size="sm" disabled={pending} onClick={() => onAction(p.id, "release", note)}>
                Release
              </Button>
            )}
            {p.status === "ready" && (
              <Button size="sm" disabled={pending} onClick={() => onAction(p.id, "mark-paid", note)}>
                Mark paid
              </Button>
            )}
            {p.status !== "hold" && p.status !== "paid" && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction(p.id, "hold", note)}>
                Hold
              </Button>
            )}
            {p.status === "paid" && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction(p.id, "reopen", note)}>
                Reopen
              </Button>
            )}
            {p.status !== "void" && p.status !== "paid" && (
              <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => onAction(p.id, "void", note)}>
                Void
              </Button>
            )}
          </div>
          {p.status !== "ready" && <InlineMessage tone="info">Mark paid is only available once this payout is Ready.</InlineMessage>}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
      <Separator className="mt-1" />
    </section>
  )
}

function Facts({ rows }: { rows: Array<[string, React.ReactNode] | null> }) {
  const visible = rows.filter(Boolean) as Array<[string, React.ReactNode]>
  if (visible.length === 0) return null
  return (
    <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {visible.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words text-right tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
