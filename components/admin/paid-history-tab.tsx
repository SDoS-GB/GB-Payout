"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, ChevronUp, Search, Undo2, X } from "lucide-react"
import type { AdminDashboardData, LegacyPaidRow } from "@/app/actions/admin"
import { undoPaymentBatch } from "@/app/actions/admin"
import type { BatchSummary } from "@/lib/payout/batches"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { InlineMessage, money, zonedDate, zonedDateTime } from "./shared"

type Profile = AdminDashboardData["profiles"][number]
type Kind = "all" | "payment" | "opening"

type Props = {
  batches: BatchSummary[]
  legacyPaid: LegacyPaidRow[]
  profiles: Profile[]
  timezone: string
  /** Batch to expand and scroll to (set when arriving from a payout or a fresh payment). */
  openBatchId: number | null
  focusToken: number
}

export function PaidHistoryTab({ batches, legacyPaid, profiles, timezone, openBatchId, focusToken }: Props) {
  const [profileId, setProfileId] = useState<number | null>(null)
  const [kind, setKind] = useState<Kind>("all")
  const [showReversed, setShowReversed] = useState(true)
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (openBatchId && focusToken > 0) setExpanded((prev) => new Set(prev).add(openBatchId))
  }, [openBatchId, focusToken])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return batches.filter((b) => {
      if (profileId != null && b.profileId !== profileId) return false
      if (kind !== "all" && b.kind !== kind) return false
      if (!showReversed && b.status === "reversed") return false
      if (!q) return true
      if (String(b.id) === q.replace(/^#/, "")) return true
      if (b.profileName.toLowerCase().includes(q) || (b.reference ?? "").toLowerCase().includes(q) || (b.method ?? "").toLowerCase().includes(q)) return true
      return b.items.some((i) => (i.job?.serialId ?? "").toLowerCase().includes(q) || (i.job?.clientName ?? "").toLowerCase().includes(q) || i.jobUuid.toLowerCase() === q)
    })
  }, [batches, profileId, kind, showReversed, search])

  const active = filtered.filter((b) => b.status !== "reversed")
  const paidTotal = active.filter((b) => b.kind === "payment").reduce((cents, b) => cents + Math.round(Number(b.paidAmount ?? b.calculatedTotal) * 100), 0) / 100
  const isFiltered = profileId != null || kind !== "all" || !showReversed || search !== ""

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base">Paid history</CardTitle>
              <CardDescription aria-live="polite">
                {filtered.length === 0 ? "No payments match." : `${filtered.length} payment${filtered.length === 1 ? "" : "s"}${isFiltered ? " matching" : ""} · ${money(paidTotal)} paid out${kind === "opening" ? "" : " (excluding opening balance and undone payments)"}`}
              </CardDescription>
            </div>
            {isFiltered && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setProfileId(null)
                  setKind("all")
                  setShowReversed(true)
                  setSearch("")
                }}
              >
                <X className="h-4 w-4" />
                Clear filters
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3 pt-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hist-tech">Technician</Label>
              <Select value={profileId == null ? "all" : String(profileId)} onValueChange={(v) => setProfileId(v === "all" ? null : Number(v))}>
                <SelectTrigger id="hist-tech" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All technicians</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hist-kind">Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                <SelectTrigger id="hist-kind" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Payments and opening</SelectItem>
                  <SelectItem value="payment">Payments only</SelectItem>
                  <SelectItem value="opening">Opening balance only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hist-reversed">Undone payments</Label>
              <Select value={showReversed ? "show" : "hide"} onValueChange={(v) => setShowReversed(v === "show")}>
                <SelectTrigger id="hist-reversed" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="show">Show</SelectItem>
                  <SelectItem value="hide">Hide</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="hist-search">Search</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id="hist-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Job #, customer, payment #, reference" className="pl-8" />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{batches.length === 0 ? "Payments you record from the Due tab appear here, newest first, with an undo for each." : "Nothing matches these filters."}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((b) => (
                <BatchRow key={b.id} batch={b} timezone={timezone} expanded={expanded.has(b.id)} onToggle={() => toggle(b.id)} highlighted={openBatchId === b.id} focusToken={focusToken} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {legacyPaid.length > 0 && <LegacyCard rows={legacyPaid} timezone={timezone} profileId={profileId} />}
    </div>
  )
}

function BatchRow({ batch: b, timezone, expanded, onToggle, highlighted, focusToken }: { batch: BatchSummary; timezone: string; expanded: boolean; onToggle: () => void; highlighted: boolean; focusToken: number }) {
  const router = useRouter()
  const ref = useRef<HTMLLIElement>(null)
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState("")
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)

  useEffect(() => {
    if (highlighted && focusToken > 0) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [highlighted, focusToken])

  const reversed = b.status === "reversed"
  const opening = b.kind === "opening"
  const amount = Number(b.paidAmount ?? b.calculatedTotal)
  const when = b.paidOn ?? zonedDate(b.recordedAt, timezone)

  const undo = () =>
    startTransition(async () => {
      setMessage(null)
      const res = await undoPaymentBatch(b.id, reason.trim() || null || undefined)
      if (!res.ok) return setMessage({ tone: "error", text: res.error })
      setMessage({ tone: "ok", text: `Undone. ${res.data!.payouts} payout${res.data!.payouts === 1 ? "" : "s"} re-evaluated and returned to Due or Waiting.` })
      setConfirming(false)
      router.refresh()
    })

  return (
    <li ref={ref} className={`scroll-mt-4 rounded-md border ${reversed ? "bg-muted/40" : "bg-card"} ${highlighted ? "ring-2 ring-primary/40" : ""}`}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-accent/30">
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className={reversed ? "line-through text-muted-foreground" : ""}>
              {b.profileName} · {money(amount)}
            </span>
            {opening ? <Badge variant="outline">Opening balance</Badge> : <Badge variant="secondary">{b.method ?? "Paid"}</Badge>}
            {reversed && <Badge variant="destructive">Undone</Badge>}
            {b.provisional.length > 0 && !reversed && <Badge variant="outline" className="border-warning/50 text-warning-foreground">{b.provisional.length} provisional</Badge>}
          </span>
          <span className="text-xs text-muted-foreground">
            Payment #{b.id} · {opening ? `as of ${zonedDateTime(b.details && typeof b.details === "object" && "cutoffAt" in b.details ? String((b.details as { cutoffAt?: string }).cutoffAt) : b.recordedAt, timezone)}` : `paid on ${when}`} · {b.itemCount} job{b.itemCount === 1 ? "" : "s"}
            {b.reference ? ` · ref ${b.reference}` : ""}
            {reversed && b.reversedAt ? ` · undone ${zonedDateTime(b.reversedAt, timezone)}${b.reversalReason ? `: ${b.reversalReason}` : ""}` : ""}
          </span>
        </span>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t p-3">
          <ul className="flex flex-col divide-y rounded-md border text-sm">
            {b.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="flex flex-col">
                  <span className="font-medium">
                    #{i.job?.serialId ?? "—"} <span className="font-normal text-muted-foreground">· {i.job?.clientName ?? "Unknown customer"}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {i.job?.lastStatusUpdate ? `Completed ${zonedDate(i.job.lastStatusUpdate, timezone)}` : i.job?.status ?? ""}
                    {i.resettledBatchId ? ` · paid again in #${i.resettledBatchId}` : ""}
                    {i.payoutStatus && i.payoutStatus !== "paid" && reversed ? ` · now ${i.payoutStatus}` : ""}
                  </span>
                </span>
                <span className={`tabular-nums font-medium ${reversed ? "line-through text-muted-foreground" : ""}`}>{money(i.amount)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Recorded {zonedDateTime(b.recordedAt, timezone)} by {b.recordedBy}
              {b.label ? ` · ${b.label}` : ""}
            </span>
            {!reversed && !confirming && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(true)}>
                <Undo2 className="h-4 w-4" />
                {opening ? "Undo opening balance" : "Undo this payment"}
              </Button>
            )}
          </div>
          {confirming && (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm">
                {opening
                  ? "Undoing the opening balance puts every carried-in job back into Due at its calculated amount. Only do this if the cutoff was wrong."
                  : `This puts ${b.itemCount} job${b.itemCount === 1 ? "" : "s"} (${money(amount)}) back into Due for ${b.profileName}. The payment stays in history marked undone.`}
              </p>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (optional, kept with the record)" rows={2} className="text-sm" aria-label="Undo reason" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" disabled={pending} onClick={undo}>
                  {pending ? "Undoing…" : "Yes, undo"}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          )}
          {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
        </div>
      )}
    </li>
  )
}

/** Rows marked paid before payments were recorded per technician. Read-only, kept for the record. */
function LegacyCard({ rows, timezone, profileId }: { rows: LegacyPaidRow[]; timezone: string; profileId: number | null }) {
  const [open, setOpen] = useState(false)
  const visible = profileId == null ? rows : rows.filter((r) => r.profileId === profileId)
  if (visible.length === 0) return null
  const total = visible.reduce((cents, r) => cents + Math.round(r.amount * 100), 0) / 100
  return (
    <Card>
      <CardHeader className="pb-3">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between text-left">
          <span className="flex flex-col gap-1">
            <CardTitle className="text-base">Marked paid before payment tracking</CardTitle>
            <CardDescription>
              {visible.length} payout{visible.length === 1 ? "" : "s"} · {money(total)} · recorded one job at a time under the old flow, without a payment method. Shown for completeness; nothing here changes.
            </CardDescription>
          </span>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          <ul className="flex flex-col divide-y rounded-md border text-sm">
            {visible.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="flex flex-col">
                  <span className="font-medium">
                    #{r.serialId ?? "—"} <span className="font-normal text-muted-foreground">· {r.clientName ?? "Unknown customer"} · {r.profileName}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Marked paid {zonedDateTime(r.paidAt, timezone)}
                    {r.paidBy ? ` by ${r.paidBy}` : ""}
                    {r.adminNote ? ` · ${r.adminNote}` : ""}
                  </span>
                </span>
                <span className="tabular-nums font-medium">{money(r.amount)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  )
}
