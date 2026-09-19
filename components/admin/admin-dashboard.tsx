"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { Calculator, LogOut } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { signOutSession } from "@/app/actions/session"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { PayoutsTab } from "./payouts-tab"
import { WorkizSettingsTab } from "./workiz-settings-tab"
import { TeamMappingTab } from "./team-mapping-tab"
import { ProfilesTab } from "./profiles-tab"
import { NotificationsTab } from "./notifications-tab"
import { ActivityTab } from "./activity-tab"

export function AdminDashboard({ data, webhookUrl, cronConfigured }: { data: AdminDashboardData; webhookUrl: string; cronConfigured: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const signOut = () =>
    startTransition(async () => {
      await signOutSession()
      router.push("/admin/login")
      router.refresh()
    })

  const unmapped = data.mappings.filter((m) => m.profileId == null && !m.excluded).length

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Payout automation</h1>
            <p className="text-sm text-muted-foreground">Workiz jobs → technician payouts</p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/">
                <Calculator className="h-4 w-4" />
                Calculator
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut} disabled={pending}>
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
        <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Ready to pay" value={data.counts.ready} hint={`$${data.counts.readyTotal.toFixed(2)} owed`} tone="primary" />
          <Stat label="On hold" value={data.counts.hold} hint="Needs review" tone={data.counts.hold ? "warn" : "muted"} />
          <Stat label="Pending" value={data.counts.pending} hint="Job not finished / paid" tone="muted" />
          <Stat label="Unmapped team ids" value={unmapped} hint={unmapped ? "Map in Team tab" : "All mapped"} tone={unmapped ? "warn" : "muted"} />
        </section>

        <Tabs defaultValue="payouts" className="flex flex-col gap-4">
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="payouts">Payouts</TabsTrigger>
            <TabsTrigger value="team">
              Team mapping
              {unmapped > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {unmapped}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="profiles">Technicians</TabsTrigger>
            <TabsTrigger value="notifications">Messages</TabsTrigger>
            <TabsTrigger value="workiz">Workiz</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="payouts">
            <PayoutsTab payouts={data.payouts} profiles={data.profiles} />
          </TabsContent>
          <TabsContent value="team">
            <TeamMappingTab mappings={data.mappings} profiles={data.profiles} hasApiToken={data.workiz.hasApiToken} />
          </TabsContent>
          <TabsContent value="profiles">
            <ProfilesTab profiles={data.profiles} />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsTab settings={data.notifications} payouts={data.payouts} />
          </TabsContent>
          <TabsContent value="workiz">
            <WorkizSettingsTab workiz={data.workiz} catalog={data.catalog} webhookUrl={webhookUrl} cronConfigured={cronConfigured} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityTab events={data.events} />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: "primary" | "warn" | "muted" }) {
  const toneClass =
    tone === "primary" ? "text-primary" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground"
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  )
}
