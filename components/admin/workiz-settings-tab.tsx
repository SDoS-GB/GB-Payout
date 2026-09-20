"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, Copy, KeyRound, Radio, Trash2 } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { deleteColorSealItem, probeWorkiz, rotateWebhookSecret, updateWorkizSettings, upsertColorSealItem } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { InlineMessage } from "./shared"

type Workiz = AdminDashboardData["workiz"]
type Catalog = AdminDashboardData["catalog"]

export function WorkizSettingsTab({ workiz, catalog, webhookUrl, cronConfigured }: { workiz: Workiz; catalog: Catalog; webhookUrl: string; cronConfigured: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const [form, setForm] = useState({
    apiToken: "",
    apiSecret: "",
    payableStatuses: workiz.payableStatuses.join(", "),
    colorSealKeywords: workiz.colorSealKeywords.join(", "),
    cardMethodKeywords: workiz.cardMethodKeywords.join(", "),
    tipKeywords: workiz.tipKeywords.join(", "),
    reconcileLookbackDays: workiz.reconcileLookbackDays,
    businessTimezone: workiz.businessTimezone,
  })
  const [probe, setProbe] = useState<Awaited<ReturnType<typeof probeWorkiz>> | null>(null)
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

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Workiz API</CardTitle>
              <CardDescription>
                Token and secret from Workiz → Settings → Integrations → API. Reads use the token; posting job notes needs the secret.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={workiz.hasApiToken ? "default" : "outline"}>{workiz.hasApiToken ? "Token set" : "No token"}</Badge>
              <Badge variant={workiz.hasApiSecret ? "default" : "outline"}>{workiz.hasApiSecret ? "Secret set" : "No secret"}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              startTransition(async () => {
                setMsg(null)
                const res = await updateWorkizSettings(form)
                if (!res.ok) return setMsg({ tone: "error", text: res.error })
                setMsg({ tone: "ok", text: "Workiz settings saved" })
                setForm({ ...form, apiToken: "", apiSecret: "" })
                router.refresh()
              })
            }}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="api-token" className="text-xs">
                  API token {workiz.hasApiToken && <span className="text-muted-foreground">(leave blank to keep)</span>}
                </Label>
                <Input id="api-token" type="password" autoComplete="off" value={form.apiToken} onChange={(e) => setForm({ ...form, apiToken: e.target.value })} placeholder={workiz.hasApiToken ? "••••••••" : "api_xxx"} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="api-secret" className="text-xs">
                  API secret {workiz.hasApiSecret && <span className="text-muted-foreground">(leave blank to keep)</span>}
                </Label>
                <Input id="api-secret" type="password" autoComplete="off" value={form.apiSecret} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} placeholder={workiz.hasApiSecret ? "••••••••" : "sec_xxx"} />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="payable" className="text-xs">
                  Payable job statuses (comma separated)
                </Label>
                <Input id="payable" value={form.payableStatuses} onChange={(e) => setForm({ ...form, payableStatuses: e.target.value })} />
                <span className="text-xs text-muted-foreground">A payout is only released when the job is in one of these statuses and fully paid.</span>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="lookback" className="text-xs">
                  Reconcile lookback (days)
                </Label>
                <Input id="lookback" type="number" min={1} max={90} value={form.reconcileLookbackDays} onChange={(e) => setForm({ ...form, reconcileLookbackDays: Number(e.target.value) })} />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="business-tz" className="text-xs">
                  Business timezone
                </Label>
                <Input id="business-tz" value={form.businessTimezone} onChange={(e) => setForm({ ...form, businessTimezone: e.target.value })} placeholder="America/New_York" list="tz-suggestions" />
                <datalist id="tz-suggestions">
                  {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
                <span className="text-xs text-muted-foreground">Job, completion and payment dates in the dashboard are shown in this timezone.</span>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="cs-kw" className="text-xs">
                  Color seal keywords
                </Label>
                <Textarea id="cs-kw" rows={3} value={form.colorSealKeywords} onChange={(e) => setForm({ ...form, colorSealKeywords: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="card-kw" className="text-xs">
                  Card payment method keywords
                </Label>
                <Textarea id="card-kw" rows={3} value={form.cardMethodKeywords} onChange={(e) => setForm({ ...form, cardMethodKeywords: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="tip-kw" className="text-xs">
                  Tip keywords
                </Label>
                <Textarea id="tip-kw" rows={3} value={form.tipKeywords} onChange={(e) => setForm({ ...form, tipKeywords: e.target.value })} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                Save settings
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || !workiz.hasApiToken}
                onClick={() =>
                  startTransition(async () => {
                    setMsg(null)
                    const res = await probeWorkiz()
                    setProbe(res)
                    if (!res.ok) setMsg({ tone: "error", text: res.error })
                  })
                }
              >
                <Radio className="h-4 w-4" />
                Test connection
              </Button>
              {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
            </div>
          </form>

          {probe?.ok && probe.data && (
            <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Connected in {probe.data.latencyMs} ms</p>
              <p className="text-muted-foreground">
                {probe.data.teamCount} team members · {probe.data.sampleJobCount} sample jobs · line items {probe.data.hasItems ? "present" : "not in list view"} · payments{" "}
                {probe.data.hasPayments ? "present" : "not in list view"}
              </p>
              {probe.data.sampleJobFields.length > 0 && (
                <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{probe.data.sampleJobFields.join(" · ")}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Webhook &amp; schedule</CardTitle>
          <CardDescription>
            In Workiz create an Automation: trigger &quot;Job status changed&quot;, action &quot;Webhook&quot;, POST to the URL below with the Authorization header. The body
            only needs the job UUID; every amount is re-fetched from the API before anything is calculated. Reconciliation runs every 6 hours as a fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Webhook URL</Label>
            <div className="flex items-center gap-2">
              <Input readOnly value={webhookUrl} className="font-mono text-xs" />
              <Button type="button" size="icon" variant="outline" onClick={() => copy("url", webhookUrl)} aria-label="Copy webhook URL">
                {copied === "url" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Authorization header</Label>
            <div className="flex items-center gap-2">
              <Input readOnly value={workiz.hasWebhookSecret ? `Bearer ${workiz.webhookSecret}` : "Generate a secret first"} className="font-mono text-xs" />
              <Button type="button" size="icon" variant="outline" disabled={!workiz.hasWebhookSecret} onClick={() => copy("secret", `Bearer ${workiz.webhookSecret}`)} aria-label="Copy header">
                {copied === "secret" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const res = await rotateWebhookSecret()
                    if (!res.ok) return setMsg({ tone: "error", text: res.error })
                    setMsg({ tone: "info", text: "New webhook secret generated. Update the Workiz automation header." })
                    router.refresh()
                  })
                }
              >
                <KeyRound className="h-4 w-4" />
                {workiz.hasWebhookSecret ? "Rotate" : "Generate"}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Body (JSON)</Label>
            <Input readOnly value='{"UUID": "{{job.UUID}}"}' className="font-mono text-xs" />
          </div>
          <p className="text-xs text-muted-foreground">
            Scheduled reconcile: <span className="font-mono">0 */6 * * *</span> →{" "}
            {cronConfigured ? "CRON_SECRET is set." : "Add a CRON_SECRET environment variable so Vercel Cron can authenticate."}
          </p>
        </CardContent>
      </Card>

      <ColorSealCatalog catalog={catalog} />
    </div>
  )
}

function ColorSealCatalog({ catalog }: { catalog: Catalog }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ productId: "", name: "", isColorSeal: true })
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Color seal catalog</CardTitle>
        <CardDescription>
          Product ids that are (or explicitly are not) color sealing. Catalog matches beat keyword matches. Product ids appear in the line items of any synced job.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            startTransition(async () => {
              setMsg(null)
              const res = await upsertColorSealItem(form.productId, form.name, form.isColorSeal)
              if (!res.ok) return setMsg({ tone: "error", text: res.error })
              setMsg({ tone: "ok", text: "Catalog updated" })
              setForm({ productId: "", name: "", isColorSeal: true })
              router.refresh()
            })
          }}
        >
          <Input placeholder="Product id" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} className="w-36" required />
          <Input placeholder="Name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-52" />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.isColorSeal} onCheckedChange={(v) => setForm({ ...form, isColorSeal: Boolean(v) })} />
            Is color seal
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
          {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
        </form>
        {catalog.length > 0 && (
          <ul className="flex flex-col divide-y rounded-md border">
            {catalog.map((c) => (
              <li key={c.productId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="font-mono text-xs">{c.productId}</span> {c.name && <span className="text-muted-foreground">· {c.name}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={c.isColorSeal ? "default" : "outline"}>{c.isColorSeal ? "Color seal" : "Not color seal"}</Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await deleteColorSealItem(c.productId)
                        router.refresh()
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
