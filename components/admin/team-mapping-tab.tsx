"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { addManualTeamMapping, runTeamSync, setTeamMapping } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { InlineMessage, shortDateTime } from "./shared"

type Mapping = AdminDashboardData["mappings"][number]
type Profile = AdminDashboardData["profiles"][number]

const NONE = "__none__"
const EXCLUDED = "__excluded__"

export function TeamMappingTab({ mappings, profiles, hasApiToken }: { mappings: Mapping[]; profiles: Profile[]; hasApiToken: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [manual, setManual] = useState({ id: "", name: "", profileId: NONE })

  const profileName = (id: number | null) => profiles.find((p) => p.id === id)?.name ?? null

  const change = (m: Mapping, value: string) =>
    startTransition(async () => {
      setMessage(null)
      const res =
        value === EXCLUDED
          ? await setTeamMapping(m.workizTeamId, null, true)
          : await setTeamMapping(m.workizTeamId, value === NONE ? null : Number(value), false)
      if (!res.ok) return setMessage({ tone: "error", text: res.error })
      setMessage({ tone: "ok", text: `Saved mapping for ${m.workizName ?? m.workizTeamId}` })
      router.refresh()
    })

  const unmapped = mappings.filter((m) => m.profileId == null && !m.excluded)
  const sorted = [...unmapped, ...mappings.filter((m) => !unmapped.includes(m))]

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Workiz team → technician profiles</CardTitle>
          <CardDescription>
            Payouts are matched by the stable Workiz team member id, never by display name. Names are shown only to help you pick the right profile. Anyone marked
            &quot;Excluded&quot; (office staff, sales) is ignored on jobs.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !hasApiToken}
              onClick={() =>
                startTransition(async () => {
                  setMessage(null)
                  const res = await runTeamSync()
                  if (!res.ok) return setMessage({ tone: "error", text: res.error })
                  setMessage({ tone: "ok", text: `Pulled ${res.data!.total} team members from Workiz (${res.data!.created} new)` })
                  router.refresh()
                })
              }
            >
              <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />
              Pull team from Workiz
            </Button>
            {!hasApiToken && <span className="text-xs text-muted-foreground">Add the Workiz API token first (Workiz tab).</span>}
          </div>
          {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workiz id</TableHead>
                  <TableHead>Workiz name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Maps to</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      No team members yet. Pull the team from Workiz, or ids will appear automatically as jobs sync.
                    </TableCell>
                  </TableRow>
                )}
                {sorted.map((m) => {
                  const value = m.excluded ? EXCLUDED : m.profileId == null ? NONE : String(m.profileId)
                  const needsAttention = m.profileId == null && !m.excluded
                  return (
                    <TableRow key={m.id} className={needsAttention ? "bg-amber-500/5" : undefined}>
                      <TableCell className="font-mono text-xs">{m.workizTeamId}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {m.workizName ?? <span className="text-muted-foreground">—</span>}
                          {needsAttention && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">Unmapped</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{m.workizRole ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{m.source}</TableCell>
                      <TableCell>
                        <Select value={value} onValueChange={(v) => change(m, v)} disabled={pending}>
                          <SelectTrigger className="w-44" aria-label={`Map ${m.workizName ?? m.workizTeamId}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Not mapped</SelectItem>
                            {profiles.map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>
                                {p.name}
                                {!p.active ? " (inactive)" : ""}
                              </SelectItem>
                            ))}
                            <SelectItem value={EXCLUDED}>Excluded (no payout)</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{shortDateTime(m.updatedAt)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add a mapping manually</CardTitle>
          <CardDescription>Useful before the first sync, or when Workiz returns an id that is not in the team list.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              startTransition(async () => {
                setMessage(null)
                const res = await addManualTeamMapping(manual.id, manual.name, manual.profileId === NONE ? null : Number(manual.profileId))
                if (!res.ok) return setMessage({ tone: "error", text: res.error })
                setMessage({ tone: "ok", text: `Added mapping for ${manual.id}` })
                setManual({ id: "", name: "", profileId: NONE })
                router.refresh()
              })
            }}
          >
            <Input placeholder="Workiz team id" value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} className="w-40" required />
            <Input placeholder="Name (optional)" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} className="w-44" />
            <Select value={manual.profileId} onValueChange={(v) => setManual({ ...manual, profileId: v })}>
              <SelectTrigger className="w-44" aria-label="Profile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not mapped</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" disabled={pending}>
              Add
            </Button>
          </form>
          {profileName(null) === null && null}
        </CardContent>
      </Card>
    </div>
  )
}
