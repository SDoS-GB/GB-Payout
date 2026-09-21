"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, Copy, Tag } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { tagJobForPayoutTest, updatePayoutTagSettings } from "@/app/actions/admin"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { InlineMessage, shortDateTime } from "./shared"
import { SetupStep } from "./webhook-setup-card"

type Workiz = AdminDashboardData["workiz"]

export function PayoutTextAlertsCard({ workiz, dashboardUrl }: { workiz: Workiz; dashboardUrl: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const [enabled, setEnabled] = useState(workiz.payoutReadyTagEnabled)
  const [tag, setTag] = useState(workiz.payoutReadyTag)
  const [testRef, setTestRef] = useState("")
  const [copied, setCopied] = useState(false)

  const cleanTag = tag.trim().replace(/\s+/g, " ")
  const dirty = enabled !== workiz.payoutReadyTagEnabled || cleanTag !== workiz.payoutReadyTag
  const status = alertStatus(workiz)
  const tagApplied = Boolean(workiz.lastTagEvent?.ok)
  const messageTemplate = `Payout ready: job #[Job ID] for [Client name] ([Job total]). Review and pay: ${dashboardUrl}`

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(messageTemplate)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const save = () =>
    startTransition(async () => {
      setMsg(null)
      const res = await updatePayoutTagSettings({ enabled, tag: cleanTag })
      if (!res.ok) return setMsg({ tone: "error", text: res.error })
      const savedTag = res.data?.tag ?? cleanTag
      setTag(savedTag)
      setMsg({
        tone: "ok",
        text: enabled
          ? `Saved. From the next sync on, every job with a ready payout gets tagged "${savedTag}" once.`
          : "Saved. Jobs will not be tagged until you turn this back on.",
      })
      router.refresh()
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Text me when a payout is ready</CardTitle>
            <CardDescription>
              Workiz sends the text from your own account. The first time a job has a payout that is ready to pay, this app adds a tag to the job in
              Workiz; a Workiz automation on that tag texts you. One text per job, no extra SMS service.
            </CardDescription>
          </div>
          <Badge variant={status.variant} className="shrink-0">
            {status.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3 sm:flex-row sm:items-end">
          <div className="flex items-center gap-3 sm:pb-2">
            <Switch id="payout-tag-enabled" checked={enabled} onCheckedChange={setEnabled} aria-describedby="payout-tag-enabled-help" />
            <Label htmlFor="payout-tag-enabled" className="text-sm">
              Tag jobs in Workiz
            </Label>
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="payout-tag-name" className="text-xs">
              Tag name (must already exist in Workiz)
            </Label>
            <Input id="payout-tag-name" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={60} placeholder="Payout Ready" />
          </div>
          <Button type="button" size="sm" disabled={pending || !dirty || !cleanTag} onClick={save}>
            Save
          </Button>
        </div>
        <p id="payout-tag-enabled-help" className="sr-only">
          When on, jobs with a ready payout receive the tag on the next sync.
        </p>

        <ol className="flex flex-col gap-5">
          <SetupStep n={1} title={`Create the "${cleanTag || "Payout Ready"}" tag in Workiz`} done={tagApplied}>
            <p className="text-xs text-muted-foreground">
              Open any job in Workiz, select <span className="font-medium">+</span> next to Tags, choose <span className="font-medium">Create new tag</span> and
              name it exactly <span className="font-mono">{cleanTag || "Payout Ready"}</span>. The Workiz API can only apply tags that already exist; it
              silently ignores unknown names, so this step is required.
            </p>
          </SetupStep>

          <SetupStep n={2} title="Create the automation in Workiz">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed">
              <li>
                Open <span className="font-medium">Automations</span> and select <span className="font-medium">Add automation</span>.
              </li>
              <li>
                <span className="font-medium">This happens</span>: choose the job trigger for a tag being added and pick{" "}
                <span className="font-mono">{cleanTag || "Payout Ready"}</span>. If your Workiz plan only offers status triggers, use{" "}
                <span className="font-medium">Job is updated</span> and add the condition <span className="font-medium">Job tag = {cleanTag || "Payout Ready"}</span>.
              </li>
              <li>
                <span className="font-medium">Do this</span>: choose <span className="font-medium">Send text message</span> → <span className="font-medium">Team member</span> and
                select yourself.
              </li>
              <li>
                Message: paste the template below, then replace each bracketed part with the matching short code from the <span className="font-mono">{"{...}"}</span>{" "}
                library (Job ID, Client name, Job total).
              </li>
              <li>
                Set the timing to <span className="font-medium">Immediately</span> and select <span className="font-medium">Add automation</span>.
              </li>
            </ol>
            <div className="flex items-center gap-2">
              <Input readOnly value={messageTemplate} className="font-mono text-xs" aria-label="Text message template" />
              <Button type="button" size="icon" variant="outline" onClick={copyTemplate} aria-label="Copy message template">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </SetupStep>

          <SetupStep n={3} title="Send yourself a test" done={tagApplied}>
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              onSubmit={(e) => {
                e.preventDefault()
                startTransition(async () => {
                  setMsg(null)
                  const res = await tagJobForPayoutTest(testRef)
                  if (!res.ok) return setMsg({ tone: "error", text: res.error })
                  setMsg({ tone: "ok", text: res.data?.summary ?? "Tagged." })
                  setTestRef("")
                  router.refresh()
                })
              }}
            >
              <Input
                value={testRef}
                onChange={(e) => setTestRef(e.target.value)}
                placeholder="Job number, e.g. 924738"
                aria-label="Job number or UUID to tag"
                className="sm:max-w-56"
              />
              <Button type="submit" size="sm" variant="outline" disabled={pending || !testRef.trim()}>
                <Tag className="h-4 w-4" />
                Tag this job now
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              Adds the tag to that job for real and, if the automation is live, texts you within a minute. The app cannot remove tags, so use a job
              that is already paid out. A job that already has the tag will not trigger a second text.
            </p>
          </SetupStep>
        </ol>

        {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}

        {workiz.lastTagEvent && (
          <p className="text-xs text-muted-foreground">
            Last tagging attempt: {shortDateTime(workiz.lastTagEvent.createdAt)} — {workiz.lastTagEvent.summary}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Payouts on hold are not tagged until you release them. When you turn this on, every job that already has a ready payout is tagged on the
          next sync, so expect one text per such job the first time.
        </p>
      </CardContent>
    </Card>
  )
}

function alertStatus(workiz: Workiz): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  if (!workiz.payoutReadyTagEnabled) return { label: "Off", variant: "outline" }
  if (!workiz.lastTagEvent) return { label: "On · waiting for first payout", variant: "secondary" }
  if (!workiz.lastTagEvent.ok) return { label: "Last tag failed", variant: "destructive" }
  return { label: `Active · ${shortDateTime(workiz.lastTagEvent.createdAt)}`, variant: "default" }
}
