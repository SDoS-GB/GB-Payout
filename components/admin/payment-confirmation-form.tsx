"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import type { NormalizedPayment } from "@/lib/db/schema"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MANUAL_PAYMENT_METHODS, type ManualPaymentEntry } from "@/lib/workiz/payments"
import { InlineMessage, money } from "./shared"

type Row = { key: number; method: string; amount: string; tip: string; paidAt: string }

const round2 = (n: number) => Math.round(n * 100) / 100
const parse = (s: string) => Number.parseFloat(s) || 0

/** ISO timestamp -> value for a datetime-local input (local wall clock, no seconds). */
function toLocalInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Stored manual records are split into a service row and a `<id>:tip` row; the form shows
 * them the way Workiz does — one charge with the tip inside it.
 */
function rowsFromExisting(existing: NormalizedPayment[]): Row[] {
  const tips = existing.filter((p) => p.isTip)
  const paired = new Set<number>()
  const rows: Row[] = existing
    .filter((p) => !p.isTip)
    .map((p, i) => {
      const tipIndex = tips.findIndex((t, j) => !paired.has(j) && p.id !== null && t.id === `${p.id}:tip`)
      const tip = tipIndex >= 0 ? tips[tipIndex].amount : 0
      if (tipIndex >= 0) paired.add(tipIndex)
      return { key: i, method: p.method, amount: round2(p.amount + tip).toFixed(2), tip: tip > 0 ? tip.toFixed(2) : "", paidAt: toLocalInput(p.date) }
    })
  tips.forEach((t, j) => {
    // A payment that was entirely tip has no service row of its own.
    if (!paired.has(j)) rows.push({ key: rows.length, method: t.method, amount: t.amount.toFixed(2), tip: t.amount.toFixed(2), paidAt: toLocalInput(t.date) })
  })
  return rows
}

/**
 * Transcribe the Workiz Payments tab for a job whose payment type the API will not return.
 * The rows must add up to the Workiz invoice total; the server re-validates and re-runs the
 * normal sync, so this never bypasses the completion/paid/mapping gates.
 */
export function PaymentConfirmationForm({
  jobUuid,
  invoiceTotal,
  tipCandidate,
  existing,
  pending,
  onConfirm,
  onClear,
}: {
  jobUuid: string
  /** Workiz's JobTotalPrice; null when the snapshot has none. */
  invoiceTotal: number | null
  /** How much of the Workiz total sits above the itemized services and recorded tips — the likely tip. */
  tipCandidate: number
  /** Admin-confirmed records already stored for this job (service and tip rows). */
  existing: NormalizedPayment[]
  pending: boolean
  onConfirm: (jobUuid: string, entries: ManualPaymentEntry[]) => void
  onClear: (jobUuid: string) => void
}) {
  const seed: Row[] = existing.length
    ? rowsFromExisting(existing)
    : [{ key: 0, method: "", amount: invoiceTotal !== null && invoiceTotal > 0 ? invoiceTotal.toFixed(2) : "", tip: tipCandidate > 0.005 ? tipCandidate.toFixed(2) : "", paidAt: "" }]
  const [rows, setRows] = useState<Row[]>(seed)
  const [nextKey, setNextKey] = useState(seed.length)

  const sum = round2(rows.reduce((s, r) => s + parse(r.amount), 0))
  const tipSum = round2(rows.reduce((s, r) => s + parse(r.tip), 0))
  const mismatch = invoiceTotal !== null && invoiceTotal > 0 && Math.abs(sum - invoiceTotal) > 0.05
  const tipTooLarge = rows.some((r) => parse(r.tip) > parse(r.amount) + 0.005)
  const incomplete = rows.some((r) => !r.method || !(parse(r.amount) > 0) || parse(r.tip) < 0)
  // Tips already stored count toward the candidate; only a remaining gap needs the admin's attention.
  const recordedTip = round2(existing.filter((p) => p.isTip).reduce((s, p) => s + p.amount, 0))
  const expectedTip = round2(tipCandidate + recordedTip)
  const tipGap = expectedTip > 0.005 && Math.abs(tipSum - expectedTip) > 0.05

  const update = (key: number, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const remove = (key: number) => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev))
  const add = () => {
    const remaining = invoiceTotal !== null ? round2(Math.max(0, invoiceTotal - sum)) : 0
    setRows((prev) => [...prev, { key: nextKey, method: "", amount: remaining > 0 ? remaining.toFixed(2) : "", tip: "", paidAt: "" }])
    setNextKey((k) => k + 1)
  }
  const submit = () => {
    const entries: ManualPaymentEntry[] = rows.map((r) => ({
      method: r.method,
      amount: parse(r.amount),
      tipAmount: parse(r.tip),
      paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    }))
    onConfirm(jobUuid, entries)
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">Confirm payments from Workiz</p>
        <p className="text-xs text-muted-foreground">
          Open the job&apos;s Payments tab in Workiz and copy each payment here exactly as shown, tip included. Put the tip in the Tip column of the payment it was added to. Only card payments (and card tips) get the 3.5% deduction; cash, check and Zelle do not. Nothing is assumed — leave the method blank and the payout stays on hold.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,5.5rem)_minmax(0,1fr)_auto] items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pay-method-${row.key}`} className="text-xs">
                Method
              </Label>
              <Select value={row.method || undefined} onValueChange={(v) => update(row.key, { method: v })}>
                <SelectTrigger id={`pay-method-${row.key}`} aria-label={`Payment ${i + 1} method`}>
                  <SelectValue placeholder="Choose method" />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pay-amount-${row.key}`} className="text-xs">
                Amount
              </Label>
              <Input id={`pay-amount-${row.key}`} inputMode="decimal" value={row.amount} onChange={(e) => update(row.key, { amount: e.target.value })} className="tabular-nums" aria-label={`Payment ${i + 1} amount`} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pay-tip-${row.key}`} className="text-xs">
                Tip included
              </Label>
              <Input
                id={`pay-tip-${row.key}`}
                inputMode="decimal"
                placeholder="0.00"
                value={row.tip}
                onChange={(e) => update(row.key, { tip: e.target.value })}
                className="tabular-nums"
                aria-label={`Payment ${i + 1} tip included in the amount`}
                aria-invalid={parse(row.tip) > parse(row.amount) + 0.005 || undefined}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`pay-date-${row.key}`} className="text-xs">
                Paid on (optional)
              </Label>
              <Input id={`pay-date-${row.key}`} type="datetime-local" value={row.paidAt} onChange={(e) => update(row.key, { paidAt: e.target.value })} aria-label={`Payment ${i + 1} date`} />
            </div>
            <Button type="button" size="icon" variant="ghost" onClick={() => remove(row.key)} disabled={rows.length === 1 || pending} aria-label={`Remove payment ${i + 1}`}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <Button type="button" size="sm" variant="outline" onClick={add} disabled={pending}>
          <Plus className="size-3.5" />
          Add another payment
        </Button>
        <span className="tabular-nums">
          Entered {money(sum)}
          {invoiceTotal !== null && invoiceTotal > 0 ? ` of ${money(invoiceTotal)} Workiz total` : ""}
          {tipSum > 0 ? ` · ${money(tipSum)} of it tip` : ""}
        </span>
      </div>

      {mismatch && <InlineMessage tone="error">The payments must add up to the Workiz total. Enter every payment shown on the Workiz Payments tab, tip included.</InlineMessage>}
      {tipTooLarge && <InlineMessage tone="error">A tip cannot be larger than the payment it is part of. Enter the amount as Workiz shows it (tip included) and the tip portion beside it.</InlineMessage>}
      {!mismatch && tipGap && (
        <InlineMessage tone="info">
          Workiz&apos;s total is {money(expectedTip)} above the itemized services. Its API does not send the Tip field, so that is most likely the tip{tipSum > 0 ? ` — you have entered ${money(tipSum)}` : ""}. Leave it out only if the customer was charged something other than a tip; the payout stays on hold until the numbers agree.
        </InlineMessage>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending || incomplete || mismatch || tipTooLarge}>
          {existing.length ? "Update confirmation & re-sync" : "Confirm payments & re-sync"}
        </Button>
        {existing.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onClear(jobUuid)} disabled={pending}>
            Clear confirmation
          </Button>
        )}
      </div>
    </div>
  )
}
