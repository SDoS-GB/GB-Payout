/**
 * Admin notifications for the bell in the top bar: what needs the owner's attention, grouped
 * per Workiz job, with a durable identity per underlying issue so a cleared notice stays
 * cleared across syncs, reloads and devices while a genuinely new issue still shows up.
 *
 * Pure module: no database, no React. Both the server action (to build the list) and the
 * bell (to hide cleared notices optimistically) use the same functions.
 *
 * Identity rules
 * - A held payout: `hold:<jobUuid>:<issueKey>`. The issue key is the hold reason's category
 *   (e.g. "payment-method-unknown") with amounts, quoted values and free text removed, so a
 *   re-sync that rewrites the message keeps the same key, while a different problem on the
 *   same job gets a new one. Two technicians held on one job for the same reason share the key.
 * - A paid job that changed in Workiz: `change:<jobUuid>:<newHash>`. The engine records one
 *   source-change row per new input fingerprint, so a later, distinct change is a new key and
 *   duplicate webhooks or routine syncs are not.
 * - An unmapped Workiz team member: `unmapped:<workizTeamId>`.
 * - The opening balance: a single constant key.
 */

import type { AdminLocation } from "./navigation"

export const NOTICE_ACCOUNT = "admin"
export const OPENING_BALANCE_NOTICE_KEY = "opening-balance-missing"
export const MAX_NOTICE_KEYS_PER_CLEAR = 2000

export type NoticeKind = "source-change" | "hold" | "unmapped" | "opening-balance"

export type AdminNoticeAction =
  | { kind: "navigate"; loc: Partial<AdminLocation> }
  /** Open the Review page filtered to this job (its held payouts open from there). */
  | { kind: "review-job"; search: string }

export type AdminNotice = {
  /** Stable id of the grouped notification; also the React key. */
  id: string
  kind: NoticeKind
  /** Short category shown above the title, e.g. "Needs your call". */
  category: string
  title: string
  detail: string | null
  /** Underlying record identities still uncleared; CLEAR dismisses all of them. */
  keys: string[]
  action: AdminNoticeAction
  actionLabel: string
  /** Most recent underlying event as ISO, for ordering and display only — never part of identity. */
  at: string | null
}

export type HeldPayoutInput = {
  payoutId: number
  jobUuid: string
  serialId: string | null
  clientName: string | null
  profileName: string
  holdReason: string | null
  updatedAt: Date | string | null
}

export type SourceChangeInput = {
  jobUuid: string
  serialId: string | null
  clientName: string | null
  profileName: string
  newHash: string
  settledAmount: number | null
  recomputedAmount: number | null
  detectedAt: Date | string
}

export type UnmappedInput = { workizTeamId: string; workizName: string | null }

export type NoticeInputs = {
  holds: HeldPayoutInput[]
  sourceChanges: SourceChangeInput[]
  unmapped: UnmappedInput[]
  openingMissing: boolean
}

const NOTHING_OWED = /nothing is owed on this row/i

/** The hold reason's category as a stable slug: text before the first punctuation, minus quotes and numbers. */
export function holdIssueKey(reason: string | null | undefined): string {
  const text = (reason ?? "").trim()
  if (!text) return "on-hold"
  if (NOTHING_OWED.test(text)) return "nothing-owed"
  const slug = holdIssueHead(text)
    .replace(/"[^"]*"/g, "")
    .replace(/\$?\d[\d,.]*/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (slug || "on-hold").slice(0, 60)
}

/** Human-readable version of the same category, for the notice text. */
export function holdIssueLabel(reason: string | null | undefined): string {
  const text = (reason ?? "").trim()
  if (!text) return "On hold"
  if (NOTHING_OWED.test(text)) return "Nothing is owed on this row"
  const head = holdIssueHead(text).replace(/\s+/g, " ").trim()
  return head || "On hold"
}

function holdIssueHead(text: string): string {
  return text.split(/[:(;—\n]|\.\s|\s-\s/)[0] ?? text
}

export const holdNoticeKey = (jobUuid: string, holdReason: string | null | undefined) => `hold:${jobUuid}:${holdIssueKey(holdReason)}`
export const sourceChangeNoticeKey = (jobUuid: string, newHash: string) => `change:${jobUuid}:${newHash}`
export const unmappedNoticeKey = (workizTeamId: string) => `unmapped:${workizTeamId}`

const KEY_PATTERN = /^(hold|change|unmapped):[A-Za-z0-9._:-]{1,180}$/

/** Only keys this module can produce are accepted by the server, so nothing arbitrary is stored. */
export function isValidNoticeKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= 200 && (key === OPENING_BALANCE_NOTICE_KEY || KEY_PATTERN.test(key))
}

/** Keys of every notice in a presented set, de-duplicated — what CLEAR sends to the server. */
export function keysOf(notices: readonly AdminNotice[]): string[] {
  return Array.from(new Set(notices.flatMap((n) => n.keys)))
}

/** Notices with at least one key outside `dismissed`, each trimmed to its uncleared keys. */
export function withoutDismissed(notices: readonly AdminNotice[], dismissed: ReadonlySet<string>): AdminNotice[] {
  const out: AdminNotice[] = []
  for (const n of notices) {
    const keys = n.keys.filter((k) => !dismissed.has(k))
    if (keys.length) out.push(keys.length === n.keys.length ? n : { ...n, keys })
  }
  return out
}

const usd = (v: number | null | undefined) => {
  const n = Number(v ?? 0)
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `−$${abs}` : `$${abs}`
}

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const date = typeof d === "string" ? new Date(d) : d
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b)

const jobTitle = (clientName: string | null, serialId: string | null) => `${clientName?.trim() || "Unknown customer"} · Job #${serialId ?? "—"}`

const names = (list: Iterable<string>) => Array.from(new Set(list)).sort((a, b) => a.localeCompare(b))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * Build the visible notifications from the current facts and the owner's dismissals. Grouped
 * per job so a shared job is one notice naming every affected technician; ordered so paid-job
 * changes and setup items come before the (possibly long) list of holds.
 */
export function buildAdminNotices(input: NoticeInputs, dismissed: ReadonlySet<string> = new Set()): AdminNotice[] {
  const out: AdminNotice[] = []

  // Paid jobs that changed afterwards: one per job, keyed by each recorded fingerprint.
  const changesByJob = new Map<string, SourceChangeInput[]>()
  for (const c of input.sourceChanges) {
    if (dismissed.has(sourceChangeNoticeKey(c.jobUuid, c.newHash))) continue
    const list = changesByJob.get(c.jobUuid) ?? []
    list.push(c)
    changesByJob.set(c.jobUuid, list)
  }
  const changeNotices: AdminNotice[] = []
  for (const [jobUuid, rows] of changesByJob) {
    const first = rows[0]
    const techs = names(rows.map((r) => r.profileName))
    const single = rows.length === 1 && first.settledAmount != null && first.recomputedAmount != null
    changeNotices.push({
      id: `change:${jobUuid}`,
      kind: "source-change",
      category: "Paid job changed in Workiz",
      title: jobTitle(first.clientName, first.serialId),
      detail: single ? `${techs.join(", ")} · paid ${usd(first.settledAmount)}, Workiz now computes ${usd(first.recomputedAmount)}` : `${techs.join(", ")} · the paid amounts may differ now`,
      keys: Array.from(new Set(rows.map((r) => sourceChangeNoticeKey(r.jobUuid, r.newHash)))),
      action: { kind: "navigate", loc: { view: "review" } },
      actionLabel: "Open Review",
      at: rows.map((r) => iso(r.detectedAt)).reduce<string | null>(later, null),
    })
  }
  changeNotices.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
  out.push(...changeNotices)

  // Setup items: each unmapped person is its own record inside one notice.
  const unmapped = input.unmapped.filter((u) => !dismissed.has(unmappedNoticeKey(u.workizTeamId)))
  if (unmapped.length) {
    const who = unmapped.map((u) => u.workizName?.trim() || `Workiz team #${u.workizTeamId}`)
    out.push({
      id: "unmapped",
      kind: "unmapped",
      category: "Team mapping",
      title: `${plural(unmapped.length, "Workiz team member")} not mapped to a technician`,
      detail: `${who.join(", ")} — their jobs cannot pay until they are matched to a profile.`,
      keys: unmapped.map((u) => unmappedNoticeKey(u.workizTeamId)),
      action: { kind: "navigate", loc: { view: "settings", section: "team", teamFilter: "unmapped" } },
      actionLabel: "Open Team mapping",
      at: null,
    })
  }

  if (input.openingMissing && !dismissed.has(OPENING_BALANCE_NOTICE_KEY)) {
    out.push({
      id: OPENING_BALANCE_NOTICE_KEY,
      kind: "opening-balance",
      category: "Opening balance",
      title: "Opening balance not recorded",
      detail: "Tell the app which work was already paid before it started, so older jobs are not shown as owed.",
      keys: [OPENING_BALANCE_NOTICE_KEY],
      action: { kind: "navigate", loc: { view: "settings", section: "opening" } },
      actionLabel: "Open Opening balance",
      at: null,
    })
  }

  // Held payouts: one notice per job and issue, naming every technician held for it.
  const holdsByKey = new Map<string, HeldPayoutInput[]>()
  for (const h of input.holds) {
    const key = holdNoticeKey(h.jobUuid, h.holdReason)
    if (dismissed.has(key)) continue
    const list = holdsByKey.get(key) ?? []
    list.push(h)
    holdsByKey.set(key, list)
  }
  const holdNotices: AdminNotice[] = []
  for (const [key, rows] of holdsByKey) {
    const first = rows[0]
    const techs = names(rows.map((r) => r.profileName))
    holdNotices.push({
      id: key,
      kind: "hold",
      category: "Needs your call",
      title: jobTitle(first.clientName, first.serialId),
      detail: `${techs.join(", ")} · ${holdIssueLabel(first.holdReason)}`,
      keys: [key],
      action: { kind: "review-job", search: first.serialId ?? first.jobUuid },
      actionLabel: "Review this job",
      at: rows.map((r) => iso(r.updatedAt)).reduce<string | null>(later, null),
    })
  }
  holdNotices.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.title.localeCompare(b.title))
  out.push(...holdNotices)

  return out
}
