"use client"

import { useRouter } from "next/navigation"
import { Lock } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SETTINGS_SECTIONS, SETTINGS_SECTION_LABELS, adminHref, type AdminLocation, type SettingsSection } from "@/lib/admin/navigation"
import { ActivityTab } from "./activity-tab"
import { OpeningBalanceCard } from "./opening-balance-card"
import { ProfilesTab } from "./profiles-tab"
import { NavLink } from "./review-tab"
import { SyncStatusStrip } from "./sync-status-strip"
import { TeamMappingTab } from "./team-mapping-tab"
import { WorkizSettingsTab } from "./workiz-settings-tab"
import { zonedDateTime } from "./shared"

type Props = {
  data: AdminDashboardData
  section: SettingsSection
  teamFilter: "all" | "unmapped"
  focusToken: number
  webhookUrl: string
  cronConfigured: boolean
  unmappedCount: number
  onNavigate: (loc: Partial<AdminLocation>) => void
}

/** Everything that is configured rarely, one section at a time. Each section keeps its old component. */
export function SettingsTab({ data, section, teamFilter, focusToken, webhookUrl, cronConfigured, unmappedCount, onNavigate }: Props) {
  const router = useRouter()
  const timezone = data.workiz.businessTimezone
  const badges: Partial<Record<SettingsSection, number>> = { team: unmappedCount, opening: data.opening.openingInitializedAt ? 0 : 1 }

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Settings sections" className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
        <ul className="flex w-max gap-1 rounded-lg border bg-card p-1 sm:w-auto sm:flex-wrap">
          {SETTINGS_SECTIONS.map((s) => {
            const active = s === section
            const count = badges[s] ?? 0
            return (
              <li key={s}>
                <a
                  href={adminHref({ view: "settings", section: s })}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) return
                    e.preventDefault()
                    onNavigate({ view: "settings", section: s })
                  }}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-primary text-primary-foreground hover:bg-primary" : "text-foreground"}`}
                >
                  {SETTINGS_SECTION_LABELS[s]}
                  {count > 0 && <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${active ? "bg-primary-foreground/20" : "bg-warning/20 text-warning-foreground"}`}>{count}</span>}
                </a>
              </li>
            )
          })}
        </ul>
      </nav>

      {section === "team" && (
        <TeamMappingTab
          mappings={data.mappings}
          profiles={data.profiles}
          hasApiToken={data.workiz.hasApiToken}
          impact={data.unmappedImpact}
          view={teamFilter}
          onViewChange={(view) => onNavigate({ view: "settings", section: "team", teamFilter: view })}
          focusToken={focusToken}
          timezone={timezone}
        />
      )}
      {section === "technicians" && <ProfilesTab profiles={data.profiles} />}
      {section === "workiz" && <WorkizSettingsTab workiz={data.workiz} catalog={data.catalog} webhookUrl={webhookUrl} cronConfigured={cronConfigured} />}
      {section === "sync" && (
        <div className="flex flex-col gap-4">
          <SyncStatusStrip initial={data.sync} timezone={timezone} onOpenWorkizTab={() => onNavigate({ view: "settings", section: "workiz" })} />
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">How syncing works</CardTitle>
              <CardDescription>The Refresh button at the top of every page runs the same sync as the schedule.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p>
                Automatic sync runs <strong>{data.sync.scheduleLabel}</strong> ({timezone}). Each run lists recent Workiz jobs, fetches the ones that changed within the API budget, recalculates open payouts and
                replays any parked webhook events. Paid and voided payouts are never rewritten.
              </p>
              <p className="text-muted-foreground">
                Every run is logged under{" "}
                <NavLink loc={{ view: "settings", section: "activity" }} onNavigate={onNavigate}>
                  Activity
                </NavLink>
                ; a single job can be re-synced by UUID from All payouts.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      {section === "activity" && <ActivityTab events={data.events} />}
      {section === "opening" &&
        (data.opening.openingInitializedAt ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                Opening balance recorded
              </CardTitle>
              <CardDescription>This was a one-time step and cannot be run again. The cutoff below is fixed.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Everyone was paid up as of</dt>
                <dd>{data.opening.openingCutoffAt ? zonedDateTime(data.opening.openingCutoffAt, timezone) : "—"}</dd>
                <dt className="text-muted-foreground">Recorded</dt>
                <dd>
                  {zonedDateTime(data.opening.openingInitializedAt, timezone)}
                  {data.opening.openingInitializedBy ? ` by ${data.opening.openingInitializedBy}` : ""}
                </dd>
                <dt className="text-muted-foreground">History entries</dt>
                <dd className="flex flex-wrap gap-2">
                  {data.opening.openingBatchIds.length === 0
                    ? "None"
                    : data.opening.openingBatchIds.map((id) => (
                        <NavLink key={id} loc={{ view: "history", batchId: id }} onNavigate={onNavigate}>
                          Payment #{id}
                        </NavLink>
                      ))}
                </dd>
              </dl>
              <p className="text-muted-foreground">If the cutoff was wrong, undo the opening-balance entries from Paid history; that returns the carried-in jobs to Due.</p>
            </CardContent>
          </Card>
        ) : (
          <OpeningBalanceCard timezone={timezone} onDone={() => router.refresh()} />
        ))}
    </div>
  )
}
