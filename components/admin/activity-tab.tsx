"use client"

import type { AdminDashboardData } from "@/app/actions/admin"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { shortDateTime } from "./shared"

export function ActivityTab({ events }: { events: AdminDashboardData["events"] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Sync activity</CardTitle>
        <CardDescription>Webhooks, scheduled reconciles, probes, and manual syncs. Newest first.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {events.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing yet.</li>}
          {events.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 px-4 py-3 text-sm md:flex-row md:items-start md:gap-4">
              <span className="w-32 shrink-0 text-xs text-muted-foreground">{shortDateTime(e.createdAt)}</span>
              <Badge variant={e.ok ? "outline" : "destructive"} className="w-fit font-mono text-xs">
                {e.kind}
              </Badge>
              <span className="flex-1 break-words">{e.summary ?? "—"}</span>
              {e.jobUuid && <span className="font-mono text-xs text-muted-foreground">{e.jobUuid.slice(0, 8)}</span>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
