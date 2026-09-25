"use client"

import { useState, useTransition } from "react"
import type { OpeningPreview } from "@/lib/payout/opening"
import { previewOpening, runOpeningInitialization } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { InlineMessage, money, zonedDateTime } from "./shared"

/**
 * One-time setup: the owner declares "everyone is paid up as of this moment". Every due payout
 * completed before that instant is settled into an opening-balance batch per technician, so the
 * Due tab starts at zero and history shows what was carried in. Nothing after the cutoff is touched.
 */
export function OpeningBalanceCard({ timezone, onDone }: { timezone: string; onDone: () => void }) {
  const [cutoff, setCutoff] = useState(() => defaultCutoffLocal())
  const [preview, setPreview] = useState<OpeningPreview | null>(null)
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const load = () =>
    startTransition(async () => {
      setMessage(null)
      setPreview(null)
      const res = await previewOpening(new Date(cutoff).toISOString())
      if (!res.ok) return setMessage({ tone: "error", text: res.error })
      setPreview(res.data!)
    })

  const commit = () =>
    startTransition(async () => {
      setMessage(null)
      const res = await runOpeningInitialization(new Date(cutoff).toISOString())
      if (!res.ok) return setMessage({ tone: "error", text: res.error })
      const d = res.data!
      setMessage({ tone: "ok", text: `Opening balance recorded: ${d.settled} payout${d.settled === 1 ? "" : "s"} (${money(d.calculatedTotal)}) carried in as previously paid across ${d.batchIds.length} technician${d.batchIds.length === 1 ? "" : "s"}.${d.issues ? ` ${d.issues} job${d.issues === 1 ? "" : "s"} could not be placed and stay as they are.` : ""}` })
      setPreview(null)
      onDone()
    })

  const total = preview ? preview.technicians.reduce((cents, t) => cents + Math.round(t.calculatedTotal * 100), 0) / 100 : 0
  const provisional = preview ? preview.technicians.reduce((n, t) => n + t.provisional, 0) : 0

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Start here: record your opening balance</CardTitle>
        <CardDescription>
          Pick the moment everyone was paid up. Jobs finished before it are filed as previously paid so they never show as due; jobs finished after it stay due. You can do this once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-cutoff">Everyone was paid up as of</Label>
            <Input id="opening-cutoff" type="datetime-local" value={cutoff} onChange={(e) => setCutoff(e.target.value)} className="w-64" />
          </div>
          <Button type="button" variant="secondary" disabled={pending || !cutoff} onClick={load}>
            {pending && !preview ? "Checking…" : "Preview"}
          </Button>
          <p className="text-xs text-muted-foreground">Times are read in your browser&apos;s clock; the summary below shows them in {timezone}.</p>
        </div>

        {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}

        {preview && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Cutoff {zonedDateTime(preview.cutoffAt, timezone)}: <strong>{money(total)}</strong> across {preview.technicians.length} technician{preview.technicians.length === 1 ? "" : "s"} will be filed as previously paid.
              {preview.afterCutoff > 0 && ` ${preview.afterCutoff} payout${preview.afterCutoff === 1 ? "" : "s"} finished after the cutoff stay due.`}
              {preview.waitingJobs > 0 && ` ${preview.waitingJobs} pre-cutoff job${preview.waitingJobs === 1 ? "" : "s"} still unpaid by the customer stay waiting.`}
              {preview.legacyPaid > 0 && ` ${preview.legacyPaid} payout${preview.legacyPaid === 1 ? "" : "s"} marked paid before this update are left as they are.`}
            </p>
            {preview.technicians.length > 0 && (
              <ul className="flex flex-col divide-y rounded-md border text-sm">
                {preview.technicians.map((t) => (
                  <li key={t.profileId} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span>
                      {t.name} <span className="text-muted-foreground">· {t.items.length} job{t.items.length === 1 ? "" : "s"}</span>
                      {t.provisional > 0 && <span className="text-warning-foreground"> · {t.provisional} on hold, filed at the provisional amount</span>}
                    </span>
                    <span className="tabular-nums font-medium">{money(t.calculatedTotal)}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.issues.length > 0 && (
              <div className="flex flex-col gap-1 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
                <p className="font-medium text-warning-foreground">{preview.issues.length} job{preview.issues.length === 1 ? "" : "s"} cannot be placed and will be left alone</p>
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {preview.issues.slice(0, 8).map((i) => (
                    <li key={i.jobUuid}>
                      #{i.serialId ?? "—"} · {i.clientName ?? "Unknown"} · {i.reason}
                    </li>
                  ))}
                  {preview.issues.length > 8 && <li>…and {preview.issues.length - 8} more</li>}
                </ul>
              </div>
            )}
            {provisional > 0 && <InlineMessage tone="info">Held payouts are carried in at their current calculated amount and marked provisional in history, so a later correction is still possible.</InlineMessage>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">This writes history only. Nothing is sent to Workiz or to technicians.</p>
              <Button type="button" disabled={pending} onClick={commit}>
                {pending ? "Recording…" : `Record opening balance · ${money(total)}`}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Start of today in the browser's clock, formatted for a datetime-local input. */
function defaultCutoffLocal() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
