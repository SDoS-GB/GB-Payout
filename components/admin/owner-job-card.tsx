"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import useSWR, { useSWRConfig } from "swr"
import { checkOwnerDelivery, confirmOwnerReceipt, loadOwnerJobDiagnostics, refreshOwnerJob, requestOwnerPayout } from "@/app/actions/owner-notifications"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { OWNER_STATUS_LABELS } from "@/lib/notifications/owner-status"
import { money, zonedDateTime } from "./shared"

type Result = { ok: true; message: string } | { ok: false; error: string }

export function OwnerJobCard({ jobUuid, timezone }: { jobUuid: string; timezone: string }) {
  const router = useRouter()
  const { mutate: mutateShared } = useSWRConfig()
  const { data, error, mutate } = useSWR(["owner-job", jobUuid], () => loadOwnerJobDiagnostics(jobUuid), { refreshInterval: (current) => ["queued", "sending"].includes(current?.notification?.status ?? "") ? 15_000 : 0 })
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  function run(action: () => Promise<Result>) {
    startTransition(async () => {
      try {
        const response = await action()
        setResult({ ok: response.ok, text: response.ok ? response.message : response.error })
        await Promise.all([
          mutate(),
          mutateShared("owner-settings"),
          mutateShared((key) => Array.isArray(key) && key[0] === "payouts"),
        ])
        router.refresh()
      } catch { setResult({ ok: false, text: "The request did not finish. Refresh the saved delivery state before trying again; a timed-out send must not be repeated blindly." }) }
    })
  }

  if (error) return <Alert variant="destructive"><AlertTitle>Owner diagnostics unavailable</AlertTitle><AlertDescription>Reload before attempting a send. No delivery status can be verified.</AlertDescription></Alert>
  if (!data) return <Skeleton className="h-48 w-full" aria-label="Loading owner message diagnostics" />
  const notification = data.notification
  const latest = data.attempts[0]
  const receiptHash = notification?.sentSnapshotHash ?? latest?.snapshotHash
  const canConfirm = data.production && notification && !notification.deliveredAt && latest?.requestStartedAt && (notification.sentAt || notification.requiresReview) && receiptHash
  const owner = data.recipient ? `${data.recipient.name} · ${data.recipient.phoneMasked ?? "phone unconfirmed"}` : "Not configured"
  const date = (value: Date | string | null | undefined) => value ? zonedDateTime(value, timezone) : "None"

  return (
    <Card>
      <CardHeader>
        <CardTitle>Message to owner</CardTitle>
        <CardDescription>Job #{data.job?.serialId ?? jobUuid} · one message listing every required technician individually. A preview is never a send.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{notification ? OWNER_STATUS_LABELS[notification.status] ?? notification.status : "Not evaluated"}</Badge>{!data.production && <Badge variant="secondary">Preview · live sending disabled</Badge>}</div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Configured recipient</dt><dd>{owner}</dd>
            {notification?.destinationMasked && <><dt className="text-muted-foreground">Notification destination</dt><dd>{notification.destinationLabel ?? "Owner"} · {notification.destinationMasked}</dd></>}
            <dt className="text-muted-foreground">Last Workiz job read</dt><dd>{date(data.job?.lastSeenAt)}</dd>
            <dt className="text-muted-foreground">Payment source</dt><dd>{data.payments.length ? Array.from(new Set(data.payments.map((p) => p.source === "manual" ? "Admin recovery entry (not automatic)" : p.source))).join(", ") : "Unavailable · no captured payment records"}</dd>
            <dt className="text-muted-foreground">Notification identity</dt><dd>{notification ? `#${notification.id} · ${notification.snapshotHash?.slice(0, 12) ?? "no verified snapshot"}` : "None"}</dd>
            <dt className="text-muted-foreground">Last attempt</dt><dd>{date(notification?.lastAttemptAt)}{notification ? ` · ${notification.attempts} attempt(s)` : ""}</dd>
            <dt className="text-muted-foreground">Next scheduled action</dt><dd>{notification?.nextAttemptAt ? `${date(notification.nextAttemptAt)} · ${notification.requiresReview ? "read-only delivery reconciliation" : "retry, subject to eligibility and quota"}` : "None"}</dd>
            <dt className="text-muted-foreground">Provider message ID</dt><dd>{notification?.providerMessageId ?? "Not provided by Workiz tag automation"}</dd>
            <dt className="text-muted-foreground">Delivery evidence</dt><dd>{notification?.deliveredAt ? `Owner confirmed receipt ${date(notification.deliveredAt)} · not a provider receipt` : "Unconfirmed · the API does not expose an SMS receipt"}</dd>
          </dl>
          {(data.blocked || notification?.blockReason) && <Alert><AlertTitle>Exact blocking reason</AlertTitle><AlertDescription>{data.blocked ?? notification?.blockReason}</AlertDescription></Alert>}
          {notification?.lastError && <Alert variant="destructive"><AlertTitle>Last delivery error</AlertTitle><AlertDescription>{notification.lastError}</AlertDescription></Alert>}
          {notification?.message ? <div className="flex flex-col gap-2"><p className="text-sm font-medium">Current calculated owner message</p><pre className="whitespace-pre-wrap break-words rounded-md border bg-muted p-3 font-sans text-sm leading-relaxed text-foreground">{notification.message}</pre></div> : <p className="text-sm text-muted-foreground">No finished-payout message is generated while a required calculation or payment method is unresolved. Use the current Workiz payment history to resolve the hold, not Release.</p>}
          {data.payments.length > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium">Persisted payment evidence</summary><ul className="flex flex-col gap-3 py-3">{data.payments.map((p) => <li key={p.id}><p>{p.externalId ?? `Recovery row ${p.id}`} · {p.method} · {money(p.amount)}{Number(p.tipAmount) > 0 ? ` · recorded tip ${money(p.tipAmount)}` : ""}</p><p className="text-muted-foreground">{p.source} · {p.state} · paid {date(p.paidAt)}</p>{p.reviewReason && <p>{p.reviewReason}</p>}</li>)}</ul></details>}
          {data.events.length > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium">Pending payment / job events</summary><ul className="flex flex-col gap-3 py-3">{data.events.map((event) => <li key={event.id}>Event #{event.id} · {event.kind} · {event.status}{event.error ? ` — ${event.error}` : ""}<p className="text-muted-foreground">Next retry: {date(event.nextAttemptAt)} · {event.attempts} attempt(s)</p></li>)}</ul></details>}
          {data.attempts.length > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium">Recent send attempts</summary><ul className="flex flex-col gap-3 py-3">{data.attempts.map((attempt) => <li key={attempt.id}><p>{date(attempt.startedAt)} · {attempt.status} · {attempt.destinationMasked}</p><p className="break-all text-muted-foreground">Attempt {attempt.id} · snapshot {attempt.snapshotHash.slice(0, 12)}</p>{attempt.error && <p>{attempt.error}</p>}</li>)}</ul></details>}
          {result && <Alert variant={result.ok ? "default" : "destructive"}><AlertDescription aria-live="polite">{result.text}</AlertDescription></Alert>}
          <a href="/admin?view=settings&section=owner" className="text-sm text-primary underline underline-offset-4">Owner recipient and automation settings</a>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={pending} onClick={() => run(() => refreshOwnerJob(jobUuid))}>{pending ? "Checking…" : "Recheck job · no SMS"}</Button>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button disabled={pending || !data.canRequest}>Send payout to owner</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>Send this one job to the owner?</AlertDialogTitle><AlertDialogDescription>This is a real Workiz action for job #{data.job?.serialId ?? jobUuid}, intended for {owner}. It writes the calculated message into the existing job description and adds the payout tag. No customer or technician payment is recorded. No other job will be texted by this action.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => run(() => requestOwnerPayout({ uuid: jobUuid, snapshotHash: notification!.snapshotHash!, confirmed: true }))}>Send this job only</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {notification?.requiresReview && <Button variant="outline" disabled={pending} onClick={() => run(() => checkOwnerDelivery(notification.id))}>Check Workiz · no resend</Button>}
          {canConfirm && <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="outline" disabled={pending}>I received the owner text</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>Confirm actual receipt</AlertDialogTitle><AlertDialogDescription>Only confirm if you received the payout text on your phone at {latest.destinationMasked} for job #{data.job?.serialId ?? jobUuid}, snapshot {receiptHash.slice(0, 12)}. A message preview or a Workiz tag is not receipt evidence. This records your confirmation; it does not send again.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Not received</AlertDialogCancel><AlertDialogAction onClick={() => run(() => confirmOwnerReceipt({ id: notification.id, snapshotHash: receiptHash, received: true }))}>Confirm receipt</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>}
        </div>
      </CardFooter>
    </Card>
  )
}
