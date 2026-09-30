"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { syncSingleJob } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { InlineMessage } from "./shared"

/** Technical diagnostic: re-fetch one Workiz job and recompute its payouts right now. */
export function ResyncJobCard() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [uuid, setUuid] = useState("")
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Re-sync one job</CardTitle>
        <CardDescription>Fetches the job from Workiz again and recalculates its payouts. Paid and voided payouts are never changed.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            const id = uuid.trim()
            if (!id) return
            startTransition(async () => {
              setMessage(null)
              const res = await syncSingleJob(id)
              if (!res.ok) return setMessage({ tone: "error", text: res.error })
              const d = res.data!
              setMessage({ tone: "ok", text: `Job ${id} (${d.status ?? "?"}): ${d.created} new, ${d.updated} updated, ${d.held} held.${d.notes.length ? ` ${d.notes.join(" · ")}` : ""}` })
              setUuid("")
              router.refresh()
            })
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="resync-uuid">Workiz job UUID</Label>
            <Input id="resync-uuid" value={uuid} onChange={(e) => setUuid(e.target.value)} placeholder="e.g. 7HKYSL" className="h-11" />
          </div>
          <Button type="submit" variant="secondary" disabled={pending || !uuid.trim()} className="h-11">
            {pending ? "Syncing…" : "Sync job"}
          </Button>
        </form>
        {message && (
          <div className="pt-3">
            <InlineMessage tone={message.tone}>{message.text}</InlineMessage>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
