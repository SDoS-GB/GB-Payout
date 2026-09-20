"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, Copy, KeyRound, Zap } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { rotateWebhookSecret, testWebhookEndpoint } from "@/app/actions/admin"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { InlineMessage, shortDateTime } from "./shared"

type Workiz = AdminDashboardData["workiz"]

export function WebhookSetupCard({ workiz, webhookUrl, cronConfigured }: { workiz: Workiz; webhookUrl: string; cronConfigured: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setCopied(null)
    }
  }

  const status = connectionStatus(workiz)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Instant updates from Workiz</CardTitle>
            <CardDescription>
              A Workiz Automation posts to this app the moment a job is marked done or an invoice is paid, so payouts appear here within seconds instead
              of waiting for the 6-hour reconcile.
            </CardDescription>
          </div>
          <Badge variant={status.variant} className="shrink-0">
            {status.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {workiz.lastWebhook && (
          <p className="text-xs text-muted-foreground">
            Last event from Workiz: {shortDateTime(workiz.lastWebhook.createdAt)} — {workiz.lastWebhook.summary ?? workiz.lastWebhook.kind}
          </p>
        )}

        <ol className="flex flex-col gap-5">
          <Step n={1} title="Create the auth key" done={workiz.hasWebhookSecret}>
            <p className="text-xs text-muted-foreground">
              Workiz sends this key with every call so nobody else can trigger a sync. Paste the key exactly as shown; Workiz adds the word
              &quot;Bearer&quot; itself.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input readOnly value={workiz.hasWebhookSecret ? workiz.webhookSecret : "No key yet"} className="font-mono text-xs" aria-label="Auth key" />
              <div className="flex items-center gap-2">
                <Button type="button" size="icon" variant="outline" disabled={!workiz.hasWebhookSecret} onClick={() => copy("key", workiz.webhookSecret)} aria-label="Copy auth key">
                  {copied === "key" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={workiz.hasWebhookSecret ? "outline" : "default"}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      setMsg(null)
                      const res = await rotateWebhookSecret()
                      if (!res.ok) return setMsg({ tone: "error", text: res.error })
                      setMsg({
                        tone: "info",
                        text: workiz.hasWebhookSecret
                          ? "New key generated. Every Workiz automation that posts here must be updated with it."
                          : "Key generated. Copy it into the Workiz automation below.",
                      })
                      router.refresh()
                    })
                  }
                >
                  <KeyRound className="h-4 w-4" />
                  {workiz.hasWebhookSecret ? "Rotate" : "Generate key"}
                </Button>
              </div>
            </div>
          </Step>

          <Step n={2} title="Copy the webhook URL">
            <div className="flex items-center gap-2">
              <Input readOnly value={webhookUrl} className="font-mono text-xs" aria-label="Webhook URL" />
              <Button type="button" size="icon" variant="outline" onClick={() => copy("url", webhookUrl)} aria-label="Copy webhook URL">
                {copied === "url" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </Step>

          <Step n={3} title="Create two automations in Workiz">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed">
              <li>
                In Workiz open <span className="font-medium">Automations</span> (top bar) and select <span className="font-medium">Add automation</span>.
              </li>
              <li>
                <span className="font-medium">This happens</span>: choose the job trigger <span className="font-medium">Job status changed</span> and pick your
                payable status ({workiz.payableStatuses.join(", ") || "Done"}).
              </li>
              <li>
                <span className="font-medium">Do this</span>: choose <span className="font-medium">Post webhook</span> → <span className="font-medium">Add URL</span>.
                Paste the URL from step 2 and the key from step 1 into <span className="font-medium">Auth key</span>. Save.
              </li>
              <li>
                Select <span className="font-medium">Add automation</span>.
              </li>
              <li>
                Repeat once more with an invoice trigger such as <span className="font-medium">Invoice paid</span> (or payment received), so a customer who pays
                after the job was marked done also triggers an update.
              </li>
            </ol>
            <p className="text-xs text-muted-foreground">
              Lead and estimate events are ignored automatically. Each event only tells the app which job changed; every amount is re-read from the Workiz
              API before a payout is calculated.
            </p>
          </Step>

          <Step n={4} title="Confirm it works" done={Boolean(workiz.lastWebhook?.ok)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || !workiz.hasWebhookSecret}
                onClick={() =>
                  startTransition(async () => {
                    setMsg(null)
                    const res = await testWebhookEndpoint()
                    if (!res.ok) return setMsg({ tone: "error", text: res.error })
                    setMsg({ tone: "ok", text: res.data?.summary ?? "Self-test passed" })
                    router.refresh()
                  })
                }
              >
                <Zap className="h-4 w-4" />
                Test endpoint
              </Button>
              <p className="text-xs text-muted-foreground">
                Checks that the URL is live and the key is accepted. Then change a test job&apos;s status in Workiz: the badge above turns to
                &quot;Connected&quot; and the job shows up under Activity.
              </p>
            </div>
          </Step>
        </ol>

        {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}

        <p className="text-xs text-muted-foreground">
          Fallback reconcile every 6 hours (<span className="font-mono">0 */6 * * *</span>):{" "}
          {cronConfigured ? "active." : "add a CRON_SECRET environment variable so Vercel Cron can authenticate."}
        </p>
      </CardContent>
    </Card>
  )
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-sm font-medium leading-6">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  )
}

function connectionStatus(workiz: Workiz): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  if (!workiz.hasWebhookSecret) return { label: "Not set up", variant: "outline" }
  if (!workiz.lastWebhook) return { label: "Waiting for first event", variant: "secondary" }
  if (!workiz.lastWebhook.ok) return { label: "Last event failed", variant: "destructive" }
  return { label: `Connected · ${shortDateTime(workiz.lastWebhook.createdAt)}`, variant: "default" }
}
