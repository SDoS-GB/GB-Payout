"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { AdminDashboardData } from "@/app/actions/admin"
import { changeAdminPassword, createProfile, updateProfile } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { InlineMessage } from "./shared"

type Profile = AdminDashboardData["profiles"][number]

export function ProfilesTab({ profiles }: { profiles: Profile[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Technician profiles</CardTitle>
          <CardDescription className="flex flex-col gap-2">
            <span>
              Rates are fractions (0.20 = 20%, 0.25 = 25%, 0.80 = 80%) applied to each technician&apos;s eligible service amount after discounts and the invoice-wide
              card deduction. Every regular technician on a job earns their own commission on the crew work; amounts are never divided by head count.
            </span>
            <span>
              <strong>Who owns the work.</strong> First the job&apos;s Workiz <em>Work Type</em>: a job whose Work Type matches a technician&apos;s &quot;Owns Work Type&quot; (e.g.{" "}
              <code className="font-mono">Tim&apos;s Job</code>) belongs entirely to that technician, color sealing included, and the crew earns no service commission on it.
              Then the <em>marker</em>: a line item whose <em>name</em> contains the literal <code className="font-mono">*T*</code> (spaces inside the asterisks allowed:{" "}
              <code className="font-mono">* T *</code>) belongs only to the technician with marker token <code className="font-mono">T</code>. A plain T, the word Tim, or a word
              starting with T never counts, and markers typed into the item description are flagged, not trusted. Everything else is regular crew work.
            </span>
            <span>
              <strong>Tips.</strong> The tip the business holds is split equally among the regular technicians on the job (a paired technician included). A technician with a
              marker or an owned Work Type never receives a tip share; a tip with nobody eligible is held for review. &quot;Always works with&quot; adds this technician to every
              job of the chosen technician even when Workiz does not list them (Denis with Vadim). PINs are stored hashed; enter a new one only to change it.
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {profiles.map((p) => (
            <ProfileCard key={p.id} profile={p} profiles={profiles} />
          ))}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <NewProfileCard profiles={profiles} />
        <AdminPasswordCard />
      </div>
    </div>
  )
}

function tipRule(marker: string, ownedWorkType: string): string {
  return marker.trim() || ownedWorkType.trim() ? "None: paid on own work only, never shares tips" : "Equal split with the other regular technicians on the job"
}

function ProfileCard({ profile, profiles }: { profile: Profile; profiles: Profile[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({
    nonColorRate: Number(profile.nonColorRate),
    colorRate: Number(profile.colorRate),
    separateColorSeal: profile.separateColorSeal,
    lineItemMarker: profile.lineItemMarker ?? "",
    ownedWorkType: profile.ownedWorkType ?? "",
    worksWithProfileId: profile.worksWithProfileId ?? null,
    active: profile.active,
    newPin: "",
  })
  const companions = profiles.filter((p) => p.worksWithProfileId === profile.id && p.active)
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        startTransition(async () => {
          setMsg(null)
          const res = await updateProfile(profile.id, form)
          if (!res.ok) return setMsg({ tone: "error", text: res.error })
          setMsg({ tone: "ok", text: "Saved" })
          setForm({ ...form, newPin: "" })
          router.refresh()
        })
      }}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{profile.name}</span>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: Boolean(v) })} />
          Active
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <RateField label="Regular services" value={form.nonColorRate} onChange={(v) => setForm({ ...form, nonColorRate: v })} />
        <RateField label="Color sealing" value={form.colorRate} onChange={(v) => setForm({ ...form, colorRate: v })} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={form.separateColorSeal} onCheckedChange={(v) => setForm({ ...form, separateColorSeal: Boolean(v) })} />
        Separate color-sealing rate (off = whole amount at the regular rate)
      </label>
      <div className="grid grid-cols-2 gap-2">
        <MarkerField id={`marker-${profile.id}`} value={form.lineItemMarker} onChange={(v) => setForm({ ...form, lineItemMarker: v })} />
        <WorkTypeField id={`work-type-${profile.id}`} value={form.ownedWorkType} onChange={(v) => setForm({ ...form, ownedWorkType: v })} />
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Tip share:</span> {tipRule(form.lineItemMarker, form.ownedWorkType)}
      </p>
      <WorksWithField
        id={`works-with-${profile.id}`}
        value={form.worksWithProfileId}
        onChange={(v) => setForm({ ...form, worksWithProfileId: v })}
        options={profiles.filter((p) => p.id !== profile.id)}
        hint={companions.length ? `${companions.map((c) => c.name).join(", ")} ${companions.length === 1 ? "is" : "are"} added to every job of ${profile.name}` : undefined}
      />
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={`pin-${profile.id}`} className="text-xs">
            New PIN (leave blank to keep)
          </Label>
          <Input id={`pin-${profile.id}`} inputMode="numeric" value={form.newPin} onChange={(e) => setForm({ ...form, newPin: e.target.value.replace(/\D/g, "") })} maxLength={8} />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
      </div>
      {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
    </form>
  )
}

const NO_PAIRING = "none"

function WorksWithField({
  id,
  value,
  onChange,
  options,
  hint,
}: {
  id: string
  value: number | null
  onChange: (v: number | null) => void
  options: Profile[]
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        Always works with
      </Label>
      <Select value={value == null ? NO_PAIRING : String(value)} onValueChange={(v) => onChange(v === NO_PAIRING ? null : Number(v))}>
        <SelectTrigger id={id} className="w-full" aria-label="Technician this profile is always on the job with">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PAIRING}>Nobody (only jobs assigned in Workiz)</SelectItem>
          {options.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.name}
              {!p.active ? " (inactive)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function RateField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <Input type="number" step="0.01" min={0} max={1} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(Number.parseFloat(e.target.value))} />
    </div>
  )
}

function MarkerField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        Marker token (items named <span className="font-mono">*T*</span>)
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="none (e.g. T)" className="font-mono" maxLength={60} spellCheck={false} />
    </div>
  )
}

function WorkTypeField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        Owns Work Type (whole job)
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="none (e.g. Tim's Job)" maxLength={60} />
    </div>
  )
}

const NEW_PROFILE: {
  name: string
  pin: string
  nonColorRate: number
  colorRate: number
  separateColorSeal: boolean
  lineItemMarker: string
  ownedWorkType: string
  worksWithProfileId: number | null
} = { name: "", pin: "", nonColorRate: 0.2, colorRate: 0.25, separateColorSeal: true, lineItemMarker: "", ownedWorkType: "", worksWithProfileId: null }

function NewProfileCard({ profiles }: { profiles: Profile[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState(NEW_PROFILE)
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add technician</CardTitle>
        <CardDescription>New profiles also appear in the calculator&apos;s technician list. Defaults are the regular 20% / 25% rates.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            startTransition(async () => {
              setMsg(null)
              const res = await createProfile(form)
              if (!res.ok) return setMsg({ tone: "error", text: res.error })
              setMsg({ tone: "ok", text: `Added ${form.name}` })
              setForm(NEW_PROFILE)
              router.refresh()
            })
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">PIN (4-8 digits)</Label>
              <Input inputMode="numeric" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })} maxLength={8} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <RateField label="Regular services" value={form.nonColorRate} onChange={(v) => setForm({ ...form, nonColorRate: v })} />
            <RateField label="Color sealing" value={form.colorRate} onChange={(v) => setForm({ ...form, colorRate: v })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.separateColorSeal} onCheckedChange={(v) => setForm({ ...form, separateColorSeal: Boolean(v) })} />
            Separate color-sealing rate
          </label>
          <div className="grid grid-cols-2 gap-2">
            <MarkerField id="marker-new" value={form.lineItemMarker} onChange={(v) => setForm({ ...form, lineItemMarker: v })} />
            <WorkTypeField id="work-type-new" value={form.ownedWorkType} onChange={(v) => setForm({ ...form, ownedWorkType: v })} />
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Tip share:</span> {tipRule(form.lineItemMarker, form.ownedWorkType)}
          </p>
          <WorksWithField id="works-with-new" value={form.worksWithProfileId} onChange={(v) => setForm({ ...form, worksWithProfileId: v })} options={profiles} />
          <Button type="submit" size="sm" disabled={pending} className="self-start">
            Add technician
          </Button>
          {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
        </form>
      </CardContent>
    </Card>
  )
}

function AdminPasswordCard() {
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ current: "", next: "" })
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Admin password</CardTitle>
        <CardDescription>At least 10 characters.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            startTransition(async () => {
              setMsg(null)
              const res = await changeAdminPassword(form.current, form.next)
              if (!res.ok) return setMsg({ tone: "error", text: res.error })
              setMsg({ tone: "ok", text: "Password updated" })
              setForm({ current: "", next: "" })
            })
          }}
        >
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Current password</Label>
            <Input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">New password</Label>
            <Input type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required minLength={10} />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={pending} className="self-start">
            Change password
          </Button>
          {msg && <InlineMessage tone={msg.tone}>{msg.text}</InlineMessage>}
        </form>
      </CardContent>
    </Card>
  )
}
