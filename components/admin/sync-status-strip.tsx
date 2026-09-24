"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { AlertTriangle, CheckCircle2, Clock, RefreshCw } from "lucide-react"
import type { SyncPanel } from "@/app/actions/admin"
import { fetchSyncPanel, runReconcile } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { InlineMessage, zonedDateTime } from "./shared"

/**
 * The one line that answers "is the data current?". Polls the server every minute while the tab is
 * open so a sync started by the schedule shows up without a reload.
 */
export function SyncStatusStrip({ initial, timezone, onOpenWorkizTab }: { initial: SyncPanel; timezone: string; onOpenWorkizTab: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const { data, mutate } = useSWR("sync-panel", fetchSyncPanel, { fallbackData: initial, refreshInterval: 60_000, revalidateOnFocus: true })
  const s = data ?? initial

  const syncNow = () =>
    startTransition(async () => {
      setMessage(null)
      const res = await runReconcile()
      if (!res.ok) {
        setMessage({ tone: "error", text: res.error })
        await mutate()
        return
      }
      const d = res.data!
      setMessage({
        tone: d.failed ? "info" : "ok",
        text: `Checked ${d.scanned} jobs since ${d.startDate}: ${d.created} new payout${d.created === 1 ? "" : "s"}, ${d.updated} updated, ${d.held} held${d.failed ? `, ${d.failed} failed` : ""}${d.unmappedTeamIds.length ? `. Unmapped team ids: ${d.unmappedTeamIds.join(", ")}` : ""}.`,
      })
      await mutate()
      router.refresh()
    })

  const Icon = s.running ? RefreshCw : s.health === "ok" ? CheckCircle2 : s.health === "overdue" ? AlertTriangle : Clock
  const tone = s.running ? "text-primary" : s.health === "ok" ? "text-primary" : s.health === "overdue" ? "text-warning-foreground" : "text-muted-foreground"

  const headline = s.running
    ? `Syncing now (started ${zonedDateTime(s.running.since, timezone)})`
    : s.health === "never"
      ? "Workiz has not been synced yet"
      : s.health === "overdue"
        ? `Last successful sync ${zonedDateTime(s.lastSuccessAt, timezone)} · the ${s.scheduleLabel.split(",")[0]} run did not happen`
        : `Up to date · last synced ${zonedDateTime(s.lastSuccessAt, timezone)}`

  const detail = s.lastAttemptOk === false && s.lastAttemptSummary ? `Last attempt failed: ${s.lastAttemptSummary}` : s.lastSuccessSummary

  return (
    <section aria-label="Sync status" className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone} ${s.running ? "animate-spin" : ""}`} aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">{headline}</p>
            <p className="text-xs text-muted-foreground">
              {s.cronConfigured ? `Runs ${s.scheduleLabel}; next at ${s.nextSlotLabel}.` : "Automatic runs are not configured on this deployment."}
              {detail ? ` ${detail}` : ""}
              {!s.cronConfigured && (
                <>
                  {" "}
                  <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={onOpenWorkizTab}>
                    See Workiz settings
                  </button>
                </>
              )}
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={pending || Boolean(s.running)} onClick={syncNow}>
          <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />
          {pending ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
    </section>
  )
}
