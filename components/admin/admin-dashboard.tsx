"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { Calculator, LogOut } from "lucide-react"
import type { AdminDashboardData } from "@/app/actions/admin"
import { signOutSession } from "@/app/actions/session"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { DEFAULT_PAYOUT_QUERY, type PayoutQuery } from "@/lib/payout/presentation"
import { PayoutsTab } from "./payouts-tab"
import { WorkizSettingsTab } from "./workiz-settings-tab"
import { TeamMappingTab } from "./team-mapping-tab"
import { ProfilesTab } from "./profiles-tab"
import { OwnerTextsTab } from "./owner-texts-tab"
import { ActivityTab } from "./activity-tab"
import { money } from "./shared"

type CardKey = "ready" | "hold" | "pending" | "unmapped"

export function AdminDashboard({ data, webhookUrl, cronConfigured }: { data: AdminDashboardData; webhookUrl: string; cronConfigured: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [tab, setTab] = useState("payouts")
  const [payoutQuery, setPayoutQuery] = useState<PayoutQuery>(DEFAULT_PAYOUT_QUERY)
  const [teamView, setTeamView] = useState<"all" | "unmapped">("all")
  const [focusToken, setFocusToken] = useState(0)

  const signOut = () =>
    startTransition(async () => {
      await signOutSession()
      router.push("/admin/login")
      router.refresh()
    })

  const unmappedPeople = data.mappings.filter((m) => m.profileId == null && !m.excluded)
  // Failed texts and webhook payloads the app could not attach to a job both need a human look.
  const ownerAttention = data.ownerTexts.rows.filter((r) => r.status === "failed").length + (data.ownerTexts.webhookCounts.unresolved ?? 0) + (data.ownerTexts.webhookCounts.failed ?? 0)
  const selectedProfile = payoutQuery.profileId != null ? data.profiles.find((p) => p.id === payoutQuery.profileId) ?? null : null

  // Individual payout-record counts from the same table + status definitions the list queries.
  const counts = useMemo(() => {
    const scoped = data.statusCounts.filter((c) => payoutQuery.profileId == null || c.profileId === payoutQuery.profileId)
    const sum = (status: string, field: "count" | "total") => scoped.filter((c) => c.status === status).reduce((s, c) => s + c[field], 0)
    return {
      ready: sum("ready", "count"),
      readyTotal: sum("ready", "total"),
      hold: sum("hold", "count"),
      pending: sum("pending", "count"),
    }
  }, [data.statusCounts, payoutQuery.profileId])

  const openCard = (card: CardKey) => {
    if (card === "unmapped") {
      setTeamView("unmapped")
      setTab("team")
    } else {
      // Keep the technician scope (the cards reflect it) but drop search/paging so the list count equals the card.
      setPayoutQuery((q) => ({ ...q, status: card, search: "", page: 1 }))
      setTab("payouts")
    }
    setFocusToken((t) => t + 1)
  }

  const selectedCard: CardKey | null =
    tab === "team" && teamView === "unmapped"
      ? "unmapped"
      : tab === "payouts" && payoutQuery.search === "" && (payoutQuery.status === "ready" || payoutQuery.status === "hold" || payoutQuery.status === "pending")
        ? payoutQuery.status
        : null

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const scopeSuffix = selectedProfile ? ` for ${selectedProfile.name}` : ""

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
          <SummaryCard
            label="Ready to pay"
            value={counts.ready}
            hint={
              selectedProfile
                ? `${money(counts.readyTotal)} owed to ${selectedProfile.name}`
                : counts.ready
                  ? `${plural(counts.ready, "individual payout")} · pick a technician for their total`
                  : "Nothing ready yet"
            }
            tone="primary"
            selected={selectedCard === "ready"}
            onClick={() => openCard("ready")}
            description={`Open ready, unpaid payouts${scopeSuffix}`}
          />
          <SummaryCard
            label="On hold"
            value={counts.hold}
            hint={counts.hold ? "Needs review · open to see why" : "Nothing needs review"}
            tone={counts.hold ? "warn" : "muted"}
            selected={selectedCard === "hold"}
            onClick={() => openCard("hold")}
            description={`Open payouts on hold${scopeSuffix}`}
          />
          <SummaryCard
            label="Pending"
            value={counts.pending}
            hint={counts.pending ? "Job not finished or not paid · provisional" : "No pending payouts"}
            tone="muted"
            selected={selectedCard === "pending"}
            onClick={() => openCard("pending")}
            description={`Open pending payouts${scopeSuffix}`}
          />
          <SummaryCard
            label="Unmapped team ids"
            value={unmappedPeople.length}
            hint={unmappedPeople.length ? `${plural(unmappedPeople.length, "person")} to link` : "All mapped"}
            tone={unmappedPeople.length ? "warn" : "muted"}
            selected={selectedCard === "unmapped"}
            onClick={() => openCard("unmapped")}
            description="Open unmapped Workiz team members"
          />
        </section>

        <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-4">
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="payouts">Payouts</TabsTrigger>
            <TabsTrigger value="team">
              Team mapping
              {unmappedPeople.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {unmappedPeople.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="profiles">Technicians</TabsTrigger>
            <TabsTrigger value="notifications">
              Owner texts
              {ownerAttention > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {ownerAttention}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="workiz">Workiz</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="payouts">
            <PayoutsTab
              initialPage={data.payoutPage}
              profiles={data.profiles}
              query={payoutQuery}
              onQueryChange={setPayoutQuery}
              focusToken={tab === "payouts" ? focusToken : 0}
              timezone={data.workiz.businessTimezone}
            />
          </TabsContent>
          <TabsContent value="team">
            <TeamMappingTab
              mappings={data.mappings}
              profiles={data.profiles}
              hasApiToken={data.workiz.hasApiToken}
              impact={data.unmappedImpact}
              view={teamView}
              onViewChange={setTeamView}
              focusToken={tab === "team" ? focusToken : 0}
              timezone={data.workiz.businessTimezone}
            />
          </TabsContent>
          <TabsContent value="profiles">
            <ProfilesTab profiles={data.profiles} />
          </TabsContent>
          <TabsContent value="notifications">
            <OwnerTextsTab data={data.ownerTexts} lastWebhook={data.workiz.lastWebhook} timezone={data.workiz.businessTimezone} onOpenWorkizTab={() => setTab("workiz")} />
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

function SummaryCard({
  label,
  value,
  hint,
  tone,
  selected,
  onClick,
  description,
}: {
  label: string
  value: number
  hint: string
  tone: "primary" | "warn" | "muted"
  selected: boolean
  onClick: () => void
  description: string
}) {
  const toneClass = tone === "primary" ? "text-primary" : tone === "warn" ? "text-warning-foreground" : "text-foreground"
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${label}: ${value}. ${description}`}
      className={`flex flex-col gap-1 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        selected ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/30" : ""
      }`}
    >
      <span className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {selected && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-primary-foreground">Viewing</span>}
      </span>
      <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}
