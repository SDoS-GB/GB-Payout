"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Eye, Send } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { previewNotification, sendNotificationNow, updateNotificationSettings } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TEMPLATE_PLACEHOLDERS } from "@/lib/notifications/template"
import { InlineMessage, StatusBadge, money } from "./shared"

type Settings = AdminDashboardData["notifications"]
type PayoutItem = AdminDashboardData["payouts"][number]

export function NotificationsTab({ settings, payouts }: { settings: Settings; payouts: PayoutItem[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ sendEnabled: settings.sendEnabled, channel: settings.channel, template: settings.template })
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  const [previewId, setPreviewId] = useState<string>(payouts[0] ? String(payouts[0].id) : "")
  const [preview, setPreview] = useState<string | null>(null)

  const save = () =>
    startTransition(async () => {
      setMsg(null)
      const res = await updateNotificationSettings(form)
      if (!res.ok) return setMsg({ tone: "error", text: res.error })
      setMsg({ tone: "ok", text: form.sendEnabled ? "Saved. Sending is ON for ready payouts." : "Saved. Sending stays off; messages are only previewed." })
      router.refresh()
    })

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Technician messages</CardTitle>
          <CardDescription>
            Every payout renders a message and stores it. Nothing is delivered until sending is switched on, and even then only payouts that are Ready (finished, fully
            paid, mapped) are sent. Delivery posts an internal note on the Workiz job, which your Workiz automations can forward by SMS.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-3 text-sm font-medium">
              <Switch checked={form.sendEnabled} onCheckedChange={(v) => setForm({ ...form, sendEnabled: v })} aria-label="Enable sending" />
              {form.sendEnabled ? "Sending enabled" : "Sending disabled (preview only)"}
            </label>
            <div className="flex items-center gap-2">
              <Label className="text-xs">Channel</Label>
              <Select value={form.channel} onValueChange={(v) => setForm({ ...form, channel: v as Settings["channel"] })}>
                <SelectTrigger className="w-44" aria-label="Channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workiz_note">Workiz job note</SelectItem>
                  <SelectItem value="none">None (store only)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.sendEnabled && !settings.sendEnabled && (
            <Alert>
              <AlertDescription>You are about to enable live sending. Preview a few messages below first, then Save.</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="template" className="text-xs">
              Template
            </Label>
            <Textarea id="template" rows={4} value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} className="font-mono text-xs" />
            <p className="text-xs text-muted-foreground">
              Placeholders: {TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(" ")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              Save
            </Button>
            {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Preview &amp; send</CardTitle>
          <CardDescription>Render the current template against a real payout. &quot;Send now&quot; respects the sending switch and Ready status.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={previewId} onValueChange={setPreviewId} disabled={payouts.length === 0}>
              <SelectTrigger className="w-80" aria-label="Payout">
                <SelectValue placeholder="No payouts yet" />
              </SelectTrigger>
              <SelectContent>
                {payouts.slice(0, 100).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    #{p.job?.serialId ?? p.jobUuid.slice(0, 8)} · {p.profileName} · {money(p.totalPayout)} · {p.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !previewId}
              onClick={() =>
                startTransition(async () => {
                  setMsg(null)
                  const res = await previewNotification(Number(previewId))
                  if (!res.ok) return setMsg({ tone: "error", text: res.error })
                  setPreview(res.data!.message)
                })
              }
            >
              <Eye className="h-4 w-4" />
              Preview
            </Button>
            <Button
              size="sm"
              disabled={pending || !previewId}
              onClick={() =>
                startTransition(async () => {
                  setMsg(null)
                  const res = await sendNotificationNow(Number(previewId))
                  if (!res.ok) return setMsg({ tone: "error", text: res.error })
                  setMsg({ tone: res.data!.status === "sent" ? "ok" : "info", text: `Result: ${res.data!.status}${res.data!.reason ? ` — ${res.data!.reason}` : ""}` })
                  router.refresh()
                })
              }
            >
              <Send className="h-4 w-4" />
              Send now
            </Button>
          </div>
          {preview && <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">{preview}</pre>}
          <div className="flex flex-col divide-y rounded-md border">
            {payouts
              .filter((p) => p.lastNotification)
              .slice(0, 15)
              .map((p) => (
                <div key={p.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      #{p.job?.serialId ?? p.jobUuid.slice(0, 8)} · {p.profileName}
                    </span>
                    <StatusBadge status={p.lastNotification!.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">{p.lastNotification!.message}</p>
                  {p.lastNotification!.error && <p className="text-xs text-destructive">{p.lastNotification!.error}</p>}
                </div>
              ))}
            {payouts.every((p) => !p.lastNotification) && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No messages rendered yet.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
