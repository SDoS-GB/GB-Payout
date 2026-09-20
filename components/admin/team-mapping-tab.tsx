"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, ExternalLink, RefreshCw } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { addManualTeamMapping, runTeamSync, setTeamMapping } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { workizJobUrl } from "@/lib/payout/presentation"
import { InlineMessage, shortDateTime, zonedDate } from "./shared"

type Mapping = AdminDashboardData["mappings"][number]
type Profile = AdminDashboardData["profiles"][number]
type Impact = AdminDashboardData["unmappedImpact"]

const NONE = "__none__"
const EXCLUDED = "__excluded__"

export function TeamMappingTab({
  mappings,
  profiles,
  hasApiToken,
  impact,
  view,
  onViewChange,
  focusToken,
  timezone,
}: {
  mappings: Mapping[]
  profiles: Profile[]
  hasApiToken: boolean
  impact: Impact
  view: "all" | "unmapped"
  onViewChange: (view: "all" | "unmapped") => void
  focusToken: number
  timezone: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [manual, setManual] = useState({ id: "", name: "", profileId: NONE })
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (focusToken > 0) listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [focusToken])

  const change = (m: Mapping, value: string) =>
    startTransition(async () => {
      setMessage(null)
      const res =
        value === EXCLUDED
          ? await setTeamMapping(m.workizTeamId, null, true)
          : await setTeamMapping(m.workizTeamId, value === NONE ? null : Number(value), false)
      if (!res.ok) return setMessage({ tone: "error", text: res.error })
      const target = value === EXCLUDED ? "Excluded" : value === NONE ? "Not mapped" : profiles.find((p) => String(p.id) === value)?.name ?? value
      setMessage({ tone: "ok", text: `Saved: ${m.workizName ?? m.workizTeamId} → ${target}. Re-sync affected jobs to recalculate their payouts.` })
      router.refresh()
    })

  const unmapped = mappings.filter((m) => m.profileId == null && !m.excluded)
  const sorted = [...unmapped, ...mappings.filter((m) => !unmapped.includes(m))]
  const rows = view === "unmapped" ? unmapped : sorted

  return (
    <div className="flex flex-col gap-4">
      <div ref={listRef} className="scroll-mt-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Workiz team → technician profiles</CardTitle>
                <CardDescription>
                  Payouts are matched by the stable Workiz team member id, never by display name. Names are shown only to help you pick the right profile. Anyone marked
                  &quot;Excluded&quot; (office staff, sales) is ignored on jobs.
                </CardDescription>
              </div>
              <div role="group" aria-label="Filter team members" className="flex items-center rounded-md border p-0.5">
                <Button size="sm" variant={view === "unmapped" ? "secondary" : "ghost"} aria-pressed={view === "unmapped"} onClick={() => onViewChange("unmapped")}>
                  Unmapped only
                  {unmapped.length > 0 && (
                    <Badge variant="outline" className="ml-1 border-amber-500/40 text-amber-700 dark:text-amber-300">
                      {unmapped.length}
                    </Badge>
                  )}
                </Button>
                <Button size="sm" variant={view === "all" ? "secondary" : "ghost"} aria-pressed={view === "all"} onClick={() => onViewChange("all")}>
                  All team members
                </Button>
              </div>
            </div>
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
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {view === "unmapped" ? `${unmapped.length} unmapped ${unmapped.length === 1 ? "person" : "people"}` : `${rows.length} team member${rows.length === 1 ? "" : "s"}`}
              </span>
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
                    <TableHead>Affected jobs</TableHead>
                    <TableHead>Maps to</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && view === "unmapped" && (
                    <TableRow>
                      <TableCell colSpan={7} className="whitespace-normal py-12 text-center">
                        <div className="mx-auto flex max-w-md flex-col items-center gap-2">
                          <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                          <p className="text-sm font-medium">Every Workiz team member is mapped</p>
                          <p className="text-sm text-muted-foreground">
                            New ids appear here automatically when a synced job references someone you have not linked yet. Payouts for those jobs are held until the person is mapped or excluded.
                          </p>
                          <Button size="sm" variant="outline" onClick={() => onViewChange("all")}>
                            Show all team members
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.length === 0 && view === "all" && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                        No team members yet. Pull the team from Workiz, or ids will appear automatically as jobs sync.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((m) => {
                    const value = m.excluded ? EXCLUDED : m.profileId == null ? NONE : String(m.profileId)
                    const needsAttention = m.profileId == null && !m.excluded
                    const jobs = impact[m.workizTeamId] ?? []
                    return (
                      <TableRow key={m.id} className={needsAttention ? "bg-amber-500/5" : undefined}>
                        <TableCell className="font-mono text-xs">{m.workizTeamId}</TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              {m.workizName ?? <span className="text-muted-foreground">Name not returned by Workiz</span>}
                              {needsAttention && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">Unmapped</Badge>}
                            </div>
                            {needsAttention && <span className="text-xs text-muted-foreground">Payouts on this person&apos;s jobs are not calculated until mapped.</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{m.workizRole ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{m.source}</TableCell>
                        <TableCell className="whitespace-normal">
                          {needsAttention ? (
                            jobs.length ? (
                              <ul className="flex max-w-xs flex-col gap-1 text-xs">
                                {jobs.slice(0, 4).map((j) => {
                                  const url = workizJobUrl(j.uuid)
                                  return (
                                    <li key={j.uuid} className="flex flex-wrap items-center gap-x-1">
                                      <span className="font-medium">#{j.serialId ?? j.uuid}</span>
                                      <span className="text-muted-foreground">· {j.clientName ?? "Customer unavailable"} · {zonedDate(j.jobDateTime, timezone)}</span>
                                      {url && (
                                        <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center text-primary" aria-label={`Open job ${j.serialId ?? j.uuid} in Workiz`}>
                                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                        </a>
                                      )}
                                    </li>
                                  )
                                })}
                                {jobs.length > 4 && <li className="text-muted-foreground">+{jobs.length - 4} more job{jobs.length - 4 === 1 ? "" : "s"}</li>}
                              </ul>
                            ) : (
                              <span className="text-xs text-muted-foreground">No synced jobs reference this id yet</span>
                            )
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Select value={value} onValueChange={(v) => change(m, v)} disabled={pending}>
                            <SelectTrigger className="w-44" aria-label={`Map ${m.workizName ?? m.workizTeamId} to a technician profile`}>
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
      </div>

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
            <Input placeholder="Workiz team id" value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} className="w-40" required aria-label="Workiz team id" />
            <Input placeholder="Name (optional)" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} className="w-44" aria-label="Name (optional)" />
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
        </CardContent>
      </Card>
    </div>
  )
}
