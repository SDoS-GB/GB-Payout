"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, Eye, RefreshCw, Send, UserRound } from "lucide-react"
import type { AdminDashboardData, OwnerRecipientCandidate } from "@/app/actions/admin"
import { confirmOwnerTextReceived, listOwnerRecipientCandidates, previewOwnerText, runReconcile, sendPayoutToOwner, setOwnerRecipient } from "@/app/actions/admin"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { describeOwnerState, MAX_ATTEMPTS } from "@/lib/notifications/owner-message"
import { InlineMessage, OwnerTextBadge, money, zonedDateTime } from "./shared"

type OwnerTexts = AdminDashboardData["ownerTexts"]
type OwnerRow = OwnerTexts["rows"][number]
type Msg = { tone: "ok" | "error" | "info"; text: string } | null

export function OwnerTextsTab({ data, lastWebhook, timezone, onOpenWorkizTab }: { data: OwnerTexts; lastWebhook: AdminDashboardData["workiz"]["lastWebhook"]; timezone: string; onOpenWorkizTab: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <RecipientCard data={data} onOpenWorkizTab={onOpenWorkizTab} />
      <DiagnosticsCard data={data} lastWebhook={lastWebhook} timezone={timezone} />
      <OwnerTextsTable rows={data.rows} timezone={timezone} />
      <WebhookLogCard log={data.webhookLog} timezone={timezone} />
    </div>
  )
}

function RecipientCard({ data, onOpenWorkizTab }: { data: OwnerTexts; onOpenWorkizTab: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<Msg>(null)
  const [candidates, setCandidates] = useState<OwnerRecipientCandidate[] | null>(null)
  const [choice, setChoice] = useState<string>(data.recipient?.workizTeamId ?? "")

  const loadCandidates = () =>
    startTransition(async () => {
      setMsg(null)
      const res = await listOwnerRecipientCandidates()
      if (!res.ok) return setMsg({ tone: "error", text: res.error })
      setCandidates(res.data ?? [])
      if (!res.data?.length) setMsg({ tone: "info", text: "Workiz returned no team members. Check the API token in the Workiz tab." })
    })

  const save = (id: string | null) =>
    startTransition(async () => {
      setMsg(null)
      const res = await setOwnerRecipient(id)
      if (!res.ok) return setMsg({ tone: "error", text: res.error })
      setMsg({
        tone: "ok",
        text: `${res.data?.name ? `Owner texts are addressed to ${res.data.name}. Make sure the Workiz automation texts the same person.` : "Recipient cleared. Owner texts stay blocked until you pick one."} ${res.data?.effect ?? ""}`.trim(),
      })
      setCandidates(null)
      router.refresh()
    })

  const switchState = !data.hasCredentials ? { label: "No Workiz API credentials", variant: "destructive" as const } : data.sendEnabled ? { label: `On · tag "${data.tag}"`, variant: "default" as const } : { label: "Off · preview only", variant: "outline" as const }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Who gets the payout text</CardTitle>
            <CardDescription>
              One text per job, sent through your own Workiz account: the app tags the job and writes the payout block into the job description; your Workiz
              automation texts that description to the team member you choose here. The app records who that is so it never reports &quot;sent&quot; to nobody.
            </CardDescription>
          </div>
          <Badge variant={switchState.variant} className="shrink-0">
            {switchState.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <UserRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <div className="flex flex-col">
              <span className="text-sm font-medium">{data.recipient ? data.recipient.name : "Not configured"}</span>
              <span className="text-xs text-muted-foreground">
                {data.recipient ? (data.recipient.phoneMasked ? `Workiz profile phone ${data.recipient.phoneMasked}` : "No phone on the Workiz profile; the automation still decides who is texted") : "Owner texts are blocked until a recipient is chosen."}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {candidates === null && (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={loadCandidates}>
                {data.recipient ? "Change" : "Choose recipient"}
              </Button>
            )}
            {data.recipient && (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => save(null)}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {candidates !== null && candidates.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="owner-recipient" className="text-xs">
                Workiz team member
              </Label>
              <Select value={choice} onValueChange={setChoice}>
                <SelectTrigger id="owner-recipient">
                  <SelectValue placeholder="Pick the person your automation texts" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.workizTeamId} value={c.workizTeamId}>
                      {c.name}
                      {c.role ? ` · ${c.role}` : ""}
                      {c.phoneMasked ? ` · ${c.phoneMasked}` : " · no phone"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={pending || !choice} onClick={() => save(choice)}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setCandidates(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}

        <p className="text-xs text-muted-foreground">
          Sending is switched on and off, and tested, in the{" "}
          <button type="button" className="underline underline-offset-2" onClick={onOpenWorkizTab}>
            Workiz tab
          </button>{" "}
          (&quot;Text me when a payout is ready&quot;). While it is off, every eligible job is stored as <span className="font-medium">Preview only</span> so you can read
          the exact message without anything being sent.
        </p>
      </CardContent>
    </Card>
  )
}

function DiagnosticsCard({ data, lastWebhook, timezone }: { data: OwnerTexts; lastWebhook: AdminDashboardData["workiz"]["lastWebhook"]; timezone: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<Msg>(null)
  const r = data.reconcile

  const byState = useMemo(() => {
    const out: Record<string, number> = {}
    for (const row of data.rows) out[row.status] = (out[row.status] ?? 0) + 1
    return out
  }, [data.rows])

  const unresolved = data.webhookCounts.unresolved ?? 0
  const failedEvents = data.webhookCounts.failed ?? 0

  const run = () =>
    startTransition(async () => {
      setMsg(null)
      const res = await runReconcile()
      if (!res.ok) return setMsg({ tone: "error", text: res.error })
      const d = res.data!
      const quota = d.quotaHit
        ? ` Workiz API quota reached: the run stopped early and left ${d.deferred} job(s) for the next scheduled run; nothing was lost.`
        : d.deferred
          ? ` ${d.deferred} job(s) deferred to the next run to stay inside the Workiz quota.`
          : ""
      setMsg({
        tone: d.quotaHit ? "error" : d.failed ? "info" : "ok",
        text: `Listed ${d.scanned} jobs since ${d.startDate} (${d.lookbackDays}-day window): ${d.unchanged} unchanged, ${d.detailFetches} fetched from Workiz (budget ${d.detailBudget}), ${d.revisited} open job(s) revisited, ${d.replay.replayed} webhook event(s) replayed (${d.replay.resolved} resolved). Owner texts: ${d.outbox.accepted} accepted, ${d.outbox.failed} failed, ${d.outbox.notEligible} not eligible, ${d.ownerReevaluated} re-checked.${quota}`,
      })
      router.refresh()
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Is the pipeline alive?</CardTitle>
            <CardDescription>What last reached the app, when the scheduled reconcile last ran, and what is waiting. Every run also delivers queued texts and retries failures.</CardDescription>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={run}>
            <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />
            Run reconcile now
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Last webhook from Workiz" value={lastWebhook ? zonedDateTime(lastWebhook.createdAt, timezone) : "Never"} detail={lastWebhook ? `${lastWebhook.ok ? "OK" : "Failed"} · ${lastWebhook.summary ?? lastWebhook.kind}` : "Set up the webhook automation in the Workiz tab."} tone={lastWebhook && !lastWebhook.ok ? "error" : undefined} />
          <Fact label="Last job sync" value={r.lastJobSyncAt ? zonedDateTime(r.lastJobSyncAt, timezone) : "Never"} detail="Any webhook, cron or manual sync that processed a job." />
          <Fact
            label="Last scheduled reconcile"
            value={r.last ? zonedDateTime(r.last.createdAt, timezone) : "Never"}
            detail={
              r.last
                ? [
                    r.last.quotaHit ? "Stopped early: Workiz API quota" : r.last.ok ? "OK" : "Failed",
                    r.last.lookbackDays ? `${r.last.lookbackDays}-day window` : null,
                    r.last.detailFetches !== null ? `${r.last.detailFetches}/${r.last.detailBudget ?? "?"} Workiz fetches` : null,
                    `revisited ${r.last.revisited ?? 0}`,
                    r.last.deferred ? `${r.last.deferred} deferred to next run` : null,
                    r.last.outbox ? `owner texts ${r.last.outbox.accepted} accepted / ${r.last.outbox.failed} failed` : "owner texts not part of this run",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "Vercel Cron runs it on the schedule in vercel.json."
            }
            tone={r.last && r.last.quotaHit ? "warn" : r.last && !r.last.ok ? "error" : undefined}
          />
          <Fact label="Last successful reconcile" value={r.lastSuccessfulAt ? zonedDateTime(r.lastSuccessfulAt, timezone) : "Never"} detail="If this is old while the last run failed, the error is in the Activity tab." />
          <Fact
            label="Webhook events waiting"
            value={`${unresolved} unresolved · ${failedEvents} failed`}
            detail="Unresolved events name a job the app has not synced yet; each reconcile replays them once the job is known."
            tone={unresolved + failedEvents > 0 ? "warn" : undefined}
          />
          <Fact
            label="Owner texts by state"
            value={Object.keys(byState).length ? Object.entries(byState).map(([s, n]) => `${describeOwnerState(s).label} ${n}`).join(" · ") : "None yet"}
            detail={`${data.rows.length} job(s) evaluated (latest 100 shown below).`}
          />
        </dl>
        {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
      </CardContent>
    </Card>
  )
}

function Fact({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warn" | "error" }) {
  const valueCls = tone === "error" ? "text-destructive-foreground" : tone === "warn" ? "text-warning-foreground" : ""
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`font-medium ${valueCls}`}>{value}</dd>
      {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  )
}

function OwnerTextsTable({ rows, timezone }: { rows: OwnerRow[]; timezone: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<Msg>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ id: number; state: string; reason: string | null; message: string | null } | null>(null)

  const act = (fn: () => Promise<{ ok: boolean; error?: string; tone?: "ok" | "error" | "info"; text?: string }>) =>
    startTransition(async () => {
      setMsg(null)
      const res = await fn()
      if (!res.ok) return setMsg({ tone: "error", text: res.error ?? "Failed" })
      if (res.text) setMsg({ tone: res.tone ?? "ok", text: res.text })
      router.refresh()
    })

  const send = (row: OwnerRow, force: boolean) =>
    act(async () => {
      const res = await sendPayoutToOwner(row.jobUuid, force)
      if (!res.ok) return res
      const d = res.data!
      return { ok: true, tone: d.outcome === "provider_accepted" ? "ok" : d.outcome === "failed" ? "error" : "info", text: `Job #${row.job?.serialId ?? row.jobUuid}: ${d.detail}` }
    })

  const confirm = (row: OwnerRow) =>
    act(async () => {
      const res = await confirmOwnerTextReceived(row.id)
      return res.ok ? { ok: true, text: `Job #${row.job?.serialId ?? row.jobUuid} marked as received by the owner.` } : res
    })

  const showPreview = (row: OwnerRow) =>
    startTransition(async () => {
      setMsg(null)
      if (preview?.id === row.id) return setPreview(null)
      const res = await previewOwnerText(row.jobUuid)
      if (!res.ok) return setMsg({ tone: "error", text: res.error })
      setPreview({ id: row.id, ...res.data! })
      setOpenId(row.id)
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Owner texts by job</CardTitle>
        <CardDescription>
          One row per job. <span className="font-medium">Provider accepted</span> means Workiz confirmed the tag and summary are on the job; the SMS itself is sent by your
          Workiz automation, so confirm receipt once it arrives. A payout change after a send shows as &quot;sent for an earlier version&quot;.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No job has been evaluated yet. Texts appear here as soon as a synced job has a payout.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Job in Workiz</TableHead>
                  <TableHead>Text state</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Last change</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const staleSend = Boolean(row.sentSnapshotHash && row.snapshotHash && row.sentSnapshotHash !== row.snapshotHash)
                  const accepted = row.status === "provider_accepted" || row.status === "delivered"
                  const expanded = openId === row.id
                  return (
                    <RowGroup key={row.id}>
                      <TableRow className={expanded ? "bg-muted/30" : undefined}>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-col">
                            <span className="font-medium">#{row.job?.serialId ?? row.jobUuid.slice(0, 8)}</span>
                            <span className="text-xs text-muted-foreground">{row.job?.clientName ?? "Job not stored"}</span>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-normal text-xs">
                          {row.job ? (
                            <div className="flex flex-col">
                              <span>
                                {row.job.status ?? "?"} · {money(row.job.jobTotal)} · {row.job.fullyPaid ? "paid in full" : "not fully paid"}
                              </span>
                              <span className="text-muted-foreground">Payments: {row.paymentSource}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-col gap-1">
                            <OwnerTextBadge status={row.status} />
                            {row.blockReason && row.status !== "provider_accepted" && row.status !== "delivered" && <span className="max-w-[20rem] text-xs text-muted-foreground">{row.blockReason}</span>}
                            {row.lastError && row.status === "failed" && <span className="max-w-[20rem] text-xs text-destructive-foreground">{row.lastError}</span>}
                            {staleSend && <span className="text-xs text-warning-foreground">Sent for an earlier version of the payouts; re-send to update the owner.</span>}
                            {row.destinationLabel && accepted && (
                              <span className="text-xs text-muted-foreground">
                                To {row.destinationLabel}
                                {row.destinationMasked ? ` ${row.destinationMasked}` : ""}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-col">
                            <span>
                              {row.attempts}/{MAX_ATTEMPTS}
                            </span>
                            {row.status === "failed" && (row.nextAttemptAt ? <span className="text-muted-foreground">retry {zonedDateTime(row.nextAttemptAt, timezone)}</span> : <span className="text-destructive-foreground">retries exhausted</span>)}
                            {row.sentAt && <span className="text-muted-foreground">accepted {zonedDateTime(row.sentAt, timezone)}</span>}
                            {row.deliveredAt && <span className="text-muted-foreground">received {zonedDateTime(row.deliveredAt, timezone)}</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{zonedDateTime(row.updatedAt, timezone)}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => showPreview(row)} aria-label={`Preview text for job ${row.job?.serialId ?? row.jobUuid}`}>
                              <Eye className="h-4 w-4" />
                              Preview
                            </Button>
                            {row.status === "provider_accepted" && (
                              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => confirm(row)}>
                                <Check className="h-4 w-4" />
                                Received
                              </Button>
                            )}
                            <Button type="button" size="sm" variant={accepted ? "outline" : "default"} disabled={pending} onClick={() => send(row, accepted)}>
                              <Send className="h-4 w-4" />
                              {accepted ? "Re-send" : "Send now"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {expanded && preview?.id === row.id && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={6} className="whitespace-normal">
                            <div className="flex flex-col gap-2 py-1">
                              <p className="text-xs text-muted-foreground">
                                Evaluated just now: <span className="font-medium text-foreground">{describeOwnerState(preview.state).label}</span>
                                {preview.reason ? ` · ${preview.reason}` : ""}
                              </p>
                              {preview.message ? (
                                <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed">{preview.message}</pre>
                              ) : (
                                <p className="text-xs text-muted-foreground">No message can be built yet; fix the reason above and the text will be composed on the next sync.</p>
                              )}
                              {row.message && row.message !== preview.message && (
                                <details className="text-xs text-muted-foreground">
                                  <summary className="cursor-pointer">Stored message differs from the current one</summary>
                                  <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-3 font-mono leading-relaxed">{row.message}</pre>
                                </details>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </RowGroup>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function WebhookLogCard({ log, timezone }: { log: OwnerTexts["webhookLog"]; timezone: string }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Webhook events received</CardTitle>
        <CardDescription>
          Every payload Workiz posted, stored before any processing. <span className="font-medium">Unresolved</span> means the payload named a job the app had not synced yet
          (estimate and invoice webhooks only carry the job number); it is replayed automatically once the job arrives.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {log.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing received yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Payments</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">{zonedDateTime(e.receivedAt, timezone)}</TableCell>
                    <TableCell className="text-xs capitalize">{e.kind.replace(/_/g, " ")}</TableCell>
                    <TableCell className="whitespace-normal text-xs text-muted-foreground">
                      {e.triggerType ?? "—"}
                      {e.ruleName ? ` · ${e.ruleName}` : ""}
                    </TableCell>
                    <TableCell className="text-xs">{e.serialId ? `#${e.serialId}` : e.jobUuid ? e.jobUuid.slice(0, 8) : e.jobInternalId ? `id ${e.jobInternalId}` : "—"}</TableCell>
                    <TableCell className="text-xs">{e.payments === null ? "—" : e.payments}</TableCell>
                    <TableCell className="whitespace-normal text-xs">
                      <span className={e.status === "failed" ? "text-destructive-foreground" : e.status === "unresolved" ? "text-warning-foreground" : ""}>{e.status}</span>
                      {e.error && <span className="ml-1 text-muted-foreground">· {e.error}</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
