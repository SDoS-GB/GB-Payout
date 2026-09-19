/**
 * Workiz returns timestamps as naive wall-clock strings in the account's
 * timezone ("2026-09-24 09:00:00", "2026-09-17 00:00:00"). `new Date()` would
 * read those in the server's zone (UTC on Vercel), shifting every job by the
 * business offset. This parser pins naive strings to the business timezone
 * and leaves strings that carry their own offset untouched.
 */

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat | null {
  let f = formatterCache.get(timeZone)
  if (f) return f
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return null
  }
  formatterCache.set(timeZone, f)
  return f
}

/** Milliseconds the zone is ahead of UTC at the given instant (negative for the Americas). */
function zoneOffsetMs(timeZone: string, at: Date): number | null {
  const f = formatter(timeZone)
  if (!f) return null
  const parts = f.formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? "0")
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"))
  return asUtc - at.getTime()
}

/** Interpret a wall-clock date/time as occurring in `timeZone` and return the real instant. */
export function zonedWallClockToDate(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): Date | null {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
  const first = zoneOffsetMs(timeZone, new Date(guess))
  if (first === null) return null
  let instant = guess - first
  // Re-check around DST transitions: the offset at the corrected instant may differ.
  const second = zoneOffsetMs(timeZone, new Date(instant))
  if (second !== null && second !== first) instant = guess - second
  const d = new Date(instant)
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseWorkizDate(value: unknown, timeZone: string): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const s = String(value).trim()
  if (!s || s.startsWith("0000-00-00")) return null

  const naive = NAIVE.exec(s)
  if (naive && !HAS_OFFSET.test(s)) {
    const [, y, mo, d, h, mi, sec] = naive
    return zonedWallClockToDate(
      { year: Number(y), month: Number(mo), day: Number(d), hour: h ? Number(h) : 0, minute: mi ? Number(mi) : 0, second: sec ? Number(sec) : 0 },
      timeZone,
    )
  }

  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
