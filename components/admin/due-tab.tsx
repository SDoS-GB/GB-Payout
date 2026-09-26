"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, ChevronDown, ExternalLink, Info } from "lucide-react"
import type { AdminDashboardData, DueTechnician, PayoutRecord, RecordPaidOutcome } from "@/app/actions/admin"
import { clearConfirmedPayments, confirmJobPayments, confirmPreviouslyPaidPayouts, recordPaidBatch, reviewPayout } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DEFAULT_TECH_PAYMENT_METHOD, isoDateInZone } from "@/lib/payout/batch-rules"
import { customerPaymentMethod, groupCustomerPayments, jobMoneySummary, jobTotalQualifier } from "@/lib/payout/due-presentation"
import { initialSelection, reconcileSelection, selectedJobs as pickSelected, selectedTotal, setAllTicked, setTicked, type DueSelectableJob, type DueSelection } from "@/lib/payout/due-selection"
import { PAYMENT_DETAILS_UNAVAILABLE, workizJobUrl } from "@/lib/payout/presentation"
import { PayoutDetailSheet } from "./payout-detail-sheet"
import { InlineMessage, money, zonedDate, zonedDateTime } from "./shared"

type Props = {
  due: AdminDashboardData["due"]
  paymentMethods: readonly string[]
  timezone: string
  /** Technician whose card should scroll into view (set when arriving from a payout's detail panel). */
  focusProfileId: number | null
  focusToken: number
  /** A payment was recorded on the server; open it in Paid history. */
  onPaid: (batchId: number) => void
  onOpenBatch: (batchId: number) => void
}

export function DueTab({ due, paymentMethods, timezone, focusProfileId, focusToken, onPaid, onOpenBatch }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [detailId, setDetailId] = useState<number | null>(null)
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)

  const allJobs = due.technicians.flatMap((t) => t.jobs)
  const detail = detailId != null ? allJobs.find((j) => j.id === detailId) ?? null : null

  // Close the panel when its payout leaves Due (paid, held or voided).
  useEffect(() => {
    if (detailId != null && !allJobs.some((j) => j.id === detailId)) setDetailId(null)
  }, [allJobs, detailId])

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) =>
    startTransition(async () => {
      setMessage(null)
      const res = await fn()
      if (!res.ok) return setMessage({ tone: "error", text: res.error ?? "Failed" })
      setMessage({ tone: "ok", text: okText })
      router.refresh()
    })

  return (
    <div className="flex flex-col gap-4">
      {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}

      {due.technicians.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CheckCircle2 className="h-8 w-8 text-primary" aria-hidden="true" />
            <p className="font-medium">Nobody is owed anything right now</p>
            <p className="max-w-md text-sm text-muted-foreground">A payout becomes due when the Workiz job is finished, the customer has paid in full, and every team member on the job is mapped.</p>
          </CardContent>
        </Card>
      ) : (
        <section aria-label="Due by technician" className="grid gap-4 lg:grid-cols-2">
          {due.technicians.map((t) => (
            <TechnicianCard
              key={t.profileId}
              tech={t}
              timezone={timezone}
              paymentMethods={paymentMethods}
              focused={focusProfileId === t.profileId}
              focusToken={focusToken}
              onPaid={onPaid}
              onOpenDetail={setDetailId}
            />
          ))}
        </section>
      )}

      <PayoutDetailSheet
        record={detail}
        open={detail != null}
        onOpenChange={(o) => {
          if (!o) setDetailId(null)
        }}
        timezone={timezone}
        pending={pending}
        handlers={{
          onAction: (id, action, note) => act(() => reviewPayout(id, action, note), `Payout #${id}: ${action}`),
          payments: {
            onConfirmPayments: (jobUuid, entries) => act(() => confirmJobPayments(jobUuid, entries), "Payments confirmed and job re-synced"),
            onClearPayments: (jobUuid) => act(() => clearConfirmedPayments(jobUuid), "Payment confirmation cleared and job re-synced"),
          },
          onConfirmPreviouslyPaid: (id) => act(() => confirmPreviouslyPaidPayouts([id]), `Payout #${id} recorded as previously paid`),
          onOpenBatch,
        }}
      />
    </div>
  )
}

const selectable = (p: PayoutRecord): DueSelectableJob => ({ id: p.id, amount: p.amount, label: `#${p.job?.serialId ?? p.id}` })

/**
 * One technician: every due job as a compact row (ticked by default), the total of the ticked
 * rows at the top, and the PAID action for exactly those rows. Every new batch starts on Zelle.
 */
function TechnicianCard({
  tech,
  timezone,
  paymentMethods,
  focused,
  focusToken,
  onPaid,
  onOpenDetail,
}: {
  tech: DueTechnician
  timezone: string
  paymentMethods: readonly string[]
  focused: boolean
  focusToken: number
  onPaid: (batchId: number) => void
  onOpenDetail: (payoutId: number) => void
}) {
  const router = useRouter()
  const ref = useRef<HTMLDivElement>(null)
  const [pending, startTransition] = useTransition()
  const jobs = tech.jobs.map(selectable)
  const [selection, setSelection] = useState<DueSelection>(() => initialSelection(jobs))
  const selectionRef = useRef(selection)
  const [method, setMethod] = useState<string>(DEFAULT_TECH_PAYMENT_METHOD)
  const [paidOn, setPaidOn] = useState(() => isoDateInZone(new Date(), timezone))
  const [reference, setReference] = useState("")
  const [showOptions, setShowOptions] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // A fresh key per selection so a double tap or a retry after a network blip records one payment.
  const keyRef = useRef(newKey())

  const commit = (next: DueSelection) => {
    selectionRef.current = next
    setSelection(next)
    keyRef.current = newKey()
  }

  useEffect(() => {
    if (focused && focusToken > 0) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [focused, focusToken])

  // After a refresh: keep deliberate unticks, tick new jobs, drop jobs that left, flag changed amounts.
  useEffect(() => {
    const out = reconcileSelection(
      selectionRef.current,
      tech.jobs.map(selectable),
      money,
    )
    if (!out.changed) return
    commit(out.selection)
    if (out.notice) setNotice(out.notice)
  }, [tech.jobs])

  const selectedRecords = pickSelected(selection, tech.jobs)
  const selectedCount = selectedRecords.length
  const total = selectedTotal(selection, jobs)
  const allSelected = selectedCount === tech.jobs.length && tech.jobs.length > 0
  const today = isoDateInZone(new Date(), timezone)

  const tick = (job: PayoutRecord, on: boolean) => {
    setNotice(null)
    commit(setTicked(selectionRef.current, selectable(job), on))
  }

  const toggleAll = () => {
    setNotice(null)
    commit(setAllTicked(jobs, !allSelected))
  }

  const pay = () => {
    if (pending || selectedCount === 0) return
    startTransition(async () => {
      setError(null)
      const res: RecordPaidOutcome = await recordPaidBatch({
        profileId: tech.profileId,
        items: selectedRecords.map((j) => ({ payoutId: j.id, amount: j.amount, inputHash: j.inputHash ?? null })),
        method,
        paidOn,
        reference: reference.trim() || null,
        idempotencyKey: keyRef.current,
      })
      if (!res.ok) {
        setError(res.error)
        if (res.stale) router.refresh()
        return
      }
      commit({ ticked: new Map(), unticked: new Set() })
      setMethod(DEFAULT_TECH_PAYMENT_METHOD)
      setReference("")
      setPaidOn(isoDateInZone(new Date(), timezone))
      setShowOptions(false)
      router.refresh()
      onPaid(res.data.batchId)
    })
  }

  const jobWord = tech.count === 1 ? "job" : "jobs"

  return (
    <div ref={ref} className={`flex scroll-mt-28 flex-col rounded-lg border bg-card shadow-sm ${focused ? "ring-2 ring-primary/40" : ""}`}>
      <div className="flex flex-col gap-2 p-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-xl font-semibold">{tech.name}</h2>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {selectedCount} of {tech.count} {jobWord} selected
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">To pay</span>
            <span className="text-2xl font-semibold tabular-nums text-primary">{money(total)}</span>
          </div>
        </div>
        {tech.jobs.length > 1 && (
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={toggleAll} disabled={pending} className="-mr-2 min-h-10">
              {allSelected ? "Clear all" : "Select all"}
            </Button>
          </div>
        )}
      </div>

      <ul aria-label={`${tech.name}'s due jobs`} className="flex flex-col divide-y border-t">
        {tech.jobs.map((j) => (
          <JobRow key={j.id} p={j} techName={tech.name} timezone={timezone} checked={selection.ticked.has(j.id)} disabled={pending} onCheck={(on) => tick(j, on)} onMore={() => onOpenDetail(j.id)} />
        ))}
      </ul>

      <form
        className="mt-auto flex flex-col gap-2 border-t bg-muted/30 p-3 sm:p-4"
        onSubmit={(e) => {
          e.preventDefault()
          pay()
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {selectedCount === 0 ? "Tick a job above to pay" : `Pay ${money(total)} with`}
          </p>
          <div className="flex items-center gap-2">
            <Select value={method} onValueChange={setMethod} disabled={pending}>
              <SelectTrigger aria-label={`How ${tech.name} is paid`} className="h-12 w-28 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paymentMethods.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="submit"
              disabled={pending || selectedCount === 0}
              aria-busy={pending}
              aria-label={selectedCount === 0 ? "PAID (tick a job first)" : `PAID: record ${money(total)} to ${tech.name}`}
              className="h-12 min-w-28 px-6 text-base font-bold tracking-wide bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-primary"
            >
              {pending ? "Saving…" : "PAID"}
            </Button>
          </div>
        </div>

        <button type="button" onClick={() => setShowOptions((v) => !v)} aria-expanded={showOptions} className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline">
          {showOptions ? "Hide options" : "Note or earlier date"}
        </button>
        {showOptions && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`paidon-${tech.profileId}`}>Paid on</Label>
              <Input id={`paidon-${tech.profileId}`} type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required className="bg-card" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`ref-${tech.profileId}`}>Note / reference</Label>
              <Input id={`ref-${tech.profileId}`} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Zelle confirmation, check #" className="bg-card" />
            </div>
          </div>
        )}
        {notice && <InlineMessage tone="info">{notice}</InlineMessage>}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
      </form>
    </div>
  )
}

/**
 * One due job. The summary row is always visible: tick box, customer name (opens the Workiz job),
 * this technician's payout, completion date, and a chevron for the breakdown. Each control does
 * exactly one thing. The breakdown starts collapsed on every page opening.
 */
function JobRow({ p, techName, timezone, checked, disabled, onCheck, onMore }: { p: PayoutRecord; techName: string; timezone: string; checked: boolean; disabled: boolean; onCheck: (on: boolean) => void; onMore: () => void }) {
  const [open, setOpen] = useState(false)
  const checkboxId = `due-${p.id}`
  const detailsId = `due-${p.id}-details`
  const job = p.job
  const url = workizJobUrl(p.jobUuid)
  const serial = job?.serialId ?? null
  const customer = job?.clientName?.trim() || "Unknown customer"
  // The link icon travels with the last word so a wrapped name never leaves it orphaned on its own line.
  const lastSpace = customer.lastIndexOf(" ")
  const nameHead = lastSpace === -1 ? "" : customer.slice(0, lastSpace + 1)
  const nameLast = lastSpace === -1 ? customer : customer.slice(lastSpace + 1)
  const summary = job
    ? jobMoneySummary({ jobTotal: job.jobTotal, taxAmount: job.taxAmount, discountAmount: job.discountAmount, colorSealTotal: job.colorSealTotal, cardTipAmount: job.cardTipAmount, nonCardTipAmount: job.nonCardTipAmount, invoiceTotal: job.invoiceTotal })
    : null
  const payments = groupCustomerPayments(job?.payments)
  const techTip = Number(p.tipPayout ?? 0)
  const completed = p.completion?.state === "completed" ? p.completion.at : null
  const completedLabel = completed ? `Completed ${zonedDate(completed, timezone)}` : "No completion date from Workiz"

  return (
    <li className={checked ? "bg-accent/30" : ""}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-1 py-1 pl-1 pr-1 sm:pl-2 sm:pr-2">
        <label htmlFor={checkboxId} className="flex h-11 w-11 cursor-pointer items-center justify-center">
          <Checkbox id={checkboxId} checked={checked} disabled={disabled} onCheckedChange={(v) => onCheck(Boolean(v))} aria-label={`Pay ${techName} for ${customer}${serial ? ` (job #${serial})` : ""}`} className="h-5 w-5" />
        </label>

        <div className="flex min-w-0 flex-col gap-0.5 py-2.5">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${customer}${serial ? `, job #${serial},` : ""} in Workiz (new tab)`}
              className="self-start break-words text-base font-medium leading-snug text-foreground underline decoration-primary/50 decoration-2 underline-offset-4 hover:decoration-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {nameHead}
              <span className="whitespace-nowrap">
                {nameLast}
                <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-0.125em] text-primary" aria-hidden="true" />
              </span>
            </a>
          ) : (
            <span className="break-words text-base font-medium leading-snug">{customer}</span>
          )}
          <p className="text-sm text-muted-foreground">{completedLabel}</p>
        </div>

        <div className="flex items-start">
          <span className="pt-2.5 text-base font-medium tabular-nums text-muted-foreground">
            <span className="sr-only">Payout to {techName}: </span>
            {money(p.amount)}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? "Hide" : "Show"} details for ${customer}`}
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {open && (
        <div id={detailsId} className="flex flex-col gap-3 px-3 pb-4 pt-1 sm:px-4 sm:pl-14">
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {url && serial ? (
              <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open job ${serial} in Workiz (new tab)`}>
                Job #{serial}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : (
              <span>Job #{serial ?? "—"}</span>
            )}
            {!completed && job?.status && <span>· status {job.status}</span>}
            {p.siblings.length > 0 && <span>· shared with {p.siblings.map((s) => s.profileName).join(", ")}</span>}
            <span>
              · Owed to {techName}: <span className="font-medium tabular-nums text-foreground">{money(p.amount)}</span>
            </span>
          </p>

          {summary ? (
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm">
              <dt className="text-muted-foreground">
                Job total <span className="text-xs">· {jobTotalQualifier(summary)}</span>
              </dt>
              <dd className="text-right font-medium tabular-nums">{money(summary.jobTotal)}</dd>
              <dt className="text-muted-foreground">
                Color sealing <span className="text-xs">· after discount</span>
              </dt>
              <dd className="text-right tabular-nums">{summary.colorSealAfterDiscount > 0 ? money(summary.colorSealAfterDiscount) : "—"}</dd>
              <dt className="text-muted-foreground">Discount</dt>
              <dd className="text-right tabular-nums">{summary.discount > 0 ? `−${money(summary.discount)}` : "—"}</dd>
              <dt className="text-muted-foreground">
                Tip <span className="text-xs">· customer total{techTip > 0 ? `, ${money(techTip)} of it to ${techName}` : ""}</span>
              </dt>
              <dd className="text-right tabular-nums">{summary.tip > 0 ? money(summary.tip) : "—"}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Workiz job details are not stored for this payout.</p>
          )}

          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Customer payments</p>
            {payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{PAYMENT_DETAILS_UNAVAILABLE} from Workiz</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {payments.map((line) => (
                  <li key={line.key} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3">
                    <span className="font-medium">{line.label}</span>
                    <span className="min-w-0 text-muted-foreground">
                      {customerPaymentMethod(line)}
                      {!line.methodKnown && <span className="text-warning-foreground"> (not recognised)</span>}
                      {" · "}
                      {line.date ? zonedDateTime(line.date, timezone) : <span className="italic">date not recorded</span>}
                      {line.tipAmount > 0 && !line.tipOnly && <span> · incl. {money(line.tipAmount)} tip</span>}
                    </span>
                    <span className="tabular-nums">{money(line.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <button type="button" onClick={onMore} className="inline-flex min-h-8 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
              More details
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}
