/**
 * The Workiz sync schedule in business time. Vercel Cron only understands UTC, so vercel.json
 * fires at every UTC hour that can be 2 PM or 10 PM in New York (18/19 and 02/03 UTC) and the
 * route keeps only the invocations that land in the right local hour. Pure functions, DST-safe.
 */

export const BUSINESS_TIMEZONE = "America/New_York"
/** Local hours (24h) at which the scheduled sync runs. */
export const SYNC_HOURS_LOCAL = [14, 22] as const
/** How late a scheduled run may be before the dashboard calls the sync overdue. */
export const SYNC_GRACE_MINUTES = 45

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function zonedParts(date: Date, timeZone = BUSINESS_TIMEZONE): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)
  const num = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? "0")
  return { year: num("year"), month: num("month"), day: num("day"), hour: num("hour"), minute: num("minute"), second: num("second") }
}

/** Minutes the zone is ahead of UTC at `date` (negative for the Americas). */
function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - date.getTime()) / 60_000)
}

/** The instant at which a wall-clock time occurs in a zone (two passes handle the DST edges). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute = 0, timeZone = BUSINESS_TIMEZONE): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const first = guess - offsetMinutes(new Date(guess), timeZone) * 60_000
  const second = guess - offsetMinutes(new Date(first), timeZone) * 60_000
  return new Date(second)
}

/** True when `now` falls inside one of the scheduled local hours. */
export function isScheduledSyncHour(now: Date, timeZone = BUSINESS_TIMEZONE): boolean {
  return (SYNC_HOURS_LOCAL as ReadonlyArray<number>).includes(zonedParts(now, timeZone).hour)
}

function slotsAround(now: Date, timeZone: string): Date[] {
  const p = zonedParts(now, timeZone)
  const slots: Date[] = []
  for (const dayOffset of [-1, 0, 1]) {
    // Build the local calendar day via UTC arithmetic, then pin each slot to the zone.
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset))
    for (const hour of SYNC_HOURS_LOCAL) slots.push(zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, 0, timeZone))
  }
  return slots.sort((a, b) => a.getTime() - b.getTime())
}

/** Most recent scheduled slot at or before `now`. */
export function previousScheduledSlot(now: Date, timeZone = BUSINESS_TIMEZONE): Date {
  const past = slotsAround(now, timeZone).filter((s) => s.getTime() <= now.getTime())
  return past[past.length - 1]
}

/** First scheduled slot strictly after `now`. */
export function nextScheduledSlot(now: Date, timeZone = BUSINESS_TIMEZONE): Date {
  return slotsAround(now, timeZone).find((s) => s.getTime() > now.getTime()) as Date
}

export type SyncHealth = "never" | "ok" | "overdue"

/**
 * "overdue" when the most recent scheduled slot has passed by more than the grace period and no
 * complete sync has happened since that slot. A manual "Sync now" that completes also counts.
 */
export function syncHealth(now: Date, lastSuccessAt: Date | null, opts: { timeZone?: string; graceMinutes?: number } = {}): SyncHealth {
  if (!lastSuccessAt) return "never"
  const tz = opts.timeZone ?? BUSINESS_TIMEZONE
  const grace = (opts.graceMinutes ?? SYNC_GRACE_MINUTES) * 60_000
  const slot = previousScheduledSlot(now, tz)
  if (now.getTime() - slot.getTime() <= grace) return "ok"
  return lastSuccessAt.getTime() >= slot.getTime() ? "ok" : "overdue"
}

export function formatSlot(date: Date, timeZone = BUSINESS_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date)
}
