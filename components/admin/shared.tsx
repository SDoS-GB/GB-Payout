"use client"

import { Badge } from "@/components/ui/badge"

export const money = (v: string | number | null | undefined) => {
  const n = Number(v ?? 0)
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `−$${abs}` : `$${abs}`
}

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

const toDate = (d: Date | string | null | undefined) => {
  if (!d) return null
  const date = typeof d === "string" ? new Date(d) : d
  return Number.isNaN(date.getTime()) ? null : date
}

const safeTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return tz
  } catch {
    return "America/New_York"
  }
}

/** Calendar date in the business timezone, e.g. "Sep 9, 2026". */
export const zonedDate = (d: Date | string | null | undefined, tz: string) => {
  const date = toDate(d)
  if (!date) return "—"
  return new Intl.DateTimeFormat("en-US", { timeZone: safeTimeZone(tz), month: "short", day: "numeric", year: "numeric" }).format(date)
}

/** Date and time in the business timezone with its abbreviation, e.g. "Sep 9, 2026, 9:00 AM EDT". */
export const zonedDateTime = (d: Date | string | null | undefined, tz: string) => {
  const date = toDate(d)
  if (!date) return "—"
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(tz),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date)
}

const STATUS_STYLES: Record<string, string> = {
  ready: "bg-secondary/25 text-primary border-secondary/60",
  hold: "bg-warning/15 text-warning-foreground border-warning/50",
  pending: "bg-muted text-muted-foreground border-border",
  paid: "bg-primary text-primary-foreground border-primary",
  void: "bg-destructive/15 text-destructive-foreground border-destructive/50",
  sent: "bg-primary text-primary-foreground border-primary",
  previewed: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/15 text-destructive-foreground border-destructive/50",
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
      ? "text-success-foreground"
      : tone === "error"
        ? "text-warning-foreground"
        : "text-muted-foreground"
  return <p className={`text-sm ${cls}`}>{children}</p>
}
