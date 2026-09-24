"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, ChevronDown, ChevronUp, Undo2 } from "lucide-react"
import type { AdminDashboardData, DueTechnician, PayoutRecord, RecordPaidOutcome, SourceChangeRow, WaitingSummary } from "@/app/actions/admin"
import { acknowledgeSourceChange, recordPaidBatch, undoPaymentBatch } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DEFAULT_TECH_PAYMENT_METHOD, isoDateInZone } from "@/lib/payout/batch-rules"
import { OpeningBalanceCard } from "./opening-balance-card"
import { InlineMessage, money, zonedDate } from "./shared"

type Props = {
  due: AdminDashboardData["due"]
  waiting: WaitingSummary
  sourceChanges: SourceChangeRow[]
  opening: AdminDashboardData["opening"]
  paymentMethods: readonly string[]
  timezone: string
  /** Technician whose card should scroll into view (set when arriving from a payout's detail panel). */
  focusProfileId: number | null
  focusToken: number
  onOpenReview: (status: "hold" | "pending") => void
  onOpenBatch: (batchId: number) => void
}

export function DueTab({ due, waiting, sourceChanges, opening, paymentMethods, timezone, focusProfileId, focusToken, onOpenReview, onOpenBatch }: Props) {
  const router = useRouter()
  const totalDue = due.technicians.reduce((cents, t) => cents + Math.round(t.total * 100), 0) / 100
  const waitingTotal = waiting.customerUnpaid + waiting.notFinished + waiting.methodReview + waiting.openingReview + waiting.otherHolds

  return (
    <div className="flex flex-col gap-4">
      {!opening.openingInitializedAt && <OpeningBalanceCard timezone={timezone} onDone={() => router.refresh()} />}

      {sourceChanges.length > 0 && <SourceChangesCard rows={sourceChanges} timezone={timezone} onOpenBatch={onOpenBatch} />}

      <section aria-label="Due by technician" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Due now</h2>
            <p className="text-sm text-muted-foreground">
              {due.technicians.length === 0
                ? "Nobody is owed anything right now."
                : `${money(totalDue)} across ${due.technicians.length} technician${due.technicians.length === 1 ? "" : "s"} · pay one technician at a time, then click Paid.`}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">Amounts are what the app calculated from Workiz; pay the exact total shown.</p>
        </div>

        {due.technicians.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <CheckCircle2 className="h-8 w-8 text-primary" aria-hidden="true" />
              <p className="font-medium">All caught up</p>
              <p className="max-w-md text-sm text-muted-foreground">
                A payout becomes due when the Workiz job is finished, the customer has paid in full, and every team member on the job is mapped. New ones appear here after the next sync.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {due.technicians.map((t) => (
              <TechnicianCard key={t.profileId} tech={t} timezone={timezone} paymentMethods={paymentMethods} focused={focusProfileId === t.profileId} focusToken={focusToken} onOpenBatch={onOpenBatch} />
            ))}
          </div>
        )}
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Not due yet</CardTitle>
          <CardDescription>{waitingTotal === 0 ? "Every open payout is either due or settled." : `${waitingTotal} open payout${waitingTotal === 1 ? "" : "s"} still waiting on something.`}</CardDescription>
        </CardHeader>
        {waitingTotal > 0 && (
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <WaitingRow count={waiting.customerUnpaid} label="Customer has not paid in full" detail="Finished in Workiz, balance still open. Becomes due when Workiz shows it paid." onClick={() => onOpenReview("pending")} />
            <WaitingRow count={waiting.notFinished} label="Job not finished" detail="Still scheduled or in progress in Workiz." onClick={() => onOpenReview("pending")} />
            <WaitingRow count={waiting.methodReview} label="Payment method needs your call" detail="Workiz recorded 'Other' or nothing. Confirm how the customer paid so card fees apply correctly." tone="warn" onClick={() => onOpenReview("hold")} />
            <WaitingRow count={waiting.openingReview} label="Pre-cutoff work found after setup" detail="Finished before your opening-balance cutoff. Confirm previously paid, or release it." tone="warn" onClick={() => onOpenReview("hold")} />
            <WaitingRow count={waiting.otherHolds} label="Other holds" detail="Unmapped team member, tip split, discount or calculation check." tone="warn" onClick={() => onOpenReview("hold")} />
          </CardContent>
        )}
      </Card>
    </div>
  )
}

function WaitingRow({ count, label, detail, tone = "muted", onClick }: { count: number; label: string; detail: string; tone?: "muted" | "warn"; onClick: () => void }) {
  if (count === 0) return null
  return (
    <button type="button" onClick={onClick} className="flex items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className={`min-w-8 text-xl font-semibold tabular-nums ${tone === "warn" ? "text-warning-foreground" : "text-foreground"}`}>{count}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}

/**
 * One technician: every due job, a total, and the form that records the payment. The selection
 * defaults to everything due so the normal path is "pay the total, click Paid"; unticking a job
 * keeps it due for next time.
 */
function TechnicianCard({ tech, timezone, paymentMethods, focused, focusToken, onOpenBatch }: { tech: DueTechnician; timezone: string; paymentMethods: readonly string[]; focused: boolean; focusToken: number; onOpenBatch: (batchId: number) => void }) {
  const router = useRouter()
  const ref = useRef<HTMLDivElement>(null)
  const [pending, startTransition] = useTransition()
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [method, setMethod] = useState<string>(DEFAULT_TECH_PAYMENT_METHOD)
  const [paidOn, setPaidOn] = useState(() => isoDateInZone(new Date(), timezone))
  const [reference, setReference] = useState("")
  const [showJobs, setShowJobs] = useState(tech.count <= 8)
  const [result, setResult] = useState<{ tone: "ok" | "error" | "info"; text: string; batchId?: number; undone?: boolean } | null>(null)
  // A fresh key per selection so a double click or a retry after a network blip records one payment.
  const keyRef = useRef(newKey())

  useEffect(() => {
    if (focused && focusToken > 0) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [focused, focusToken])

  // Rows that left the board (paid elsewhere, held) drop out of the exclusion set on their own.
  useEffect(() => {
    const ids = new Set(tech.jobs.map((j) => j.id))
    setExcluded((prev) => {
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
    keyRef.current = newKey()
  }, [tech.jobs])

  const selected = tech.jobs.filter((j) => !excluded.has(j.id))
  const selectedTotal = selected.reduce((cents, j) => cents + Math.round(j.amount * 100), 0) / 100
  const today = isoDateInZone(new Date(), timezone)

  const toggle = (id: number, on: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (on) next.delete(id)
      else next.add(id)
      return next
    })
    keyRef.current = newKey()
  }

  const pay = () =>
    startTransition(async () => {
      setResult(null)
      const res: RecordPaidOutcome = await recordPaidBatch({
        profileId: tech.profileId,
        items: selected.map((j) => ({ payoutId: j.id, amount: j.amount, inputHash: j.inputHash ?? null })),
        method,
        paidOn,
        reference: reference.trim() || null,
        idempotencyKey: keyRef.current,
      })
      if (!res.ok) {
        setResult({ tone: "error", text: res.error })
        if (res.stale) router.refresh()
        return
      }
      const d = res.data
      setResult({ tone: "ok", text: `${money(d.total)} to ${d.profileName} by ${d.method} on ${d.paidOn} recorded as payment #${d.batchId} (${d.count} job${d.count === 1 ? "" : "s"}).`, batchId: d.batchId })
      setReference("")
      keyRef.current = newKey()
      router.refresh()
    })

  const undo = (batchId: number) =>
    startTransition(async () => {
      const res = await undoPaymentBatch(batchId, "Undone right after recording")
      if (!res.ok) return setResult({ tone: "error", text: res.error })
      setResult({ tone: "info", text: `Payment #${batchId} undone; ${res.data!.payouts} job${res.data!.payouts === 1 ? "" : "s"} returned to Due.`, undone: true })
      router.refresh()
    })

  return (
    <div ref={ref} className={`scroll-mt-4 rounded-lg border bg-card ${focused ? "ring-2 ring-primary/40" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-lg font-semibold">{tech.name}</h3>
          <p className="text-sm text-muted-foreground">
            {tech.count} job{tech.count === 1 ? "" : "s"} due · oldest {zonedDate(tech.jobs[0]?.job?.lastStatusUpdate ?? tech.jobs[0]?.updatedAt, timezone)}
          </p>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{excluded.size ? "Selected" : "Total due"}</span>
          <span className="text-2xl font-semibold tabular-nums text-primary">{money(selectedTotal)}</span>
          {excluded.size > 0 && <span className="text-xs text-muted-foreground">of {money(tech.total)} due</span>}
        </div>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <button type="button" onClick={() => setShowJobs((v) => !v)} className="flex items-center justify-between text-sm font-medium text-muted-foreground hover:text-foreground" aria-expanded={showJobs}>
          <span>{showJobs ? "Hide" : "Show"} jobs</span>
          {showJobs ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {showJobs && (
          <ul className="flex flex-col divide-y rounded-md border">
            {tech.jobs.map((j) => (
              <JobLine key={j.id} p={j} timezone={timezone} checked={!excluded.has(j.id)} onCheck={(on) => toggle(j.id, on)} disabled={pending} />
            ))}
          </ul>
        )}
      </div>

      <form
        className="flex flex-col gap-3 border-t bg-muted/30 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          pay()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`method-${tech.profileId}`}>Paid by</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id={`method-${tech.profileId}`}>
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
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`paidon-${tech.profileId}`}>Paid on</Label>
            <Input id={`paidon-${tech.profileId}`} type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`ref-${tech.profileId}`}>Reference (optional)</Label>
            <Input id={`ref-${tech.profileId}`} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Zelle confirmation, check #" />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {selected.length === 0 ? "Tick at least one job to record a payment." : `Records ${selected.length} of ${tech.count} job${tech.count === 1 ? "" : "s"} as paid at exactly ${money(selectedTotal)}.`}
          </p>
          <Button type="submit" disabled={pending || selected.length === 0}>
            {pending ? "Recording…" : `Paid ${money(selectedTotal)}`}
          </Button>
        </div>
        {result && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <InlineMessage tone={result.tone}>{result.text}</InlineMessage>
            {result.batchId && !result.undone && (
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => onOpenBatch(result.batchId!)}>
                  View in Paid history
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => undo(result.batchId!)}>
                  <Undo2 className="h-4 w-4" />
                  Undo
                </Button>
              </div>
            )}
          </div>
        )}
      </form>
    </div>
  )
}

function JobLine({ p, timezone, checked, onCheck, disabled }: { p: PayoutRecord; timezone: string; checked: boolean; onCheck: (on: boolean) => void; disabled: boolean }) {
  const id = `due-${p.id}`
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onCheck(Boolean(v))} aria-label={`Include job ${p.job?.serialId ?? p.jobUuid}`} />
      <label htmlFor={id} className="flex flex-1 cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <span className="flex flex-col">
          <span className="font-medium">
            #{p.job?.serialId ?? "—"} <span className="font-normal text-muted-foreground">· {p.job?.clientName ?? "Unknown customer"}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            Completed {zonedDate(p.job?.lastStatusUpdate ?? p.updatedAt, timezone)}
            {p.siblings.length > 0 && ` · shared with ${p.siblings.map((s) => s.profileName).join(", ")}`}
          </span>
        </span>
        <span className={`tabular-nums font-medium ${checked ? "" : "text-muted-foreground line-through"}`}>{money(p.amount)}</span>
      </label>
    </li>
  )
}

/** Settled payouts whose Workiz inputs changed afterwards. Nothing is altered until the owner decides. */
function SourceChangesCard({ rows, timezone, onOpenBatch }: { rows: SourceChangeRow[]; timezone: string; onOpenBatch: (batchId: number) => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const ack = (id: number) =>
    startTransition(async () => {
      setError(null)
      const res = await acknowledgeSourceChange(id)
      if (!res.ok) return setError(res.error)
      router.refresh()
    })
  return (
    <Card className="border-warning/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-warning-foreground">Paid jobs changed in Workiz</CardTitle>
        <CardDescription>
          These payouts were already paid, then the job changed in Workiz (a payment, line item or team edit). The paid amount stays as recorded. If the technician is owed a difference, settle it outside the
          app or undo the original payment from Paid history so it comes back Due at the new amount.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        <ul className="flex flex-col divide-y rounded-md border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex flex-col">
                <span className="font-medium">
                  #{r.serialId ?? "—"} · {r.clientName ?? "Unknown customer"} · {r.profileName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {r.summary ?? "Inputs changed"} · paid {money(r.settledAmount)} → now calculates {money(r.recomputedAmount)} · noticed {zonedDate(r.detectedAt, timezone)}
                </span>
              </span>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => ack(r.id)}>
                Reviewed
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Undo lives in <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => onOpenBatch(0)}>Paid history</button>.
        </p>
      </CardContent>
    </Card>
  )
}

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}
