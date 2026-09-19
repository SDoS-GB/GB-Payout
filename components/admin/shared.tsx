"use client"

import { Badge } from "@/components/ui/badge"

export const money = (v: string | number | null | undefined) => `$${Number(v ?? 0).toFixed(2)}`

export const shortDate = (d: Date | string | null | undefined) => {
  if (!d) return "—"
  const date = typeof d === "string" ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export const shortDateTime = (d: Date | string | null | undefined) => {
  if (!d) return "—"
  const date = typeof d === "string" ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

const STATUS_STYLES: Record<string, string> = {
  ready: "bg-primary/10 text-primary border-primary/20",
  hold: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300",
  pending: "bg-muted text-muted-foreground border-border",
  paid: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
  void: "bg-destructive/10 text-destructive border-destructive/30",
  sent: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
  previewed: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/10 text-destructive border-destructive/30",
  skipped: "bg-muted text-muted-foreground border-border",
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={`capitalize ${STATUS_STYLES[status] ?? ""}`}>
      {status}
    </Badge>
  )
}

export function InlineMessage({ tone, children }: { tone: "ok" | "error" | "info"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "error"
        ? "text-destructive"
        : "text-muted-foreground"
  return <p className={`text-sm ${cls}`}>{children}</p>
}
