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

type Row = { key: number; method: string; amount: string; paidAt: string }

const round2 = (n: number) => Math.round(n * 100) / 100

/** ISO timestamp -> value for a datetime-local input (local wall clock, no seconds). */
function toLocalInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Transcribe the Workiz Payments tab for a job whose payment type the API will not return.
 * The rows must add up to the Workiz invoice total; the server re-validates and re-runs the
 * normal sync, so this never bypasses the completion/paid/mapping gates.
 */
export function PaymentConfirmationForm({
  jobUuid,
  invoiceTotal,
  existing,
  pending,
  onConfirm,
  onClear,
}: {
  jobUuid: string
  /** Workiz's JobTotalPrice; null when the snapshot has none. */
  invoiceTotal: number | null
  /** Admin-confirmed records already stored for this job (service rows only). */
  existing: NormalizedPayment[]
  pending: boolean
  onConfirm: (jobUuid: string, entries: ManualPaymentEntry[]) => void
  onClear: (jobUuid: string) => void
}) {
  const seed: Row[] = existing.length
    ? existing.map((p, i) => ({ key: i, method: p.method, amount: p.amount.toFixed(2), paidAt: toLocalInput(p.date) }))
    : [{ key: 0, method: "", amount: invoiceTotal !== null && invoiceTotal > 0 ? invoiceTotal.toFixed(2) : "", paidAt: "" }]
  const [rows, setRows] = useState<Row[]>(seed)
  const [nextKey, setNextKey] = useState(seed.length)

  const sum = round2(rows.reduce((s, r) => s + (Number.parseFloat(r.amount) || 0), 0))
  const mismatch = invoiceTotal !== null && invoiceTotal > 0 && Math.abs(sum - invoiceTotal) > 0.05
  const incomplete = rows.some((r) => !r.method || !(Number.parseFloat(r.amount) > 0))

  const update = (key: number, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const remove = (key: number) => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev))
  const add = () => {
    const remaining = invoiceTotal !== null ? round2(Math.max(0, invoiceTotal - sum)) : 0
    setRows((prev) => [...prev, { key: nextKey, method: "", amount: remaining > 0 ? remaining.toFixed(2) : "", paidAt: "" }])
    setNextKey((k) => k + 1)
  }
  const submit = () => {
    const entries: ManualPaymentEntry[] = rows.map((r) => ({
      method: r.method,
      amount: Number.parseFloat(r.amount),
      paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    }))
    onConfirm(jobUuid, entries)
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">Confirm payments from Workiz</p>
        <p className="text-xs text-muted-foreground">
          Open the job&apos;s Payments tab in Workiz and copy each payment here. Only card payments get the 3.5% deduction; cash, check and Zelle do not. Nothing is assumed — leave the method blank and the payout stays on hold.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)_minmax(0,1fr)_auto] items-end gap-2">
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
          {invoiceTotal !== null && invoiceTotal > 0 ? ` of ${money(invoiceTotal)} Workiz invoice total` : ""}
        </span>
      </div>

      {mismatch && <InlineMessage tone="error">The payments must add up to the Workiz invoice total. Enter every payment shown on the Workiz Payments tab.</InlineMessage>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending || incomplete || mismatch}>
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
