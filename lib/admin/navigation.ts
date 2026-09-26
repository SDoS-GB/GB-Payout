/**
 * Admin pages are one route (/admin) with the current page in the query string, so direct
 * links, bookmarks and the browser Back button all work while the data loaded once by the
 * server is shared across pages. Pure helpers only: both the server page and the client shell
 * parse the same way.
 */

export const ADMIN_VIEWS = ["due", "history", "payouts", "review", "waiting", "settings"] as const
export type AdminView = (typeof ADMIN_VIEWS)[number]

export const SETTINGS_SECTIONS = ["team", "technicians", "workiz", "sync", "activity", "opening"] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const ADMIN_VIEW_LABELS: Record<AdminView, string> = {
  due: "Due",
  history: "Paid history",
  payouts: "All payouts",
  review: "Review",
  waiting: "Waiting",
  settings: "Settings",
}

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  team: "Team mapping",
  technicians: "Technicians",
  workiz: "Workiz connection",
  sync: "Sync schedule",
  activity: "Activity",
  opening: "Opening balance",
}

export type AdminLocation = {
  view: AdminView
  /** Only meaningful when view is "settings". */
  section: SettingsSection
  /** Paid-history payment to expand and scroll to. */
  batchId: number | null
  /** Technician whose Due card should be brought into view. */
  techId: number | null
  /** Team-mapping list filter. */
  teamFilter: "all" | "unmapped"
}

export const DEFAULT_ADMIN_LOCATION: AdminLocation = { view: "due", section: "team", batchId: null, techId: null, teamFilter: "all" }

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined

function read(params: ParamSource, key: string): string | null {
  if (!params) return null
  if (params instanceof URLSearchParams) return params.get(key)
  const v = params[key]
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

const positiveInt = (v: string | null): number | null => {
  if (!v || !/^\d{1,12}$/.test(v)) return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Unknown or malformed values fall back to the default, so an old bookmark never breaks the page. */
export function parseAdminLocation(params: ParamSource): AdminLocation {
  const rawView = read(params, "view")
  const view = (ADMIN_VIEWS as readonly string[]).includes(rawView ?? "") ? (rawView as AdminView) : DEFAULT_ADMIN_LOCATION.view
  const rawSection = read(params, "section")
  const section = (SETTINGS_SECTIONS as readonly string[]).includes(rawSection ?? "") ? (rawSection as SettingsSection) : DEFAULT_ADMIN_LOCATION.section
  const teamFilter = read(params, "team") === "unmapped" ? "unmapped" : "all"
  return { view, section, batchId: positiveInt(read(params, "batch")), techId: positiveInt(read(params, "tech")), teamFilter }
}

/** The shortest URL that reproduces the location: plain "/admin" is Due. */
export function adminHref(loc: Partial<AdminLocation>): string {
  const full: AdminLocation = { ...DEFAULT_ADMIN_LOCATION, ...loc }
  const q = new URLSearchParams()
  if (full.view !== "due") q.set("view", full.view)
  if (full.view === "settings" && full.section !== DEFAULT_ADMIN_LOCATION.section) q.set("section", full.section)
  if (full.view === "settings" && full.section === "team" && full.teamFilter === "unmapped") q.set("team", "unmapped")
  if (full.view === "history" && full.batchId) q.set("batch", String(full.batchId))
  if (full.view === "due" && full.techId) q.set("tech", String(full.techId))
  const s = q.toString()
  return s ? `/admin?${s}` : "/admin"
}

/** Page title shown in the top bar. */
export function adminPageTitle(loc: AdminLocation): string {
  return ADMIN_VIEW_LABELS[loc.view]
}
