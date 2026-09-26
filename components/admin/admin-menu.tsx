"use client"

import { useState } from "react"
import { Calculator, LogOut, Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { ADMIN_VIEW_LABELS, adminHref, type AdminLocation, type AdminView } from "@/lib/admin/navigation"

export type MenuCounts = Partial<Record<AdminView, number>>

const ORDER: AdminView[] = ["due", "history", "payouts", "review", "waiting", "settings"]

const HINTS: Record<AdminView, string> = {
  due: "Pay technicians",
  history: "Payments recorded, undo, export",
  payouts: "Every payout record",
  review: "Holds and paid jobs that changed",
  waiting: "Not finished or not paid yet",
  settings: "Team, Workiz, sync, opening balance",
}

/**
 * The only navigation on the admin pages. Closed by default; each destination is a real link so
 * it can be opened in a new tab, and choosing one closes the drawer. Radix handles focus,
 * Escape and outside clicks.
 */
export function AdminMenu({ current, counts, onNavigate, onSignOut, signingOut }: { current: AdminView; counts: MenuCounts; onNavigate: (loc: Partial<AdminLocation>) => void; onSignOut: () => void; signingOut: boolean }) {
  const [open, setOpen] = useState(false)

  const go = (e: React.MouseEvent, loc: Partial<AdminLocation>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
    e.preventDefault()
    setOpen(false)
    onNavigate(loc)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open menu" className="h-10 w-10 shrink-0">
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col gap-0 p-0 sm:max-w-xs">
        <SheetHeader className="border-b px-5 py-4 text-left">
          <SheetTitle className="text-base">Grout Brothers payouts</SheetTitle>
          <SheetDescription className="sr-only">Admin pages</SheetDescription>
        </SheetHeader>
        <nav aria-label="Admin pages" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {ORDER.map((view) => {
            const active = view === current
            const count = counts[view] ?? 0
            return (
              <a
                key={view}
                href={adminHref({ view })}
                onClick={(e) => go(e, { view })}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-accent font-semibold" : ""}`}
              >
                <span className="flex flex-col">
                  <span className="text-base">{ADMIN_VIEW_LABELS[view]}</span>
                  <span className="text-xs font-normal text-muted-foreground">{HINTS[view]}</span>
                </span>
                {count > 0 && (
                  <span className="min-w-6 rounded-full bg-primary px-2 py-0.5 text-center text-xs font-semibold tabular-nums text-primary-foreground" aria-label={`${count} item${count === 1 ? "" : "s"}`}>
                    {count > 999 ? "999+" : count}
                  </span>
                )}
              </a>
            )
          })}
        </nav>
        <Separator />
        <div className="flex flex-col gap-1 p-3">
          <a href="/" className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Calculator className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Calculator
          </a>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            disabled={signingOut}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <LogOut className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
