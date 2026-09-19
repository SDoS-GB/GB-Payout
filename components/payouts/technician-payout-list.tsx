"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { TechnicianPayoutList as Data } from "@/lib/payout/queries"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

const money = (v: string | number | null | undefined) => `$${Number(v ?? 0).toFixed(2)}`
const shortDate = (d: Date | string | null | undefined) => {
  if (!d) return "—"
  const date = typeof d === "string" ? new Date(d) : d
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  ready: { label: "Ready", className: "bg-primary/10 text-primary border-primary/20" },
  paid: { label: "Paid", className: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300" },
  hold: { label: "In review", className: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300" },
  pending: { label: "Waiting on job", className: "bg-muted text-muted-foreground border-border" },
}

export function TechnicianPayoutList({ data }: { data: Data }) {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <>
      <section aria-label="Totals" className="grid grid-cols-3 gap-3">
        <Total label="Ready to be paid" value={money(data.totals.ready)} emphasis />
        <Total label="Paid, last 30 days" value={money(data.totals.paid30)} />
        <Total label="Waiting" value={String(data.totals.pendingCount)} />
      </section>

      <Card>
        <CardContent className="p-0">
          {data.items.length === 0 && (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">No Workiz payouts yet. They appear here automatically when your jobs are completed and paid.</p>
          )}
          <ul className="divide-y">
            {data.items.map((p) => {
              const s = STATUS_LABEL[p.status] ?? STATUS_LABEL.pending
              const isOpen = open === p.id
              const tips = Number(p.cardTipAmount) + Number(p.nonCardTipAmount)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : p.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">
                        #{p.job?.serialId ?? p.jobUuid.slice(0, 8)} · {p.job?.clientName ?? "Job"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {shortDate(p.job?.jobDateTime)} · job total {money(p.jobTotal)}
                        {Number(p.colorSealTotal) > 0 ? ` · color seal ${money(p.colorSealTotal)}` : ""}
                        {tips > 0 ? ` · tips ${money(tips)}` : ""}
                      </span>
                    </div>
                    <Badge variant="outline" className={s.className}>
                      {s.label}
                    </Badge>
                    <span className="w-24 text-right text-base font-semibold tabular-nums">{money(p.totalPayout)}</span>
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-3 border-t bg-muted/30 px-4 py-3 text-sm md:flex-row md:gap-8">
                      <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1">
                        <dt className="text-muted-foreground">Non-color work</dt>
                        <dd className="text-right tabular-nums">{money(p.nonColorPayout)}</dd>
                        <dt className="text-muted-foreground">Color seal</dt>
                        <dd className="text-right tabular-nums">{money(p.colorPayout)}</dd>
                        <dt className="text-muted-foreground">Tip</dt>
                        <dd className="text-right tabular-nums">{money(p.tipPayout)}</dd>
                        <dt className="font-medium">Total</dt>
                        <dd className="text-right font-semibold tabular-nums">{money(p.totalPayout)}</dd>
                      </dl>
                      <div className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                        <span>
                          Paid by card {money(p.cardServiceAmount)} · other {money(p.nonCardServiceAmount)}
                          {Number(p.discountAmount) > 0 ? ` · discount ${money(p.discountAmount)}` : ""}
                        </span>
                        {p.status === "hold" && p.holdReason && <span>Under review: {p.holdReason}</span>}
                        {p.status === "pending" && <span>Becomes ready once the job is marked done and fully paid in Workiz.</span>}
                        {p.paidAt && <span>Paid on {shortDate(p.paidAt)}</span>}
                        {p.sentMessage && <span className="text-foreground">Message sent: {p.sentMessage.message}</span>}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>
    </>
  )
}

function Total({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${emphasis ? "text-primary" : ""}`}>{value}</span>
    </div>
  )
}
