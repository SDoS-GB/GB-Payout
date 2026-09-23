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
  const messageTemplate = `Mark paid: ${dashboardUrl}`
  const previewBlock = ["PAYOUT READY (GB app)", "Job #924738 - Milano", "Completed Sep 21, 2026", "Client payments: Card $475.00", "Card fee applied proportionally.", "Tip $20.00 (Arthur $10.00, Vadim $10.00)", "Arthur: $105.00 (crew work)", "Vadim: $98.50 (crew work)"].join("\n")

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
        text: `${enabled ? `Saved. Every job with a ready payout gets tagged "${savedTag}" once.` : "Saved. Jobs will not be tagged until you turn this back on."} ${res.data?.effect ?? ""}`.trim(),
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
              Workiz sends the text from your own account. Once every payout on a job is ready, this app adds a tag to the job in Workiz and writes
              a payout summary at the top of the job&apos;s description (each technician&apos;s own amount, how the client paid, tip and completion
              date). A Workiz automation on that tag texts you the description. One text per job, no extra SMS service. Pick who receives it and
              watch each job&apos;s text in the <span className="font-medium">Owner texts</span> tab.
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

          <SetupStep n={2} title="Create a separate text automation in Workiz">
            <p className="text-xs text-muted-foreground">
              This is a second automation, not the webhook one. The webhook automation (Job status → Post webhook) must have{" "}
              <span className="font-medium">no tag condition</span>: it is what tells this app the job is done, and the tag does not exist yet at that
              moment.
            </p>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed">
              <li>
                Open <span className="font-medium">Automations</span> and select <span className="font-medium">Add automation</span>.
              </li>
              <li>
                <span className="font-medium">This happens</span>: choose the job trigger for a tag being added and pick{" "}
                <span className="font-mono">{cleanTag || "Payout Ready"}</span>. If your plan only offers status triggers, use{" "}
                <span className="font-medium">Job has a status of {"Done"}</span>, set the timing to <span className="font-medium">10 minutes after</span>{" "}
                <span className="font-medium">last status change date</span>, and add the condition <span className="font-medium">Job tag = {cleanTag || "Payout Ready"}</span>{" "}
                so the tag has time to arrive before Workiz checks it.
              </li>
              <li>
                <span className="font-medium">Do this</span>: choose <span className="font-medium">Send text message</span> → <span className="font-medium">Team member</span> and
                select yourself. Not <span className="font-medium">Post webhook</span> — a webhook never texts anyone.
              </li>
              <li>
                Message: select the <span className="font-mono">{"{...}"}</span> button and choose <span className="font-medium">Job description</span> (it
                lands as a chip, not typed text), then paste the line below after it. Never type placeholders like{" "}
                <span className="font-mono">[Job ID]</span> by hand — Workiz sends typed text exactly as written. Workiz has no short code for payment
                method, tip or payout, so the app puts them in the description for you.
              </li>
              <li>
                Select <span className="font-medium">Add automation</span>.
              </li>
            </ol>
            <div className="flex items-center gap-2">
              <Input readOnly value={messageTemplate} className="font-mono text-xs" aria-label="Text message template" />
              <Button type="button" size="icon" variant="outline" onClick={copyTemplate} aria-label="Copy message template">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">What the description (and so the text) will contain, for example:</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">{previewBlock}</pre>
              <p className="text-xs text-muted-foreground">
                Whatever the office typed in the description stays below this block. Technicians who open the job in Workiz will see it too.
              </p>
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
              Adds the tag and a clearly marked TEST block to that job for real; it is never recorded as a payout text. If your Workiz automation
              triggers on the tag, the text arrives within a minute; if it triggers on the Done status, this test only writes the tag and block
              (open the job in Workiz to see it) and the text comes with the next real job. The app cannot remove tags, so use a job that is already
              paid out. A job that already has the tag will not trigger a second text.
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
          A job is texted only when every payout on it is ready (none pending or on hold) and the client has paid in full. When you turn this on,
          every job already in that state is tagged on the next sync, so expect one text per such job the first time.
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
