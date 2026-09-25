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
import { DueTab } from "./due-tab"
import { PaidHistoryTab } from "./paid-history-tab"
import { PayoutsTab } from "./payouts-tab"
import { SyncStatusStrip } from "./sync-status-strip"
import { WorkizSettingsTab } from "./workiz-settings-tab"
import { TeamMappingTab } from "./team-mapping-tab"
import { ProfilesTab } from "./profiles-tab"
import { ActivityTab } from "./activity-tab"
import { money } from "./shared"

type CardKey = "due" | "hold" | "pending" | "unmapped"

export function AdminDashboard({ data, webhookUrl, cronConfigured }: { data: AdminDashboardData; webhookUrl: string; cronConfigured: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [tab, setTab] = useState("due")
  const [payoutQuery, setPayoutQuery] = useState<PayoutQuery>(DEFAULT_PAYOUT_QUERY)
  const [teamView, setTeamView] = useState<"all" | "unmapped">("all")
  const [focusToken, setFocusToken] = useState(0)
  const [dueFocus, setDueFocus] = useState<number | null>(null)
  const [openBatchId, setOpenBatchId] = useState<number | null>(null)

  const signOut = () =>
    startTransition(async () => {
      await signOutSession()
      router.push("/admin/login")
      router.refresh()
    })

  const unmappedPeople = data.mappings.filter((m) => m.profileId == null && !m.excluded)
  const dueTotal = data.due.technicians.reduce((cents, t) => cents + Math.round(t.total * 100), 0) / 100
  const dueCount = data.due.technicians.reduce((n, t) => n + t.count, 0)
  const attention = data.sourceChanges.length + (data.opening.openingInitializedAt ? 0 : 1)

  // Individual payout-record counts from the same table + status definitions the list queries.
  const counts = useMemo(() => {
    const sum = (status: string) => data.statusCounts.filter((c) => c.status === status).reduce((s, c) => s + c.count, 0)
    return { hold: sum("hold"), pending: sum("pending") }
  }, [data.statusCounts])

  const focus = () => setFocusToken((t) => t + 1)

  const openCard = (card: CardKey) => {
    if (card === "unmapped") {
      setTeamView("unmapped")
      setTab("team")
    } else if (card === "due") {
      setDueFocus(null)
      setTab("due")
    } else {
      setPayoutQuery((q) => ({ ...q, status: card, profileId: null, search: "", page: 1 }))
      setTab("payouts")
    }
    focus()
  }

  const goToDue = (profileId: number) => {
    setDueFocus(profileId)
    setTab("due")
    focus()
  }

  const openBatch = (batchId: number) => {
    setOpenBatchId(batchId > 0 ? batchId : null)
    setTab("history")
    focus()
  }

  const openReview = (status: "hold" | "pending") => {
    setPayoutQuery((q) => ({ ...q, status, profileId: null, search: "", page: 1 }))
    setTab("payouts")
    focus()
  }

  const selectedCard: CardKey | null =
    tab === "due"
      ? "due"
      : tab === "team" && teamView === "unmapped"
        ? "unmapped"
        : tab === "payouts" && payoutQuery.search === "" && (payoutQuery.status === "hold" || payoutQuery.status === "pending")
          ? payoutQuery.status
          : null

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Technician payouts</h1>
            <p className="text-sm text-muted-foreground">What each technician is owed from finished, paid Workiz jobs</p>
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
        <SyncStatusStrip initial={data.sync} timezone={data.workiz.businessTimezone} onOpenWorkizTab={() => setTab("workiz")} />

        <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryCard
            label="Due now"
            value={money(dueTotal)}
            hint={dueCount ? `${plural(dueCount, "job")} across ${plural(data.due.technicians.length, "technician")}` : "Nobody is owed anything"}
            tone="primary"
            selected={selectedCard === "due"}
            onClick={() => openCard("due")}
            description="Open what is due per technician"
          />
          <SummaryCard
            label="Needs your call"
            value={String(counts.hold)}
            hint={counts.hold ? "Payment method, tip split or discount to confirm" : "Nothing to decide"}
            tone={counts.hold ? "warn" : "muted"}
            selected={selectedCard === "hold"}
            onClick={() => openCard("hold")}
            description="Open payouts on hold"
          />
          <SummaryCard
            label="Waiting"
            value={String(counts.pending)}
            hint={counts.pending ? "Job not finished or customer not paid yet" : "Nothing waiting"}
            tone="muted"
            selected={selectedCard === "pending"}
            onClick={() => openCard("pending")}
            description="Open pending payouts"
          />
          <SummaryCard
            label="Unmapped team ids"
            value={String(unmappedPeople.length)}
            hint={unmappedPeople.length ? `${plural(unmappedPeople.length, "person")} to link before their jobs can pay` : "All mapped"}
            tone={unmappedPeople.length ? "warn" : "muted"}
            selected={selectedCard === "unmapped"}
            onClick={() => openCard("unmapped")}
            description="Open unmapped Workiz team members"
          />
        </section>

        <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-4">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 group-data-[orientation=horizontal]/tabs:h-auto">
            <TabsTrigger value="due">
              Due
              {attention > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {attention}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="payouts">All payouts</TabsTrigger>
            <TabsTrigger value="history">Paid history</TabsTrigger>
            <TabsTrigger value="team">
              Team mapping
              {unmappedPeople.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {unmappedPeople.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="profiles">Technicians</TabsTrigger>
            <TabsTrigger value="workiz">Workiz</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="due">
            <DueTab
              due={data.due}
              waiting={data.waiting}
              sourceChanges={data.sourceChanges}
              opening={data.opening}
              paymentMethods={data.paymentMethods}
              timezone={data.workiz.businessTimezone}
              focusProfileId={dueFocus}
              focusToken={tab === "due" ? focusToken : 0}
              onOpenReview={openReview}
              onOpenBatch={openBatch}
            />
          </TabsContent>
          <TabsContent value="payouts">
            <PayoutsTab
              initialPage={null}
              profiles={data.profiles}
              query={payoutQuery}
              onQueryChange={setPayoutQuery}
              focusToken={tab === "payouts" ? focusToken : 0}
              timezone={data.workiz.businessTimezone}
              onGoToDue={goToDue}
              onOpenBatch={openBatch}
            />
          </TabsContent>
          <TabsContent value="history">
            <PaidHistoryTab batches={data.batches} legacyPaid={data.legacyPaid} profiles={data.profiles} timezone={data.workiz.businessTimezone} openBatchId={openBatchId} focusToken={tab === "history" ? focusToken : 0} />
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
  value: string
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
