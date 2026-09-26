"use client"

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Bell, CheckCircle2, ChevronRight } from "lucide-react"
import { dismissAdminNotices } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { adminHref, type AdminLocation } from "@/lib/admin/navigation"
import { keysOf, withoutDismissed, type AdminNotice, type AdminNoticeAction } from "@/lib/admin/notices"
import { InlineMessage } from "./shared"

type Props = {
  notices: AdminNotice[]
  onNavigate: (loc: Partial<AdminLocation>) => void
  /** Open the Review page filtered to one job. */
  onReviewJob: (search: string) => void
}

const hrefFor = (action: AdminNoticeAction) => (action.kind === "navigate" ? adminHref(action.loc) : adminHref({ view: "review" }))

/**
 * The bell left of Refresh. Closed by default; Radix handles outside taps, Escape and focus.
 * CLEAR dismisses exactly the notifications on screen: they hide at once, the server records
 * the dismissal for this admin, and on failure they come back with the error. Nothing here
 * changes a payout, a hold or Workiz — it only hides the notice.
 */
export function NotificationBell({ notices, onNavigate, onReviewJob }: Props) {
  const router = useRouter()
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [clearedKeys, setClearedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const visible = withoutDismissed(notices, clearedKeys)
  const count = visible.length

  const clear = () => {
    if (pending || count === 0) return
    const keys = keysOf(visible)
    setError(null)
    setClearedKeys((prev) => new Set([...prev, ...keys]))
    startTransition(async () => {
      const res = await dismissAdminNotices(keys)
      if (!res.ok) {
        setClearedKeys((prev) => {
          const next = new Set(prev)
          for (const k of keys) next.delete(k)
          return next
        })
        setError(res.error)
        return
      }
      router.refresh()
    })
  }

  const act = (e: React.MouseEvent, action: AdminNoticeAction) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
    e.preventDefault()
    setOpen(false)
    if (action.kind === "navigate") onNavigate(action.loc)
    else onReviewJob(action.search)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={count > 0 ? `Notifications, ${count} need${count === 1 ? "s" : ""} attention` : "Notifications, none"} className="relative h-10 w-10 shrink-0">
          <Bell className="h-5 w-5" aria-hidden="true" />
          {count > 0 && (
            <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none tabular-nums text-destructive-foreground">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} collisionPadding={12} aria-labelledby={titleId} className="flex w-[min(calc(100vw-1.5rem),24rem)] flex-col gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold">
            Notifications
            {count > 0 && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">({count})</span>}
          </h2>
          <Button type="button" variant="outline" size="sm" onClick={clear} disabled={pending || count === 0} aria-busy={pending} className="h-9 px-3 font-bold tracking-wide">
            {pending ? "Clearing…" : "CLEAR"}
          </Button>
        </div>

        {error && (
          <div className="px-4 pt-3">
            <InlineMessage tone="error">{error}</InlineMessage>
          </div>
        )}

        {count === 0 ? (
          <p className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-6 w-6 text-primary" aria-hidden="true" />
            No notifications
          </p>
        ) : (
          <ul aria-label="Notifications" className="flex max-h-[min(60vh,26rem)] flex-col divide-y overflow-y-auto overscroll-contain">
            {visible.map((n) => (
              <li key={n.id}>
                <a
                  href={hrefFor(n.action)}
                  onClick={(e) => act(e, n.action)}
                  className="flex min-h-14 items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-warning-foreground">{n.category}</span>
                    <span className="text-sm font-medium leading-snug text-foreground">{n.title}</span>
                    {n.detail && <span className="text-sm leading-snug text-muted-foreground">{n.detail}</span>}
                    <span className="sr-only">. {n.actionLabel}</span>
                  </span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        )}

        {count > 0 && <p className="border-t px-4 py-2 text-xs text-muted-foreground">CLEAR hides these notices for good. It does not pay, release or approve anything — use Review for that.</p>}
      </PopoverContent>
    </Popover>
  )
}
