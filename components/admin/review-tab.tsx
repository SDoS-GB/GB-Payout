"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, ChevronRight, ExternalLink, Search, X } from "lucide-react"
import type { AdminDashboardData, ReviewBoard, ReviewChange, ReviewHold } from "@/app/actions/admin"
import { acknowledgeSourceChange, clearConfirmedPayments, confirmJobPayments, confirmPreviouslyPaidPayouts, dismissAdminNotices, reviewPayout } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AdminLocation } from "@/lib/admin/navigation"
import { adminHref } from "@/lib/admin/navigation"
import { holdIssueLabel } from "@/lib/admin/notices"
import { workizJobUrl } from "@/lib/payout/presentation"
import { PayoutDetailSheet } from "./payout-detail-sheet"
import { InlineMessage, money, zonedDate } from "./shared"

type Props = {
  review: ReviewBoard
  unmappedCount: number
  /** Job number or customer the bell asked to focus on; cleared by the owner from the search box. */
  search: string
  onSearchChange: (search: string) => void
  timezone: string
  onNavigate: (loc: Partial<AdminLocation>) => void
  onOpenBatch: (batchId: number) => void
}

const matches = (needle: string, ...hay: Array<string | null | undefined>) => {
  const n = needle.trim().toLowerCase()
  if (!n) return true
  return hay.some((h) => (h ?? "").toLowerCase().includes(n))
}

/**
 * Everything that needs the owner's decision: held payouts and paid jobs Workiz changed
 * afterwards. CLEAR archives every item currently on the list (not just what is on screen)
 * using the same durable dismissal records as the bell, so the badge and the bell agree and a
 * cleared issue does not come back on the next sync. Clearing never pays, releases or
 * approves anything; the payouts stay on hold underneath and a later valid sync can still make
 * them Due.
 */
export function ReviewTab({ review, unmappedCount, search, onSearchChange, timezone, onNavigate, onOpenBatch }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [detailId, setDetailId] = useState<number | null>(null)
  const [showCleared, setShowCleared] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Optimistic: keys hidden the instant CLEAR is tapped, restored if the server says no.
  const [hiding, setHiding] = useState<ReadonlySet<string>>(() => new Set())

  const isCleared = (k: string, cleared: boolean) => cleared || hiding.has(k)
  const openHolds = useMemo(() => review.holds.filter((h) => !isCleared(h.noticeKey, h.cleared)), [review.holds, hiding])
  const openChanges = useMemo(() => review.changes.filter((c) => !isCleared(c.noticeKey, c.cleared)), [review.changes, hiding])
  const clearedHolds = review.holds.filter((h) => isCleared(h.noticeKey, h.cleared))
  const clearedChanges = review.changes.filter((c) => isCleared(c.noticeKey, c.cleared))
  const openCount = openHolds.length + openChanges.length
  const clearedCount = clearedHolds.length + clearedChanges.length

  const visibleHolds = openHolds.filter((h) => matches(search, h.job?.serialId, h.job?.clientName, h.profileName, h.jobUuid))
  const visibleChanges = openChanges.filter((c) => matches(search, c.serialId, c.clientName, c.profileName, c.jobUuid))
  const searching = search.trim().length > 0

  const allRecords = review.holds
  const detail = detailId != null ? allRecords.find((h) => h.id === detailId) ?? null : null
  useEffect(() => {
    if (detailId != null && !allRecords.some((h) => h.id === detailId)) setDetailId(null)
  }, [allRecords, detailId])

  const clearAll = () => {
    if (pending || openCount === 0) return
    // Every uncleared item on the list, whether or not the search box is hiding it: CLEAR
    // empties the Review list. Items that arrive after this render are not in the set.
    const keys = Array.from(new Set([...openHolds.map((h) => h.noticeKey), ...openChanges.map((c) => c.noticeKey)]))
    setError(null)
    setMessage(null)
    setHiding((prev) => new Set([...prev, ...keys]))
    startTransition(async () => {
      const res = await dismissAdminNotices(keys, "review")
      if (!res.ok) {
        setHiding((prev) => {
          const next = new Set(prev)
          for (const k of keys) next.delete(k)
          return next
        })
        setError(`Could not clear the list: ${res.error}. Nothing was changed; try again.`)
        return
      }
      setMessage(review.truncated ? "Cleared. More items were waiting behind these; refresh and CLEAR again to archive them too." : `Cleared ${openCount} item${openCount === 1 ? "" : "s"}.`)
      router.refresh()
    })
  }

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) =>
    startTransition(async () => {
      setError(null)
      setMessage(null)
      const res = await fn()
      if (!res.ok) return setError(res.error ?? "Failed")
      setMessage(okText)
      router.refresh()
    })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {openCount === 0 ? "Nothing needs your call" : `${openCount} item${openCount === 1 ? "" : "s"} need${openCount === 1 ? "s" : ""} your call`}
          {review.truncated && " (showing the first 500)"}
        </p>
        <Button type="button" variant="outline" onClick={clearAll} disabled={pending || openCount === 0} aria-busy={pending} className="h-11 px-5 font-bold tracking-wide">
          {pending ? "Clearing…" : "CLEAR"}
        </Button>
      </div>

      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {message && <InlineMessage tone="ok">{message}</InlineMessage>}

      {unmappedCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {unmappedCount} Workiz team member{unmappedCount === 1 ? "" : "s"} still need{unmappedCount === 1 ? "s" : ""} a technician profile before their jobs can pay.{" "}
          <NavLink loc={{ view: "settings", section: "team", teamFilter: "unmapped" }} onNavigate={onNavigate}>
            Open Team mapping
          </NavLink>
        </p>
      )}

      {(openCount > 0 || searching) && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Job number, customer or technician" aria-label="Search the review list" className="h-11 pl-9 pr-10" />
          {searching && (
            <button type="button" onClick={() => onSearchChange("")} aria-label="Clear search" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {openCount === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border bg-card py-12 text-center">
          <CheckCircle2 className="h-8 w-8 text-primary" aria-hidden="true" />
          <p className="font-medium">Nothing needs your call</p>
          <p className="max-w-md px-4 text-sm text-muted-foreground">Held jobs and paid jobs that changed in Workiz appear here. A held job becomes Due on its own once its data is complete.</p>
        </div>
      ) : visibleHolds.length === 0 && visibleChanges.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">Nothing on the list matches &ldquo;{search.trim()}&rdquo;.</p>
      ) : (
        <>
          {visibleChanges.length > 0 && <ChangesSection rows={visibleChanges} timezone={timezone} pending={pending} onAcknowledge={(id) => act(() => acknowledgeSourceChange(id), "Marked as reviewed")} onOpenBatch={onOpenBatch} />}
          {visibleHolds.length > 0 && <HoldsSection rows={visibleHolds} timezone={timezone} onOpen={setDetailId} />}
        </>
      )}

      {clearedCount > 0 && (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => setShowCleared((v) => !v)} aria-expanded={showCleared} className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline">
            {showCleared ? "Hide cleared" : `Show cleared (${clearedCount})`}
          </button>
          {showCleared && (
            <div className="flex flex-col gap-3 opacity-80">
              <p className="text-xs text-muted-foreground">Cleared items stay archived here. Nothing about them changed; open one to confirm payments, release or void it.</p>
              {clearedChanges.length > 0 && <ChangesSection rows={clearedChanges} timezone={timezone} pending={pending} onAcknowledge={(id) => act(() => acknowledgeSourceChange(id), "Marked as reviewed")} onOpenBatch={onOpenBatch} muted />}
              {clearedHolds.length > 0 && <HoldsSection rows={clearedHolds} timezone={timezone} onOpen={setDetailId} muted />}
            </div>
          )}
        </div>
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
          onGoToDue: (profileId) => onNavigate({ view: "due", techId: profileId }),
          onOpenBatch,
        }}
      />
    </div>
  )
}

export function NavLink({ loc, onNavigate, children, className }: { loc: Partial<AdminLocation>; onNavigate: (loc: Partial<AdminLocation>) => void; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={adminHref(loc)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        onNavigate(loc)
      }}
      className={className ?? "font-medium text-primary underline-offset-4 hover:underline"}
    >
      {children}
    </a>
  )
}

/** Held payouts, one compact row each; tapping opens the full detail panel with its actions. */
function HoldsSection({ rows, timezone, onOpen, muted }: { rows: ReviewHold[]; timezone: string; onOpen: (id: number) => void; muted?: boolean }) {
  return (
    <section aria-label={muted ? "Cleared held payouts" : "Held payouts"} className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{muted ? "Cleared · on hold" : "On hold"}</h2>
      <ul className="flex flex-col divide-y rounded-lg border bg-card">
        {rows.map((h) => {
          const serial = h.job?.serialId ?? null
          const customer = h.job?.clientName?.trim() || "Unknown customer"
          const url = workizJobUrl(h.jobUuid)
          const completed = h.completion?.state === "completed" ? h.completion.at : null
          return (
            <li key={h.id}>
              <button type="button" onClick={() => onOpen(h.id)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-3 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:px-4">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-base font-medium leading-snug">{customer}</span>
                    <span className="text-sm text-muted-foreground">
                      #{serial ?? "—"} · {h.profileName}
                    </span>
                  </span>
                  <span className="text-sm leading-snug text-warning-foreground">{holdIssueLabel(h.holdReason)}</span>
                  <span className="text-xs text-muted-foreground">
                    {completed ? `Completed ${zonedDate(completed, timezone)}` : h.job?.status ? `Status ${h.job.status}` : "No Workiz details"}
                    {Number(h.jobTotal) > 0 && <> · provisional {money(h.amount)}</>}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
              {url && (
                <div className="px-3 pb-2 sm:px-4">
                  <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline">
                    Open in Workiz
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Settled payouts whose Workiz inputs changed afterwards. Nothing is altered until the owner decides. */
function ChangesSection({ rows, timezone, pending, onAcknowledge, onOpenBatch, muted }: { rows: ReviewChange[]; timezone: string; pending: boolean; onAcknowledge: (id: number) => void; onOpenBatch: (batchId: number) => void; muted?: boolean }) {
  return (
    <section aria-label={muted ? "Cleared paid-job changes" : "Paid jobs changed in Workiz"} className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{muted ? "Cleared · paid jobs changed in Workiz" : "Paid jobs changed in Workiz"}</h2>
      <ul className="flex flex-col divide-y rounded-lg border border-warning/50 bg-card">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm sm:px-4">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">
                {r.clientName ?? "Unknown customer"} · #{r.serialId ?? "—"} · {r.profileName}
              </span>
              <span className="text-xs text-muted-foreground">
                Paid {money(r.settledAmount)}, Workiz now computes {money(r.recomputedAmount)} · noticed {zonedDate(r.detectedAt, timezone)}
              </span>
            </span>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onAcknowledge(r.id)} className="h-10">
              Reviewed
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        The paid amount stays as recorded. To pay the difference, undo the original payment in{" "}
        <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => onOpenBatch(0)}>
          Paid history
        </button>{" "}
        so the job comes back Due at the new amount.
      </p>
    </section>
  )
}
