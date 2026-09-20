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
}

export type NotificationSettings = {
  /** When false, messages are rendered and stored but never sent anywhere. */
  sendEnabled: boolean
  /** Delivery channel for technician messages. */
  channel: "workiz_note" | "none"
  /** Template with {{placeholders}}; see lib/notifications/template.ts. */
  template: string
}

export type AdminSettings = {
  passwordHash: string | null
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
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  sendEnabled: false,
  channel: "workiz_note",
  template: [
    "Hi {{technician}}, your payout for job #{{jobSerial}} ({{clientName}}) is {{totalPayout}}.",
    "Job total {{jobTotal}}{{segmentLine}}{{discountLine}}{{colorSealLine}}{{tipLine}}.",
    "Base {{basePayout}} + tip {{tipPayout}}. Status: {{status}}.",
  ].join(" "),
}

const KEYS = {
  workiz: "workiz",
  notifications: "notifications",
  admin: "admin",
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
  return readSetting(KEYS.notifications, DEFAULT_NOTIFICATION_SETTINGS)
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
