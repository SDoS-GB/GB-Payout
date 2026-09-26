"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { RefreshCw } from "lucide-react"
import type { SyncPanel } from "@/app/actions/admin"
import { fetchSyncPanel, runReconcile } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { zonedDateTime } from "./shared"

export const SYNC_PANEL_KEY = "sync-panel"

/**
 * The top-bar Refresh: runs the real Workiz reconcile on the server, then reloads the page data.
 * "Last updated" comes from the server's last successful sync, so it only moves when a sync
 * actually completed. One SWR key is shared with the detailed strip in Settings.
 */
export function useSyncRefresh(initial: SyncPanel) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const { data, mutate } = useSWR(SYNC_PANEL_KEY, fetchSyncPanel, { fallbackData: initial, refreshInterval: 60_000, revalidateOnFocus: true })
  const panel = data ?? initial

  const refresh = () => {
    if (pending) return
    startTransition(async () => {
      setError(null)
      const res = await runReconcile()
      if (!res.ok) {
        setError(res.error)
        await mutate()
        return
      }
      const d = res.data!
      if (!d.complete) setError(d.quotaHit ? "Workiz API quota reached; the sync stopped early. Try again in about 20 minutes." : `Sync finished with ${d.failed} failed job${d.failed === 1 ? "" : "s"}. Details are in Settings → Activity.`)
      await mutate()
      router.refresh()
    })
  }

  return { panel, pending, error, refresh, busy: pending || Boolean(panel.running) }
}

export type SyncRefresh = ReturnType<typeof useSyncRefresh>

export function RefreshButton({ sync }: { sync: SyncRefresh }) {
  return (
    <Button variant="outline" size="sm" onClick={sync.refresh} disabled={sync.busy} aria-busy={sync.busy} className="h-9 px-3">
      <RefreshCw className={`h-4 w-4 ${sync.busy ? "animate-spin" : ""}`} aria-hidden="true" />
      {sync.pending ? "Refreshing…" : sync.panel.running ? "Syncing…" : "Refresh"}
    </Button>
  )
}

export function LastUpdatedLine({ sync, timezone }: { sync: SyncRefresh; timezone: string }) {
  const s = sync.panel
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground" aria-live="polite">
      <span>{s.lastSuccessAt ? `Last updated ${zonedDateTime(s.lastSuccessAt, timezone)}` : "Not synced with Workiz yet"}</span>
      {s.health === "overdue" && !sync.error && <span className="text-warning-foreground">Scheduled sync did not run</span>}
      {sync.error && (
        <span className="flex flex-wrap items-center gap-2 text-warning-foreground">
          <span>{sync.error}</span>
          <button type="button" onClick={sync.refresh} disabled={sync.busy} className="font-medium underline underline-offset-4 disabled:opacity-50">
            Retry
          </button>
        </span>
      )}
    </div>
  )
}
