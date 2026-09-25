import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { appSettings } from "@/lib/db/schema"

export type WorkizSettings = {
  /** Workiz API token (the `{token}` path segment). */
  apiToken: string
  /** Workiz API secret, sent as the `api_secret` header on write calls. */
  apiSecret: string
  /** Shared secret the Workiz webhook automation must send as a Bearer token. */
  webhookSecret: string
  /** Workiz job status names that mean "job is finished and payable". */
  payableStatuses: string[]
  /** Case-insensitive keywords that flag a line item as color sealing. */
  colorSealKeywords: string[]
  /** Payment method names that are treated as card payments. */
  cardMethodKeywords: string[]
  /** Product/service names that are treated as tips when Workiz has no dedicated tip field. */
  tipKeywords: string[]
  /**
   * Days to look back on cron reconciliation. Workiz's `job/all?start_date` filters on the
   * scheduled JobDateTime, not on the last change, so the window must be wide enough to
   * still see a job that was scheduled weeks ago and only paid today.
   */
  reconcileLookbackDays: number
  /** IANA timezone used to display job, completion and payment dates. */
  businessTimezone: string
  /**
   * When true, a job gets `payoutReadyTag` added in Workiz the first time it has a payout in
   * status "ready". A Workiz automation on that tag is what texts the admin. See lib/workiz/tags.ts.
   */
  payoutReadyTagEnabled: boolean
  /** Exact name of an existing Workiz job tag; the API silently drops unknown tag names. */
  payoutReadyTag: string
}

/**
 * Who the owner "payout ready" text goes to. The SMS itself is sent by the owner's Workiz
 * automation ("tag added → send text to team member"), so this records WHICH Workiz team
 * member that automation targets — for diagnostics and the masked display — it does not
 * address the message. Missing = configuration blocker.
 */
export type OwnerRecipient = {
  workizTeamId: string
  name: string
  /** Last digits of the Workiz team member's phone, e.g. "•••• 1234"; never the full number. */
  phoneMasked: string | null
}

export type NotificationSettings = {
  ownerRecipient: OwnerRecipient | null
}

export type AdminSettings = {
  passwordHash: string | null
}

/**
 * Owner payout bookkeeping. `openingCutoffAt` is the owner's "everything up to here was
 * already paid" declaration; it is set once by the initialization and never moves with a
 * deployment or a sync.
 */
export type PayoutSettings = {
  /** First business day the app is responsible for (YYYY-MM-DD in the business timezone). */
  historyStartDate: string
  /** ISO instant of the owner's all-paid declaration; null until the one-time initialization ran. */
  openingCutoffAt: string | null
  openingInitializedAt: string | null
  openingInitializedBy: string | null
  /** Opening-balance batches the initialization created, one per technician. */
  openingBatchIds: number[]
}

export const DEFAULT_PAYOUT_SETTINGS: PayoutSettings = {
  historyStartDate: "2026-09-01",
  openingCutoffAt: null,
  openingInitializedAt: null,
  openingInitializedBy: null,
  openingBatchIds: [],
}

export const DEFAULT_WORKIZ_SETTINGS: WorkizSettings = {
  apiToken: "",
  apiSecret: "",
  webhookSecret: "",
  payableStatuses: ["Done", "Completed", "Paid"],
  colorSealKeywords: ["color seal", "colour seal", "color-seal", "colorseal", "color sealing"],
  cardMethodKeywords: ["credit", "card", "visa", "mastercard", "amex", "discover", "stripe", "cc"],
  tipKeywords: ["tip", "gratuity"],
  reconcileLookbackDays: 60,
  businessTimezone: "America/New_York",
  payoutReadyTagEnabled: false,
  payoutReadyTag: "Payout Ready",
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  ownerRecipient: null,
}

/** "•••• 1234" from any phone formatting; null when there is nothing to mask. */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "")
  if (digits.length < 4) return null
  return `•••• ${digits.slice(-4)}`
}

const KEYS = {
  workiz: "workiz",
  notifications: "notifications",
  admin: "admin",
  payout: "payout",
} as const

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1)
  const row = rows[0]
  if (!row) return fallback
  return { ...fallback, ...(row.value as Partial<T>) }
}

async function writeSetting<T>(key: string, value: T, updatedBy: string | null): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value: value as object, updatedBy })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: value as object, updatedAt: new Date(), updatedBy },
    })
}

export async function getWorkizSettings(): Promise<WorkizSettings> {
  return readSetting(KEYS.workiz, DEFAULT_WORKIZ_SETTINGS)
}

export async function saveWorkizSettings(patch: Partial<WorkizSettings>, updatedBy: string | null) {
  const current = await getWorkizSettings()
  const next = { ...current, ...patch }
  await writeSetting(KEYS.workiz, next, updatedBy)
  return next
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const stored = await readSetting<NotificationSettings & Record<string, unknown>>(KEYS.notifications, DEFAULT_NOTIFICATION_SETTINGS)
  const r = stored.ownerRecipient as Partial<OwnerRecipient> | null | undefined
  // Rows saved by the retired technician-message feature carry template/channel keys; only the recipient matters now.
  return {
    ownerRecipient: r && typeof r.workizTeamId === "string" && r.workizTeamId && typeof r.name === "string" ? { workizTeamId: r.workizTeamId, name: r.name, phoneMasked: typeof r.phoneMasked === "string" ? r.phoneMasked : null } : null,
  }
}

export async function saveNotificationSettings(patch: Partial<NotificationSettings>, updatedBy: string | null) {
  const current = await getNotificationSettings()
  const next = { ...current, ...patch }
  await writeSetting(KEYS.notifications, next, updatedBy)
  return next
}

export async function getAdminSettings(): Promise<AdminSettings> {
  return readSetting(KEYS.admin, { passwordHash: null })
}

export async function saveAdminSettings(patch: Partial<AdminSettings>, updatedBy: string | null) {
  const current = await getAdminSettings()
  const next = { ...current, ...patch }
  await writeSetting(KEYS.admin, next, updatedBy)
  return next
}

export async function getPayoutSettings(): Promise<PayoutSettings> {
  return readSetting(KEYS.payout, DEFAULT_PAYOUT_SETTINGS)
}

export async function savePayoutSettings(patch: Partial<PayoutSettings>, updatedBy: string | null) {
  const current = await getPayoutSettings()
  const next = { ...current, ...patch }
  await writeSetting(KEYS.payout, next, updatedBy)
  return next
}

/** Redacts secrets so settings can be safely rendered in the admin UI. */
export function redactWorkizSettings(s: WorkizSettings) {
  return {
    ...s,
    apiToken: s.apiToken ? mask(s.apiToken) : "",
    apiSecret: s.apiSecret ? mask(s.apiSecret) : "",
    webhookSecret: s.webhookSecret ? mask(s.webhookSecret) : "",
    hasApiToken: Boolean(s.apiToken),
    hasApiSecret: Boolean(s.apiSecret),
    hasWebhookSecret: Boolean(s.webhookSecret),
  }
}

function mask(value: string) {
  if (value.length <= 6) return "••••••"
  return `${value.slice(0, 3)}••••${value.slice(-3)}`
}
