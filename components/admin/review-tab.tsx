"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { AdminDashboardData, SourceChangeRow } from "@/app/actions/admin"
import { acknowledgeSourceChange } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { AdminLocation } from "@/lib/admin/navigation"
import { adminHref } from "@/lib/admin/navigation"
import type { PayoutQuery } from "@/lib/payout/presentation"
import { PayoutsTab } from "./payouts-tab"
import { InlineMessage, money, zonedDate } from "./shared"

type Props = {
  sourceChanges: SourceChangeRow[]
  unmappedCount: number
  profiles: AdminDashboardData["profiles"]
  query: PayoutQuery
  onQueryChange: (next: PayoutQuery | ((q: PayoutQuery) => PayoutQuery)) => void
  timezone: string
  onNavigate: (loc: Partial<AdminLocation>) => void
}

/** Everything that needs the owner's decision: payouts on hold and paid jobs Workiz changed afterwards. */
export function ReviewTab({ sourceChanges, unmappedCount, profiles, query, onQueryChange, timezone, onNavigate }: Props) {
  return (
    <div className="flex flex-col gap-4">
      {unmappedCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {unmappedCount} Workiz team member{unmappedCount === 1 ? "" : "s"} still need{unmappedCount === 1 ? "s" : ""} a technician profile before their jobs can pay.{" "}
          <NavLink loc={{ view: "settings", section: "team", teamFilter: "unmapped" }} onNavigate={onNavigate}>
            Open Team mapping
          </NavLink>
        </p>
      )}

      {sourceChanges.length > 0 && <SourceChangesCard rows={sourceChanges} timezone={timezone} onOpenBatch={(batchId) => onNavigate({ view: "history", batchId: batchId || null })} />}

      <PayoutsTab
        initialPage={null}
        profiles={profiles}
        query={query}
        onQueryChange={onQueryChange}
        focusToken={0}
        timezone={timezone}
        fixedStatus="hold"
        onGoToDue={(profileId) => onNavigate({ view: "due", techId: profileId })}
        onOpenBatch={(batchId) => onNavigate({ view: "history", batchId })}
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
          Undo lives in{" "}
          <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => onOpenBatch(0)}>
            Paid history
          </button>
          .
        </p>
      </CardContent>
    </Card>
  )
}
