import type { WorkizRawJob } from "./client"

/**
 * Fields that `job/all` shares with `job/get` and that move whenever a payout input can move:
 * status, money, dates, tags and crew. Line items are not listed, but a line-item edit that
 * changes the payout also changes SubTotal / JobTotalPrice.
 */
export const LISTING_WATCHED_KEYS = [
  "Status",
  "SubStatus",
  "JobTotalPrice",
  "SubTotal",
  "JobAmountDue",
  "LastStatusUpdate",
  "JobDateTime",
  "JobEndDateTime",
  "PaymentDueDate",
  "Tags",
  "Team",
] as const

/** Fewer shared keys than this and the two payloads cannot be compared, so the job is re-fetched. */
const MIN_COMPARABLE_KEYS = 3

export type ListingVerdict =
  | { verdict: "new" }
  | { verdict: "changed"; changedKeys: string[] }
  | { verdict: "unchanged"; comparedKeys: number }
  | { verdict: "incomparable"; comparedKeys: number }

/** Canonical form so `"760.00"` equals `760`, `4.5e-13` equals `0`, and array/object key order does not matter. */
export function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 100) / 100
    return trimmed
  }
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]))
  }
  return String(value)
}

/**
 * Decide whether a job listed by `job/all` needs a `job/get`, by comparing the listed values
 * against the detail payload stored from the last fetch. Only keys present in BOTH payloads
 * count, so a field one endpoint omits never forces a fetch; too few shared keys does.
 */
export function compareListing(listed: WorkizRawJob, stored: WorkizRawJob | null | undefined): ListingVerdict {
  if (!stored) return { verdict: "new" }
  const changedKeys: string[] = []
  let compared = 0
  for (const key of LISTING_WATCHED_KEYS) {
    if (listed[key] === undefined || stored[key] === undefined) continue
    compared++
    if (JSON.stringify(canonical(listed[key])) !== JSON.stringify(canonical(stored[key]))) changedKeys.push(key)
  }
  if (changedKeys.length) return { verdict: "changed", changedKeys }
  if (compared < MIN_COMPARABLE_KEYS) return { verdict: "incomparable", comparedKeys: compared }
  return { verdict: "unchanged", comparedKeys: compared }
}
