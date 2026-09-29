"use client"

import { useState, useTransition, type FormEvent } from "react"
import useSWR from "swr"
import { loadOwnerSettings, saveOwnerConfiguration, setAutomaticOwnerSending, type OwnerSettingsData } from "@/app/actions/owner-notifications"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { OWNER_STATUS_LABELS } from "@/lib/notifications/owner-status"
import { zonedDateTime } from "./shared"

export function OwnerSettingsTab() {
  const { data, error, mutate } = useSWR("owner-settings", loadOwnerSettings)
  if (error) return <Alert variant="destructive"><AlertTitle>Owner settings unavailable</AlertTitle><AlertDescription>Reload this section to try again. No message was sent.</AlertDescription></Alert>
  if (!data) return <Skeleton className="h-64 w-full" aria-label="Loading owner notification settings" />
  return <OwnerSettings key={JSON.stringify([data.settings, data.tag])} data={data} reload={() => mutate()} />
}

function OwnerSettings({ data, reload }: { data: OwnerSettingsData; reload: () => Promise<unknown> }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [teamId, setTeamId] = useState(data.settings.ownerRecipient?.workizTeamId ?? "")
  const [lastFour, setLastFour] = useState(data.settings.ownerRecipient?.phoneMasked?.slice(-4) ?? "")
  const [tag, setTag] = useState(data.tag)
  const [ruleName, setRuleName] = useState(data.settings.automationRuleName ?? "")
  const [confirmed, setConfirmed] = useState(false)
  const canEnable = data.production && !data.blocker && Boolean(data.settings.verifiedDeliveryAt) && data.cronSecretConfigured

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    startTransition(async () => {
      try {
        const response = await saveOwnerConfiguration({ teamId, lastFour, tag, ruleName, confirmed })
        if (response.ok) await reload()
        setResult({ ok: response.ok, text: response.ok ? response.message : response.error })
      } catch { setResult({ ok: false, text: "Settings could not be saved. No text was requested." }) }
    })
  }

  function toggle(enabled: boolean) {
    startTransition(async () => {
      try {
        const response = await setAutomaticOwnerSending(enabled)
        if (response.ok) await reload()
        setResult({ ok: response.ok, text: response.ok ? response.message : response.error })
      } catch { setResult({ ok: false, text: "Could not change automatic sending. Reload to check its saved state." }) }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Owner payout texts</CardTitle>
          <CardDescription>One message per ready job, with each technician&apos;s individual payout. Sent through your existing Workiz number, never to the customer or assigned technician.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={data.settings.sendEnabled ? "default" : "secondary"}>{data.settings.sendEnabled ? "Automatic sending on" : "Automatic sending off"}</Badge>
              <Badge variant="outline">{data.production ? "Production" : "Preview · live sending disabled"}</Badge>
              <span className="text-sm">{data.settings.ownerRecipient ? `${data.settings.ownerRecipient.name} · ${data.settings.ownerRecipient.phoneMasked ?? "phone unconfirmed"}` : "Owner recipient not configured"}</span>
            </div>
            {data.blocker && <Alert><AlertTitle>Configuration blocker</AlertTitle><AlertDescription>{data.blocker}</AlertDescription></Alert>}
            {!data.settings.verifiedDeliveryAt && <p className="text-sm text-muted-foreground">Workiz accepting a description/tag update is not proof of an SMS. Open one eligible job, choose <strong>Send payout to owner</strong>, and confirm receipt on your phone before enabling automation.</p>}
            <Field orientation="horizontal" data-disabled={pending || (!canEnable && !data.settings.sendEnabled)}>
              <FieldContent>
                <FieldLabel htmlFor="automatic-owner-sending">Automatically text new ready jobs</FieldLabel>
                <FieldDescription>Enabling starts a new completion cutoff. Older jobs require an explicit one-job request; they are never bulk-texted.</FieldDescription>
              </FieldContent>
              <Switch id="automatic-owner-sending" checked={data.settings.sendEnabled} onCheckedChange={toggle} disabled={pending || !data.production || (!canEnable && !data.settings.sendEnabled)} />
            </Field>
            {result && <Alert variant={result.ok ? "default" : "destructive"}><AlertDescription aria-live="polite">{result.text}</AlertDescription></Alert>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing Workiz automation</CardTitle>
          <CardDescription>This records and checks the intended owner recipient. It does not create a Workiz rule, change a phone number, or send a text.</CardDescription>
        </CardHeader>
        <CardContent>
          <form id="owner-configuration" onSubmit={save}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="owner-team">Owner in Workiz</FieldLabel>
                <Select value={teamId} onValueChange={(value) => { setTeamId(value); setLastFour(""); setConfirmed(false) }} disabled={pending}>
                  <SelectTrigger id="owner-team"><SelectValue placeholder="Select your existing Workiz account" /></SelectTrigger>
                  <SelectContent><SelectGroup>{data.team.map((member) => <SelectItem key={member.id} value={member.id}>{member.name ?? member.id}{member.role ? ` · ${member.role}` : ""}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                <FieldDescription>Choose the same fixed team member that receives the Workiz automation. The app never uses a customer phone or an assigned-technician placeholder.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="owner-last-four">Owner phone · last four digits</FieldLabel>
                <Input id="owner-last-four" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required autoComplete="off" value={lastFour} onChange={(e) => { setLastFour(e.target.value.replace(/\D/g, "")); setConfirmed(false) }} disabled={pending} />
                <FieldDescription>Confirm the existing number in Workiz. Its team API may omit phones; only a masked suffix is stored here. This field does not address or reroute the SMS.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="owner-tag">Existing payout tag</FieldLabel>
                <Input id="owner-tag" value={tag} maxLength={80} required disabled={pending} onChange={(e) => { setTag(e.target.value); setConfirmed(false) }} />
                <FieldDescription>Create this exact tag in Workiz first. Workiz silently ignores unknown tag names.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="owner-rule">Workiz text automation name</FieldLabel>
                <Input id="owner-rule" value={ruleName} maxLength={150} required disabled={pending} onChange={(e) => { setRuleName(e.target.value); setConfirmed(false) }} />
              </Field>
              <Field orientation="horizontal">
                <Checkbox id="owner-rule-confirmed" checked={confirmed} disabled={pending} onCheckedChange={(value) => setConfirmed(value === true)} />
                <FieldContent>
                  <FieldLabel htmlFor="owner-rule-confirmed">I checked the rule in Workiz</FieldLabel>
                  <FieldDescription>Immediate tag-added trigger; send text to the fixed owner selected above; message uses the <strong>{"{Job description}"}</strong> short code. Not a Done-status timer, customer message, or assigned-technician message. Disable any duplicate payout-text rule.</FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter><Button type="submit" form="owner-configuration" disabled={pending || !confirmed || !teamId}>{pending ? "Saving…" : "Save owner configuration"}</Button></CardFooter>
      </Card>

      <Card>
        <CardHeader><CardTitle>Automation diagnostics</CardTitle><CardDescription>Saved evidence from the database, not an assumption that production is running.</CardDescription></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Last successful job sync</dt><dd>{data.lastSync ? zonedDateTime(data.lastSync.at, data.timezone) : "Not observed"}</dd>
            <dt className="text-muted-foreground">Durable worker · every 20 minutes</dt><dd>{data.lastWorker ? `${zonedDateTime(data.lastWorker.at, data.timezone)} · ${data.lastWorker.ok ? "completed" : "needs attention"}` : "No run observed. Publish this version and verify the production cron is enabled."}</dd>
            <dt className="text-muted-foreground">Cron authentication configured here</dt><dd>{data.cronSecretConfigured ? "Yes · does not prove the production cron is enabled" : "No · CRON_SECRET missing"}</dd>
            <dt className="text-muted-foreground">Owner-confirmed receipt</dt><dd>{data.settings.verifiedDeliveryAt ? zonedDateTime(data.settings.verifiedDeliveryAt, data.timezone) : "Not verified"}</dd>
            <dt className="text-muted-foreground">Automatic completion cutoff</dt><dd>{data.settings.automaticSince ? zonedDateTime(data.settings.automaticSince, data.timezone) : "Not activated"}</dd>
            <dt className="text-muted-foreground">Notification states</dt><dd className="flex flex-wrap gap-2">{data.counts.length ? data.counts.map((item) => <Badge key={item.status} variant="secondary">{OWNER_STATUS_LABELS[item.status] ?? item.status}: {item.count}</Badge>) : "No owner notifications materialized yet"}</dd>
          </dl>
        </CardContent>
      </Card>

      <Alert>
        <AlertTitle>Payment events are a separate requirement</AlertTitle>
        <AlertDescription>
          <div className="flex flex-col gap-2 text-sm">
            <p>Keep the job/completion webhook free of a Payout Ready tag condition. Configure supported invoice and estimate payment/status webhooks for both deposits and final payments, including manually recorded check, cash, and Zelle. Verify those triggers in your account; job webhooks alone do not carry payment methods.</p>
            <p>Newly enabled rules do not replay old deposits. For #924878, request the original linked-document payment payload or an official payment export from Workiz. Do not create a customer invoice or change a real job status just to trigger an event. Manual recovery is explicitly separate from automation.</p>
            <a className="text-primary underline underline-offset-4" href="https://help.workiz.com/hc/en-us/articles/39192462158993-Creating-webhooks-in-Workiz" target="_blank" rel="noreferrer noopener">Official Workiz webhook documentation</a>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  )
}
