"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import useSWR, { SWRConfig, unstable_serialize, useSWRConfig } from "swr"
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react"
import type { PayoutPage, PayoutRecord, AdminDashboardData } from "@/app/actions/admin"
import { clearConfirmedPayments, confirmJobPayments, confirmPreviouslyPaidPayouts, queryPayouts, reviewPayout, syncSingleJob } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { segmentLabel } from "@/lib/payout/segments"
import { DEFAULT_PAYOUT_QUERY, PAYOUT_STATUS_FILTERS, paymentMethodsSummary, type PayoutQuery, type PayoutStatusFilter } from "@/lib/payout/presentation"
import { PayoutDetailSheet } from "./payout-detail-sheet"
import { InlineMessage, StatusBadge, money, zonedDate } from "./shared"

type Profile = AdminDashboardData["profiles"][number]

const STATUS_LABELS: Record<PayoutStatusFilter, string> = {
  all: "All statuses",
  ready: "Due",
  hold: "Needs review",
  pending: "Waiting",
  paid: "Paid",
  void: "Void",
}

const payoutKey = (q: PayoutQuery) => ["payouts", q.status, q.profileId, q.search, q.page, q.pageSize] as const
const isPayoutKey = (k: unknown): boolean => Array.isArray(k) && k[0] === "payouts"

type Props = {
  initialPage: PayoutPage | null
  profiles: Profile[]
  query: PayoutQuery
  onQueryChange: (next: PayoutQuery | ((q: PayoutQuery) => PayoutQuery)) => void
  focusToken: number
  timezone: string
  onGoToDue: (profileId: number) => void
  onOpenBatch: (batchId: number) => void
}

export function PayoutsTab(props: Props) {
  return (
    <SWRConfig value={{ fallback: props.initialPage ? { [unstable_serialize(payoutKey(DEFAULT_PAYOUT_QUERY))]: props.initialPage } : {}, revalidateOnFocus: false }}>
      <PayoutsTabInner {...props} />
    </SWRConfig>
  )
}

/** Shown on rows and in the panel: never a misleading $0.00 when nothing could be calculated. */
export function payoutAmountLabel(p: Pick<PayoutRecord, "jobTotal" | "totalPayout" | "status">): { text: string; provisional: boolean; unavailable: boolean } {
  const jobTotal = Number(p.jobTotal)
  const total = Number(p.totalPayout)
  if (jobTotal <= 0 && total === 0) return { text: "Not calculated", provisional: false, unavailable: true }
  return { text: money(total), provisional: p.status === "pending" || p.status === "hold", unavailable: false }
}

function PayoutsTabInner({ profiles, query, onQueryChange, focusToken, timezone, onGoToDue, onOpenBatch }: Props) {
  const router = useRouter()
  const { mutate: mutateAll } = useSWRConfig()
  const [pending, startTransition] = useTransition()
  const [openId, setOpenId] = useState<number | null>(null)
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const [uuid, setUuid] = useState("")
  const [searchDraft, setSearchDraft] = useState(query.search)
  const listRef = useRef<HTMLDivElement | null>(null)

  const { data, isLoading, isValidating, error, mutate } = useSWR(payoutKey(query), ([, status, profileId, search, page, pageSize]) =>
    queryPayouts({ status: status as PayoutStatusFilter, profileId: profileId as number | null, search: search as string, page: page as number, pageSize: pageSize as number }),
  { keepPreviousData: true })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const page = data?.page ?? query.page
  const pageSize = data?.pageSize ?? query.pageSize
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const showingStale = Boolean(data) && data!.query && unstable_serialize(payoutKey(data!.query)) !== unstable_serialize(payoutKey(query))

  // Summary-card clicks bump the token; bring the list into view.
  useEffect(() => {
    if (focusToken > 0) listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [focusToken])

  // Keep the search box in sync when a card clears the search filter.
  useEffect(() => {
    setSearchDraft(query.search)
  }, [query.search])

  useEffect(() => {
    const trimmed = searchDraft.trim()
    if (trimmed === query.search) return
    const t = setTimeout(() => onQueryChange((q) => ({ ...q, search: trimmed, page: 1 })), 300)
    return () => clearTimeout(t)
  }, [searchDraft, query.search, onQueryChange])

  // Close the panel when its row leaves the page.
  useEffect(() => {
    if (!data) return
    const ids = new Set(data.items.map((i) => i.id))
    if (openId != null && !ids.has(openId)) setOpenId(null)
  }, [data, openId])

  const refreshAll = async () => {
    await mutateAll(isPayoutKey, undefined, { revalidate: false })
    await mutate()
    router.refresh()
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
      await refreshAll()
    })

  const filtered = query.status !== "all" || query.profileId != null || query.search !== ""
  const selectedProfile = query.profileId != null ? profiles.find((p) => p.id === query.profileId) ?? null : null
  const openRecord = openId != null ? items.find((i) => i.id === openId) ?? null : null

  const emptyState = () => {
    if (query.search) return { title: `No payouts match “${query.search}”`, body: "Search by Workiz job number, customer name, or job UUID." }
    const who = selectedProfile ? ` for ${selectedProfile.name}` : ""
    switch (query.status) {
      case "ready":
        return { title: `Nothing is due${who}`, body: "A payout becomes due once the Workiz job is finished, the customer has paid in full, and every team member on the job is mapped. Pay it from the Due tab." }
      case "hold":
        return { title: `Nothing needs review${who}`, body: "Payouts land here when a finished, paid job still needs a decision: an unknown payment method, an unmapped team member, or pre-cutoff work seen after the opening balance." }
      case "pending":
        return { title: `Nothing is waiting${who}`, body: "Waiting payouts are jobs that are not finished or not fully paid by the customer yet. Their amounts are provisional." }
      case "paid":
        return { title: `No paid payouts${who}`, body: "Payouts settled from the Due tab are listed here, each linked to the payment it was part of." }
      case "void":
        return { title: `No voided payouts${who}`, body: "Voided payouts are excluded from every total." }
      default:
        return selectedProfile
          ? { title: `No payouts for ${selectedProfile.name} yet`, body: "Payouts appear after a Workiz job with this technician on it is synced." }
          : { title: "No payouts yet", body: "Configure Workiz in the Workiz tab, map your team, then run a reconcile." }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div ref={listRef} className="scroll-mt-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-base">Every payout</CardTitle>
                  <CardDescription aria-live="polite">
                    {isLoading && !data
                      ? "Loading payouts…"
                      : total === 0
                        ? `0 individual payouts${filtered ? " match these filters" : ""}`
                        : `Showing ${from}–${to} of ${total} individual payout${total === 1 ? "" : "s"}${filtered ? " matching these filters" : ""}`}
                    {" · "}one record per technician; a shared job appears once per technician
                  </CardDescription>
                  {(query.status === "pending" || query.status === "hold") && (
                    <p className="text-xs text-warning-foreground">Amounts in this view are provisional, not due yet.</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {filtered && (
                    <Button size="sm" variant="ghost" onClick={() => onQueryChange({ ...DEFAULT_PAYOUT_QUERY })}>
                      <X className="h-4 w-4" />
                      All payouts
                    </Button>
                  )}
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      startTransition(async () => {
                        setMessage(null)
                        const res = await syncSingleJob(uuid)
                        if (!res.ok) return setMessage({ tone: "error", text: res.error })
                        const d = res.data!
                        setMessage({ tone: "ok", text: `Job ${uuid} (${d.status ?? "?"}): ${d.created} new, ${d.updated} updated, ${d.held} held.${d.notes.length ? ` ${d.notes.join(" · ")}` : ""}` })
                        setUuid("")
                        await refreshAll()
                      })
                    }}
                  >
                    <Input placeholder="Re-sync a job by Workiz UUID" value={uuid} onChange={(e) => setUuid(e.target.value)} className="h-8 w-56" aria-label="Workiz job UUID" />
                    <Button size="sm" type="submit" variant="secondary" disabled={pending || !uuid.trim()}>
                      Sync job
                    </Button>
                  </form>
                </div>
              </div>
              {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_12rem]">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="payout-search" className="text-xs">
                    Search job number or customer
                  </Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input id="payout-search" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="e.g. 924738 or Smith" className="pl-8" />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="payout-status" className="text-xs">
                    Status
                  </Label>
                  <Select value={query.status} onValueChange={(v) => onQueryChange((q) => ({ ...q, status: v as PayoutStatusFilter, page: 1 }))}>
                    <SelectTrigger id="payout-status" aria-label="Filter by status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYOUT_STATUS_FILTERS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {STATUS_LABELS[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="payout-tech" className="text-xs">
                    Technician
                  </Label>
                  <Select value={query.profileId == null ? "all" : String(query.profileId)} onValueChange={(v) => onQueryChange((q) => ({ ...q, profileId: v === "all" ? null : Number(v), page: 1 }))}>
                    <SelectTrigger id="payout-tech" aria-label="Filter by technician">
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
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {error && (
              <div className="px-4 pb-3">
                <InlineMessage tone="error">Could not load payouts: {error instanceof Error ? error.message : String(error)}</InlineMessage>
              </div>
            )}
            <div className={`overflow-x-auto transition-opacity ${isValidating && showingStale ? "opacity-60" : ""}`} aria-busy={isValidating}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Technician</TableHead>
                    <TableHead className="text-right">Individual payout</TableHead>
                    <TableHead>Status / reason</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead>Customer paid by</TableHead>
                    <TableHead className="w-8">
                      <span className="sr-only">Open details</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 && !isLoading && (
                    <TableRow>
                      <TableCell colSpan={8} className="whitespace-normal py-12 text-center">
                        <div className="mx-auto flex max-w-md flex-col gap-2">
                          <p className="text-sm font-medium">{emptyState().title}</p>
                          <p className="text-sm text-muted-foreground">{emptyState().body}</p>
                          {filtered && (
                            <div>
                              <Button size="sm" variant="outline" onClick={() => onQueryChange({ ...DEFAULT_PAYOUT_QUERY })}>
                                Show all payouts
                              </Button>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  {items.length === 0 && isLoading && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-12 text-center text-sm text-muted-foreground">
                        Loading payouts…
                      </TableCell>
                    </TableRow>
                  )}
                  {items.map((p) => (
                    <PayoutRow key={p.id} p={p} timezone={timezone} open={openId === p.id} onOpen={() => setOpenId(p.id)} />
                  ))}
                </TableBody>
              </Table>
            </div>
            {total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-muted-foreground">
                    Page {page} of {pageCount}
                  </span>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="payout-page-size" className="text-xs text-muted-foreground">
                      Rows per page
                    </Label>
                    <Select value={String(query.pageSize)} onValueChange={(v) => onQueryChange((q) => ({ ...q, pageSize: Number(v), page: 1 }))}>
                      <SelectTrigger id="payout-page-size" className="h-8 w-20" aria-label="Rows per page">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[10, 25, 50, 100].map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={page <= 1 || isValidating} onClick={() => onQueryChange((q) => ({ ...q, page: Math.max(1, q.page - 1) }))}>
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button size="sm" variant="outline" disabled={page >= pageCount || isValidating} onClick={() => onQueryChange((q) => ({ ...q, page: q.page + 1 }))}>
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <PayoutDetailSheet
        record={openRecord}
        open={openRecord != null}
        onOpenChange={(o) => {
          if (!o) setOpenId(null)
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
          onGoToDue,
          onOpenBatch,
        }}
      />
    </div>
  )
}

function PayoutRow({ p, timezone, open, onOpen }: { p: PayoutRecord; timezone: string; open: boolean; onOpen: () => void }) {
  const b = (p.breakdown ?? {}) as Record<string, unknown>
  const jobWide = (b.job ?? null) as { markers?: string[] } | null
  const ownership = (b.ownership ?? null) as { reason?: string; workType?: string | null } | null
  const label = segmentLabel(p.segmentKind, p.segmentMarker ?? jobWide?.markers?.join("/") ?? null, ownership)
  const amount = payoutAmountLabel(p)
  const methods = paymentMethodsSummary(p.job?.payments)
  const reason = p.status === "ready" || p.status === "paid" ? null : p.holdReason

  return (
    <TableRow
      onClick={onOpen}
      className={`cursor-pointer ${open ? "bg-muted/50" : ""}`}
      data-state={open ? "selected" : undefined}
      aria-selected={open}
    >
      <TableCell>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          className="text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          #{p.job?.serialId ?? p.jobUuid}
        </button>
        <div className="text-xs text-muted-foreground">{p.job?.status ?? "Status unavailable"}</div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col">
          <span>{p.job?.clientName ?? <span className="text-muted-foreground">Customer unavailable</span>}</span>
          <span className="text-xs text-muted-foreground">Job date {zonedDate(p.job?.jobDateTime, timezone)}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col">
          <span>{p.profileName}</span>
          {label && <span className="font-mono text-xs text-muted-foreground">{label}</span>}
          {p.siblings.length > 0 && <span className="text-xs text-muted-foreground">+{p.siblings.length} other on this job</span>}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-col items-end">
          <span className={`font-semibold tabular-nums ${amount.unavailable ? "text-muted-foreground" : ""}`}>{amount.text}</span>
          {amount.provisional && <span className="text-[11px] uppercase tracking-wide text-warning-foreground">Provisional</span>}
          {amount.unavailable && <span className="text-[11px] text-muted-foreground">Job total is zero</span>}
        </div>
      </TableCell>
      <TableCell className="whitespace-normal">
        <div className="flex flex-col gap-1">
          <StatusBadge status={p.status} />
          {reason && <span className="max-w-[16rem] text-xs text-muted-foreground">{reason}</span>}
        </div>
      </TableCell>
      <TableCell className="text-xs">
        <CompletionCell completion={p.completion} timezone={timezone} />
      </TableCell>
      <TableCell className="text-xs">
        <span className={methods.count === 0 ? "text-muted-foreground" : ""}>{methods.label}</span>
        {methods.mixed && <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground">Mixed</span>}
      </TableCell>
      <TableCell className="text-muted-foreground">
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </TableCell>
    </TableRow>
  )
}

export function CompletionCell({ completion, timezone }: { completion: PayoutRecord["completion"]; timezone: string }) {
  if (!completion) return <span className="text-muted-foreground">Completion date unavailable</span>
  if (completion.state === "completed") return <span>{zonedDate(completion.at, timezone)}</span>
  if (completion.state === "not-completed") return <span className="text-muted-foreground">Not completed</span>
  return <span className="text-muted-foreground">Completion date unavailable</span>
}
