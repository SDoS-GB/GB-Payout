"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { AdminDashboardData } from "@/app/actions/admin"
import { signOutSession } from "@/app/actions/session"
import { DEFAULT_PAYOUT_QUERY, type PayoutQuery } from "@/lib/payout/presentation"
import { adminHref, adminPageTitle, parseAdminLocation, type AdminLocation } from "@/lib/admin/navigation"
import { AdminMenu, type MenuCounts } from "./admin-menu"
import { LastUpdatedLine, RefreshButton, useSyncRefresh } from "./refresh-control"
import { NotificationBell } from "./notification-bell"
import { DueTab } from "./due-tab"
import { PaidHistoryTab } from "./paid-history-tab"
import { PayoutsTab } from "./payouts-tab"
import { ReviewTab } from "./review-tab"
import { WaitingTab } from "./waiting-tab"
import { SettingsTab } from "./settings-tab"

/**
 * One route, several pages. The current page lives in the URL (see lib/admin/navigation.ts) and
 * is switched with the History API, so Back/Forward and bookmarks work without reloading the
 * data the server already sent.
 */
export function AdminDashboard({ data, webhookUrl, cronConfigured }: { data: AdminDashboardData; webhookUrl: string; cronConfigured: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const location = useMemo(() => parseAdminLocation(searchParams), [searchParams])
  const timezone = data.workiz.businessTimezone
  const sync = useSyncRefresh(data.sync)

  const [signingOut, startSignOut] = useTransition()
  const [focusToken, setFocusToken] = useState(0)
  const [payoutsQuery, setPayoutsQuery] = useState<PayoutQuery>(DEFAULT_PAYOUT_QUERY)
  const [reviewQuery, setReviewQuery] = useState<PayoutQuery>({ ...DEFAULT_PAYOUT_QUERY, status: "hold" })
  const [waitingQuery, setWaitingQuery] = useState<PayoutQuery>({ ...DEFAULT_PAYOUT_QUERY, status: "pending" })
  const previousView = useRef(location.view)

  const navigate = useCallback((loc: Partial<AdminLocation>) => {
    const href = adminHref(loc)
    const current = `${window.location.pathname}${window.location.search}`
    if (href !== current) window.history.pushState(null, "", href)
    setFocusToken((t) => t + 1)
  }, [])

  useEffect(() => {
    if (previousView.current !== location.view) {
      previousView.current = location.view
      window.scrollTo({ top: 0 })
    }
  }, [location.view])

  const signOut = () =>
    startSignOut(async () => {
      await signOutSession()
      router.push("/admin/login")
      router.refresh()
    })

  const unmappedPeople = data.mappings.filter((m) => m.profileId == null && !m.excluded)
  const dueJobs = data.due.technicians.reduce((n, t) => n + t.count, 0)
  const statusCount = useCallback((status: string) => data.statusCounts.filter((c) => c.status === status).reduce((s, c) => s + c.count, 0), [data.statusCounts])
  const holdCount = statusCount("hold")
  const pendingCount = statusCount("pending")
  const openingMissing = !data.opening.openingInitializedAt

  const counts: MenuCounts = {
    due: dueJobs,
    review: holdCount + data.sourceChanges.length,
    waiting: pendingCount,
    settings: unmappedPeople.length + (openingMissing ? 1 : 0),
  }

  // A notification about one held job opens Review already filtered to that job.
  const openReviewJob = useCallback(
    (search: string) => {
      setReviewQuery({ ...DEFAULT_PAYOUT_QUERY, status: "hold", search })
      navigate({ view: "review" })
    },
    [navigate],
  )

  const title = adminPageTitle(location)

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 print:hidden">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-3 py-2 sm:px-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <AdminMenu current={location.view} counts={counts} onNavigate={navigate} onSignOut={signOut} signingOut={signingOut} />
              <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <NotificationBell notices={data.notices} onNavigate={navigate} onReviewJob={openReviewJob} />
              <RefreshButton sync={sync} />
            </div>
          </div>
          <div className="pl-12">
            <LastUpdatedLine sync={sync} timezone={timezone} />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-4 sm:py-6">
        {location.view === "due" && (
          <DueTab
            due={data.due}
            paymentMethods={data.paymentMethods}
            timezone={timezone}
            focusProfileId={location.techId}
            focusToken={focusToken}
            onOpenBatch={(batchId) => navigate({ view: "history", batchId: batchId || null })}
          />
        )}
        {location.view === "history" && (
          <PaidHistoryTab
            batches={data.batches}
            legacyPaid={data.legacyPaid}
            profiles={data.profiles}
            timezone={timezone}
            openBatchId={location.batchId}
            focusToken={focusToken}
            onBackToDue={() => navigate({ view: "due" })}
          />
        )}
        {location.view === "payouts" && (
          <PayoutsTab
            initialPage={null}
            profiles={data.profiles}
            query={payoutsQuery}
            onQueryChange={setPayoutsQuery}
            focusToken={0}
            timezone={timezone}
            onGoToDue={(profileId) => navigate({ view: "due", techId: profileId })}
            onOpenBatch={(batchId) => navigate({ view: "history", batchId })}
          />
        )}
        {location.view === "review" && (
          <ReviewTab
            sourceChanges={data.sourceChanges}
            unmappedCount={unmappedPeople.length}
            profiles={data.profiles}
            query={reviewQuery}
            onQueryChange={setReviewQuery}
            timezone={timezone}
            onNavigate={navigate}
          />
        )}
        {location.view === "waiting" && (
          <WaitingTab waiting={data.waiting} profiles={data.profiles} query={waitingQuery} onQueryChange={setWaitingQuery} timezone={timezone} onNavigate={navigate} />
        )}
        {location.view === "settings" && (
          <SettingsTab
            data={data}
            section={location.section}
            teamFilter={location.teamFilter}
            focusToken={focusToken}
            webhookUrl={webhookUrl}
            cronConfigured={cronConfigured}
            unmappedCount={unmappedPeople.length}
            onNavigate={navigate}
          />
        )}
      </div>
    </main>
  )
}
