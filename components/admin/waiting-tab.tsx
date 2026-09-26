"use client"

import type { AdminDashboardData, WaitingSummary } from "@/app/actions/admin"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { AdminLocation } from "@/lib/admin/navigation"
import type { PayoutQuery } from "@/lib/payout/presentation"
import { PayoutsTab } from "./payouts-tab"

type Props = {
  waiting: WaitingSummary
  profiles: AdminDashboardData["profiles"]
  query: PayoutQuery
  onQueryChange: (next: PayoutQuery | ((q: PayoutQuery) => PayoutQuery)) => void
  timezone: string
  onNavigate: (loc: Partial<AdminLocation>) => void
}

/** Open payouts that are not due yet, bucketed by what they are waiting for, then the list itself. */
export function WaitingTab({ waiting, profiles, query, onQueryChange, timezone, onNavigate }: Props) {
  const total = waiting.customerUnpaid + waiting.notFinished + waiting.methodReview + waiting.openingReview + waiting.otherHolds
  const toReview = () => onNavigate({ view: "review" })

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Why these are not due yet</CardTitle>
          <CardDescription>{total === 0 ? "Every open payout is either due or settled." : `${total} open payout${total === 1 ? "" : "s"} still waiting on something. Amounts are provisional until then.`}</CardDescription>
        </CardHeader>
        {total > 0 && (
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <WaitingRow count={waiting.customerUnpaid} label="Customer has not paid in full" detail="Finished in Workiz, balance still open. Becomes due when Workiz shows it paid." />
            <WaitingRow count={waiting.notFinished} label="Job not finished" detail="Still scheduled or in progress in Workiz." />
            <WaitingRow count={waiting.methodReview} label="Payment method needs your call" detail="Workiz recorded 'Other' or nothing. Confirm how the customer paid so card fees apply correctly." tone="warn" onClick={toReview} />
            <WaitingRow count={waiting.openingReview} label="Pre-cutoff work found after setup" detail="Finished before your opening-balance cutoff. Confirm previously paid, or release it." tone="warn" onClick={toReview} />
            <WaitingRow count={waiting.otherHolds} label="Other holds" detail="Unmapped team member, tip split, discount or calculation check." tone="warn" onClick={toReview} />
          </CardContent>
        )}
      </Card>

      <PayoutsTab
        initialPage={null}
        profiles={profiles}
        query={query}
        onQueryChange={onQueryChange}
        focusToken={0}
        timezone={timezone}
        fixedStatus="pending"
        onGoToDue={(profileId) => onNavigate({ view: "due", techId: profileId })}
        onOpenBatch={(batchId) => onNavigate({ view: "history", batchId })}
      />
    </div>
  )
}

function WaitingRow({ count, label, detail, tone = "muted", onClick }: { count: number; label: string; detail: string; tone?: "muted" | "warn"; onClick?: () => void }) {
  if (count === 0) return null
  const body = (
    <>
      <span className={`min-w-8 text-xl font-semibold tabular-nums ${tone === "warn" ? "text-warning-foreground" : "text-foreground"}`}>{count}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
        {onClick && <span className="text-xs font-medium text-primary">Open in Review</span>}
      </span>
    </>
  )
  if (!onClick) return <div className="flex items-start gap-3 rounded-md border bg-card p-3">{body}</div>
  return (
    <button type="button" onClick={onClick} className="flex items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </button>
  )
}
