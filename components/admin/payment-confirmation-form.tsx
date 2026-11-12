"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import type { NormalizedPayment } from "@/lib/db/schema"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { confirmationSeedRows } from "@/lib/payout/payment-confirmation"
import { MANUAL_PAYMENT_METHODS, type ManualPaymentEntry } from "@/lib/workiz/payments"
import { InlineMessage, money } from "./shared"

type Row = { key: number; method: string; amount: string; tip: string; paidAt: string; workizMethod: string | null }

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
 * On a phone the keyboard covers the lower half of the screen without resizing the page, so a
 * field focused near the bottom of the panel would sit underneath it. Whenever a text field in
 * the form takes focus, or the visible area changes while one has it, bring that field to the
 * middle of what is left.
 */
function useKeepFocusedFieldVisible(container: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const reveal = () => {
      const active = document.activeElement
      if (active instanceof HTMLElement && active.matches("input, textarea") && container.current?.contains(active)) {
        active.scrollIntoView({ block: "center", behavior: "smooth" })
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const afterKeyboard = () => {
      clearTimeout(timer)
      timer = setTimeout(reveal, 250)
    }
    const node = container.current
    node?.addEventListener("focusin", afterKeyboard)
    window.visualViewport?.addEventListener("resize", reveal)
    return () => {
      clearTimeout(timer)
      node?.removeEventListener("focusin", afterKeyboard)
      window.visualViewport?.removeEventListener("resize", reveal)
    }
  }, [container])
}

/**
 * Transcribe the Workiz Payments tab for a job whose payments need a person: the API returned
 * none, or one whose method the app does not recognise. Each payment is its own block with the
 * Method first. The rows must add up to the Workiz invoice total; the server re-validates and
 * re-runs the normal sync, so this never bypasses the completion/paid/mapping gates.
 */
export function PaymentConfirmationForm({
  jobUuid,
  invoiceTotal,
  tipCandidate,
  existing,
  reported,
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
  /** Payments Workiz itself reported, used to fill the form in when nothing is confirmed yet. */
  reported: NormalizedPayment[]
  pending: boolean
  onConfirm: (jobUuid: string, entries: ManualPaymentEntry[]) => void
  onClear: (jobUuid: string) => void
}) {
  const headingId = useId()
  const formRef = useRef<HTMLElement>(null)
  useKeepFocusedFieldVisible(formRef)

  const [rows, setRows] = useState<Row[]>(() => {
    const seeded = confirmationSeedRows(existing, reported)
    if (seeded.length === 0) {
      return [{ key: 0, method: "", amount: invoiceTotal !== null && invoiceTotal > 0 ? invoiceTotal.toFixed(2) : "", tip: tipCandidate > 0.005 ? tipCandidate.toFixed(2) : "", paidAt: "", workizMethod: null }]
    }
    return seeded.map((r, i) => ({ key: i, method: r.method, amount: r.amount.toFixed(2), tip: r.tip > 0 ? r.tip.toFixed(2) : "", paidAt: toLocalInput(r.paidAt), workizMethod: r.workizMethod }))
  })
  const [nextKey, setNextKey] = useState(rows.length)
  // Which row's Method dropdown is open. Controlled so Escape can close the dropdown itself:
  // the review panel swallows that key while a dropdown is open so it does not close instead,
  // and its focus trap can leave the key outside the dropdown, hence the document listener.
  const [openMethod, setOpenMethod] = useState<number | null>(null)
  useEffect(() => {
    if (openMethod === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMethod(null)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [openMethod])

  const prefilledFromWorkiz = existing.length === 0 && reported.length > 0
  const sum = round2(rows.reduce((s, r) => s + parse(r.amount), 0))
  const tipSum = round2(rows.reduce((s, r) => s + parse(r.tip), 0))
  const mismatch = invoiceTotal !== null && invoiceTotal > 0 && Math.abs(sum - invoiceTotal) > 0.05
  const tipTooLarge = rows.some((r) => parse(r.tip) > parse(r.amount) + 0.005)
  const missingMethod = rows.filter((r) => !r.method).length
  const incomplete = missingMethod > 0 || rows.some((r) => !(parse(r.amount) > 0) || parse(r.tip) < 0)
  // Tips already stored count toward the candidate; only a remaining gap needs the admin's attention.
  const recordedTip = round2((existing.length ? existing : reported).filter((p) => p.isTip).reduce((s, p) => s + p.amount, 0))
  const expectedTip = round2(tipCandidate + recordedTip)
  const tipGap = expectedTip > 0.005 && Math.abs(tipSum - expectedTip) > 0.05

  const update = (key: number, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const remove = (key: number) => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev))
  const add = () => {
    const remaining = invoiceTotal !== null ? round2(Math.max(0, invoiceTotal - sum)) : 0
    setRows((prev) => [...prev, { key: nextKey, method: "", amount: remaining > 0 ? remaining.toFixed(2) : "", tip: "", paidAt: "", workizMethod: null }])
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
    <section ref={formRef} aria-labelledby={headingId} className="flex flex-col gap-4 rounded-lg border bg-card p-3 sm:p-4">
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="text-base font-semibold">
          Confirm payments from Workiz
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {prefilledFromWorkiz
            ? "Filled in from what Workiz reported. Choose the method wherever it is blank, check the rest against the job's Payments tab in Workiz, then confirm."
            : "Open the job's Payments tab in Workiz and copy each payment here as shown, tip included."}{" "}
          Only credit card payments (and tips paid by card) get the 3.5% deduction; cash, check and Zelle do not. A blank method is never guessed: the payout stays on hold until you choose one.
        </p>
      </div>

      <ol className="flex flex-col gap-3">
        {rows.map((row, i) => {
          const tipInvalid = parse(row.tip) > parse(row.amount) + 0.005
          return (
            <li key={row.key} className="flex flex-col gap-3 rounded-md border bg-background p-3">
              <div className="flex min-h-11 items-center justify-between gap-2">
                <p className="text-sm font-medium text-muted-foreground">
                  Payment {i + 1}
                  {rows.length > 1 ? ` of ${rows.length}` : ""}
                </p>
                {rows.length > 1 && (
                  <Button type="button" size="icon" variant="ghost" onClick={() => remove(row.key)} disabled={pending} aria-label={`Remove payment ${i + 1}`} className="h-11 w-11 shrink-0">
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`pay-method-${row.key}`} className="text-sm font-semibold">
                  Method
                </Label>
                <Select
                  value={row.method || undefined}
                  onValueChange={(v) => update(row.key, { method: v })}
                  open={openMethod === row.key}
                  onOpenChange={(isOpen) => setOpenMethod(isOpen ? row.key : null)}
                  disabled={pending}
                >
                  <SelectTrigger
                    id={`pay-method-${row.key}`}
                    aria-label={`Payment ${i + 1} method`}
                    className="h-12 w-full border-2 border-highlight-border bg-highlight px-3 text-base font-semibold text-highlight-foreground data-[placeholder]:text-highlight-foreground data-[size=default]:h-12 dark:bg-highlight dark:hover:bg-highlight [&_svg]:!text-highlight-foreground [&_svg]:!opacity-100"
                  >
                    <SelectValue placeholder="Choose method" />
                  </SelectTrigger>
                  <SelectContent position="popper" side="bottom" align="start" collisionPadding={12} className="z-[60]">
                    {MANUAL_PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m} className="min-h-11 text-base">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {row.workizMethod && (
                  <p className="break-words text-xs text-muted-foreground">
                    Workiz recorded this as &ldquo;{row.workizMethod}&rdquo;{row.method ? "" : ", which is not a method the app recognises"}.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={`pay-amount-${row.key}`} className="text-sm">
                    Amount
                  </Label>
                  <Input id={`pay-amount-${row.key}`} inputMode="decimal" value={row.amount} onChange={(e) => update(row.key, { amount: e.target.value })} disabled={pending} className="h-11 tabular-nums" aria-label={`Payment ${i + 1} amount`} />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={`pay-tip-${row.key}`} className="text-sm">
                    Tip included
                  </Label>
                  <Input
                    id={`pay-tip-${row.key}`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={row.tip}
                    onChange={(e) => update(row.key, { tip: e.target.value })}
                    disabled={pending}
                    className="h-11 tabular-nums"
                    aria-label={`Payment ${i + 1} tip included in the amount`}
                    aria-invalid={tipInvalid || undefined}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5 min-[400px]:col-span-2 sm:col-span-1">
                  <Label htmlFor={`pay-date-${row.key}`} className="text-sm">
                    Payment date <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input id={`pay-date-${row.key}`} type="datetime-local" value={row.paidAt} onChange={(e) => update(row.key, { paidAt: e.target.value })} disabled={pending} className="h-11 min-w-0" aria-label={`Payment ${i + 1} date`} />
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={add} disabled={pending} className="h-11 self-start">
          <Plus className="size-4" aria-hidden="true" />
          Add another payment
        </Button>
        <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
          Entered {money(sum)}
          {invoiceTotal !== null && invoiceTotal > 0 ? ` of ${money(invoiceTotal)} Workiz total` : ""}
          {tipSum > 0 ? ` · ${money(tipSum)} of it tip` : ""}
        </p>
      </div>

      {missingMethod > 0 && <InlineMessage tone="info">{missingMethod === 1 ? "Choose the method for the payment that has none." : `Choose the method for the ${missingMethod} payments that have none.`}</InlineMessage>}
      {mismatch && <InlineMessage tone="error">The payments must add up to the Workiz total. Enter every payment shown on the Workiz Payments tab, tip included.</InlineMessage>}
      {tipTooLarge && <InlineMessage tone="error">A tip cannot be larger than the payment it is part of. Enter the amount as Workiz shows it (tip included) and the tip portion beside it.</InlineMessage>}
      {!mismatch && tipGap && (
        <InlineMessage tone="info">
          Workiz&apos;s total is {money(expectedTip)} above the itemized services. Its API does not send the Tip field, so that is most likely the tip{tipSum > 0 ? ` — you have entered ${money(tipSum)}` : ""}. Leave it out only if the customer was charged something other than a tip; the payout stays on hold until the numbers agree.
        </InlineMessage>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="button" onClick={submit} disabled={pending || incomplete || mismatch || tipTooLarge} className="h-11">
          {existing.length ? "Update confirmation & re-sync" : "Confirm payments & re-sync"}
        </Button>
        {existing.length > 0 && (
          <Button type="button" variant="ghost" onClick={() => onClear(jobUuid)} disabled={pending} className="h-11">
            Clear confirmation
          </Button>
        )}
      </div>
    </section>
  )
}
