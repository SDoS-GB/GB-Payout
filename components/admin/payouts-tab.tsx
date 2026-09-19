"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { bulkMarkPaid, reviewPayout, runReconcile, syncSingleJob } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { segmentLabel } from "@/lib/payout/segments"
import { InlineMessage, StatusBadge, money, shortDate, shortDateTime } from "./shared"

type PayoutItem = AdminDashboardData["payouts"][number]
type Profile = AdminDashboardData["profiles"][number]

const FILTERS = ["all", "ready", "hold", "pending", "paid", "void"] as const

export function PayoutsTab({ payouts, profiles }: { payouts: PayoutItem[]; profiles: Profile[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all")
  const [tech, setTech] = useState<string>("all")
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<number | null>(null)
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const [uuid, setUuid] = useState("")

  const visible = useMemo(
    () =>
      payouts.filter((p) => (filter === "all" || p.status === filter) && (tech === "all" || String(p.profileId) === tech)),
    [payouts, filter, tech],
  )

  const readyVisible = visible.filter((p) => p.status === "ready")
  const allReadySelected = readyVisible.length > 0 && readyVisible.every((p) => selected.has(p.id))

  const toggleAll = () => {
    const next = new Set(selected)
    if (allReadySelected) readyVisible.forEach((p) => next.delete(p.id))
    else readyVisible.forEach((p) => next.add(p.id))
    setSelected(next)
  }

  const act = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, okText: string) =>
    startTransition(async () => {
      setMessage(null)
      const res = await fn()
      if (!res.ok) {
        setMessage({ tone: "error", text: res.error ?? "Failed" })
        return
      }
      setMessage({ tone: "ok", text: okText })
      setSelected(new Set())
      router.refresh()
    })

  const selectedTotal = payouts.filter((p) => selected.has(p.id)).reduce((s, p) => s + Number(p.totalPayout), 0)

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sync</CardTitle>
          <CardDescription>Pull recent jobs from Workiz or re-process a single job by UUID. Paid and voided payouts are never changed by a sync.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setMessage(null)
                  const res = await runReconcile()
                  if (!res.ok) return setMessage({ tone: "error", text: res.error })
                  const d = res.data!
                  setMessage({
                    tone: d.failed ? "info" : "ok",
                    text: `Scanned ${d.scanned} jobs since ${d.startDate}: ${d.created} new payouts, ${d.updated} updated, ${d.held} held${d.failed ? `, ${d.failed} failed` : ""}${d.unmappedTeamIds.length ? `. Unmapped team ids: ${d.unmappedTeamIds.join(", ")}` : ""}`,
                  })
                  router.refresh()
                })
              }
            >
              <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />
              Reconcile recent jobs
            </Button>
            <form
              className="flex flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                startTransition(async () => {
                  setMessage(null)
                  const res = await syncSingleJob(uuid)
                  if (!res.ok) return setMessage({ tone: "error", text: res.error })
                  const d = res.data!
                  setMessage({ tone: "ok", text: `Job ${uuid} (${d.status ?? "?"}): ${d.created} new, ${d.updated} updated, ${d.held} held.${d.notes.length ? ` ${d.notes.join(" · ")}` : ""}` })
                  setUuid("")
                  router.refresh()
                })
              }}
            >
              <Input placeholder="Workiz job UUID" value={uuid} onChange={(e) => setUuid(e.target.value)} className="max-w-xs" />
              <Button size="sm" type="submit" variant="secondary" disabled={pending || !uuid.trim()}>
                Sync job
              </Button>
            </form>
          </div>
          {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Payout history</CardTitle>
              <CardDescription>{visible.length} of {payouts.length} payouts shown</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={filter} onValueChange={(v) => setFilter(v as (typeof FILTERS)[number])}>
                <SelectTrigger className="w-32" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILTERS.map((f) => (
                    <SelectItem key={f} value={f} className="capitalize">
                      {f === "all" ? "All statuses" : f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={tech} onValueChange={setTech}>
                <SelectTrigger className="w-40" aria-label="Filter by technician">
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
              <Button
                size="sm"
                disabled={pending || selected.size === 0}
                onClick={() => act(() => bulkMarkPaid(Array.from(selected)), `Marked ${selected.size} payouts as paid (${money(selectedTotal)})`)}
              >
                Mark {selected.size || ""} paid{selected.size ? ` · ${money(selectedTotal)}` : ""}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox checked={allReadySelected} onCheckedChange={toggleAll} aria-label="Select all ready payouts" disabled={readyVisible.length === 0} />
                  </TableHead>
                  <TableHead className="w-8" />
                  <TableHead>Job</TableHead>
                  <TableHead>Technician</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Job total</TableHead>
                  <TableHead className="text-right">Payout</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                      No payouts yet. Configure Workiz in the Workiz tab, map your team, then run a reconcile.
                    </TableCell>
                  </TableRow>
                )}
                {visible.map((p) => {
                  const open = expanded === p.id
                  return (
                    <PayoutRows
                      key={p.id}
                      p={p}
                      open={open}
                      onToggle={() => setExpanded(open ? null : p.id)}
                      checked={selected.has(p.id)}
                      onCheck={(v) => {
                        const next = new Set(selected)
                        if (v) next.add(p.id)
                        else next.delete(p.id)
                        setSelected(next)
                      }}
                      pending={pending}
                      onAction={(action, note) => act(() => reviewPayout(p.id, action, note), `Payout #${p.id}: ${action.replace("-", " ")}`)}
                    />
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function PayoutRows({
  p,
  open,
  onToggle,
  checked,
  onCheck,
  pending,
  onAction,
}: {
  p: PayoutItem
  open: boolean
  onToggle: () => void
  checked: boolean
  onCheck: (v: boolean) => void
  pending: boolean
  onAction: (action: Parameters<typeof reviewPayout>[1], note?: string) => void
}) {
  const [note, setNote] = useState(p.adminNote ?? "")
  const b = (p.breakdown ?? {}) as Record<string, unknown>
  const warnings = Array.isArray(b.warnings) ? (b.warnings as string[]) : []
  const segment = (b.segment ?? null) as { itemNames?: string[]; markerFields?: string[]; grossAmount?: number; itemDiscountAmount?: number; allocatedDiscountAmount?: number } | null
  const jobWide = (b.job ?? null) as { jobTotal?: number; markers?: string[] } | null
  const verification = (b.verification ?? null) as { balanced?: boolean; assignedItemCount?: number; itemCount?: number; doubleCountedItems?: number } | null
  const label = segmentLabel(p.segmentKind, p.segmentMarker ?? jobWide?.markers?.join("/") ?? null)

  return (
    <>
      <TableRow className={open ? "bg-muted/40" : undefined}>
        <TableCell>
          <Checkbox checked={checked} onCheckedChange={(v) => onCheck(Boolean(v))} disabled={p.status !== "ready"} aria-label={`Select payout ${p.id}`} />
        </TableCell>
        <TableCell>
          <button type="button" onClick={onToggle} className="text-muted-foreground hover:text-foreground" aria-expanded={open} aria-label="Toggle details">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </TableCell>
        <TableCell>
          <div className="flex flex-col">
            <span className="font-medium">#{p.job?.serialId ?? p.jobUuid.slice(0, 8)}</span>
            <span className="text-xs text-muted-foreground">{p.job?.clientName ?? "—"} · {shortDate(p.job?.jobDateTime)}</span>
          </div>
        </TableCell>
        <TableCell>
          <div className="flex flex-col">
            <span>{p.profileName}</span>
            {label && <span className="font-mono text-xs text-muted-foreground">{label}</span>}
          </div>
        </TableCell>
        <TableCell>
          <div className="flex flex-col gap-1">
            <StatusBadge status={p.status} />
            {p.holdReason && p.status !== "ready" && <span className="max-w-[16rem] text-xs text-muted-foreground">{p.holdReason}</span>}
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums">{money(p.jobTotal)}</TableCell>
        <TableCell className="text-right font-semibold tabular-nums">{money(p.totalPayout)}</TableCell>
        <TableCell>{p.lastNotification ? <StatusBadge status={p.lastNotification.status} /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
        <TableCell className="text-xs text-muted-foreground">{shortDateTime(p.updatedAt)}</TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={9} className="p-4">
            <div className="grid gap-4 md:grid-cols-3">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                {label && (
                  <>
                    <dt className="text-muted-foreground">Paid on</dt>
                    <dd className="text-right font-mono text-xs">{label}</dd>
                    {jobWide?.jobTotal !== undefined && (
                      <>
                        <dt className="text-muted-foreground">Whole job</dt>
                        <dd className="text-right tabular-nums text-muted-foreground">{money(jobWide.jobTotal)}</dd>
                      </>
                    )}
                  </>
                )}
                <dt className="text-muted-foreground">{label ? "Commission base" : "Job total"}</dt>
                <dd className="text-right tabular-nums">{money(p.jobTotal)}</dd>
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="text-right tabular-nums">{money(p.discountAmount)}</dd>
                <dt className="text-muted-foreground">Color seal</dt>
                <dd className="text-right tabular-nums">{money(p.colorSealTotal)}</dd>
                <dt className="text-muted-foreground">Paid by card</dt>
                <dd className="text-right tabular-nums">{money(p.cardServiceAmount)}</dd>
                <dt className="text-muted-foreground">Paid other</dt>
                <dd className="text-right tabular-nums">{money(p.nonCardServiceAmount)}</dd>
                <dt className="text-muted-foreground">Tips (card / other)</dt>
                <dd className="text-right tabular-nums">
                  {money(p.cardTipAmount)} / {money(p.nonCardTipAmount)}
                </dd>
              </dl>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Rates</dt>
                <dd className="text-right tabular-nums">
                  {(Number(p.nonColorRate) * 100).toFixed(0)}% / {(Number(p.colorRate) * 100).toFixed(0)}% · tip {(Number(p.tipShare) * 100).toFixed(0)}%
                </dd>
                <dt className="text-muted-foreground">Non-color</dt>
                <dd className="text-right tabular-nums">{money(p.nonColorPayout)}</dd>
                <dt className="text-muted-foreground">Color</dt>
                <dd className="text-right tabular-nums">{money(p.colorPayout)}</dd>
                <dt className="text-muted-foreground">Tip</dt>
                <dd className="text-right tabular-nums">{money(p.tipPayout)}</dd>
                <dt className="font-medium">Total</dt>
                <dd className="text-right font-semibold tabular-nums">{money(p.totalPayout)}</dd>
                <dt className="text-muted-foreground">Mode</dt>
                <dd className="text-right text-xs">{p.calcMode ?? "—"} · {p.splitCount} tech{p.splitCount === 1 ? "" : "s"}</dd>
              </dl>
              <div className="flex flex-col gap-2">
                {label && segment && (
                  <div className="rounded border bg-background p-2 text-xs">
                    <p className="font-medium">
                      {segment.itemNames?.length ?? 0} line item{(segment.itemNames?.length ?? 0) === 1 ? "" : "s"} · gross {money(segment.grossAmount ?? 0)}
                      {(segment.itemDiscountAmount ?? 0) > 0 ? ` · item discounts ${money(segment.itemDiscountAmount ?? 0)}` : ""}
                      {(segment.allocatedDiscountAmount ?? 0) > 0 ? ` · share of job discount ${money(segment.allocatedDiscountAmount ?? 0)}` : ""}
                      {segment.markerFields?.length ? ` · marker found in ${segment.markerFields.join("/")}` : ""}
                    </p>
                    {segment.itemNames && segment.itemNames.length > 0 && <p className="mt-1 text-muted-foreground">{segment.itemNames.join(", ")}</p>}
                    {verification && (
                      <p className={verification.balanced ? "mt-1 text-muted-foreground" : "mt-1 text-destructive"}>
                        {verification.balanced
                          ? `Verified: ${verification.assignedItemCount}/${verification.itemCount} items assigned once, segments sum to the job total`
                          : `Check failed: ${verification.doubleCountedItems ?? 0} item(s) double-counted or totals do not balance`}
                      </p>
                    )}
                  </div>
                )}
                {warnings.length > 0 && (
                  <ul className="list-disc pl-4 text-xs text-amber-700 dark:text-amber-300">
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                {p.lastNotification && (
                  <p className="rounded border bg-background p-2 text-xs">
                    <span className="font-medium">Last message ({p.lastNotification.status}):</span> {p.lastNotification.message}
                    {p.lastNotification.error && <span className="text-destructive"> · {p.lastNotification.error}</span>}
                  </p>
                )}
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Admin note (optional)" rows={2} className="text-sm" />
                <div className="flex flex-wrap gap-2">
                  {p.status !== "ready" && p.status !== "paid" && (
                    <Button size="sm" disabled={pending} onClick={() => onAction("release", note)}>
                      Release
                    </Button>
                  )}
                  {p.status === "ready" && (
                    <Button size="sm" disabled={pending} onClick={() => onAction("mark-paid", note)}>
                      Mark paid
                    </Button>
                  )}
                  {p.status !== "hold" && p.status !== "paid" && (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction("hold", note)}>
                      Hold
                    </Button>
                  )}
                  {p.status === "paid" && (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction("reopen", note)}>
                      Reopen
                    </Button>
                  )}
                  {p.status !== "void" && p.status !== "paid" && (
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => onAction("void", note)}>
                      Void
                    </Button>
                  )}
                </div>
                {p.paidAt && <p className="text-xs text-muted-foreground">Paid {shortDateTime(p.paidAt)} by {p.paidBy}</p>}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
