import { sql } from "drizzle-orm"
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const technicianProfiles = pgTable("technician_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  pinHash: text("pin_hash").notNull(),
  nonColorRate: numeric("non_color_rate", { precision: 8, scale: 6 }).notNull(),
  colorRate: numeric("color_rate", { precision: 8, scale: 6 }).notNull(),
  tipShare: numeric("tip_share", { precision: 8, scale: 6 }).notNull(),
  separateColorSeal: boolean("separate_color_seal").notNull().default(true),
  /**
   * Literal text (e.g. "*T*") that, when present in a Workiz line item, assigns
   * that item exclusively to this technician. Null for regular crew members.
   */
  lineItemMarker: text("line_item_marker"),
  /**
   * Workiz Work Type (the job's `JobType`, e.g. "Tim's Job") whose jobs belong
   * wholly to this technician: the entire discounted service subtotal is paid
   * at their rates and the regular crew earns no service commission on it.
   * Compared case-, whitespace- and apostrophe-insensitively. Null for everyone else.
   */
  ownedWorkType: text("owned_work_type"),
  /**
   * Technician this one works every job with. When that technician is on a
   * Workiz job, this profile is added to the job too, even though Workiz never
   * lists them (Denis rides with Vadim). Null for everyone else.
   */
  worksWithProfileId: integer("works_with_profile_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const appSessions = pgTable("app_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  kind: text("kind").notNull(), // "technician" | "admin"
  profileId: integer("profile_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const workizTeamMappings = pgTable("workiz_team_mappings", {
  id: serial("id").primaryKey(),
  workizTeamId: text("workiz_team_id").notNull().unique(),
  workizName: text("workiz_name"),
  workizRole: text("workiz_role"),
  source: text("source").notNull().default("rest"),
  profileId: integer("profile_id"),
  excluded: boolean("excluded").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
})

export const colorSealItems = pgTable("color_seal_items", {
  id: serial("id").primaryKey(),
  productId: text("product_id").notNull().unique(),
  name: text("name"),
  isColorSeal: boolean("is_color_seal").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
})

export const workizJobs = pgTable("workiz_jobs", {
  uuid: text("uuid").primaryKey(),
  serialId: text("serial_id"),
  status: text("status"),
  subStatus: text("sub_status"),
  paymentDueDate: timestamp("payment_due_date", { withTimezone: true }),
  jobDateTime: timestamp("job_date_time", { withTimezone: true }),
  jobEndDateTime: timestamp("job_end_date_time", { withTimezone: true }),
  clientId: text("client_id"),
  clientName: text("client_name"),
  address: text("address"),
  jobType: text("job_type"),
  jobSource: text("job_source"),
  jobTotal: numeric("job_total", { precision: 12, scale: 2 }).notNull().default("0"),
  subTotal: numeric("sub_total", { precision: 12, scale: 2 }),
  taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }),
  discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  colorSealTotal: numeric("color_seal_total", { precision: 12, scale: 2 }).notNull().default("0"),
  cardServiceAmount: numeric("card_service_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  nonCardServiceAmount: numeric("non_card_service_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  cardTipAmount: numeric("card_tip_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  nonCardTipAmount: numeric("non_card_tip_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  totalPaid: numeric("total_paid", { precision: 12, scale: 2 }).notNull().default("0"),
  fullyPaid: boolean("fully_paid").notNull().default(false),
  invoiceStatus: text("invoice_status"),
  teamIds: jsonb("team_ids").$type<string[]>().notNull().default([]),
  teamNames: jsonb("team_names").$type<string[]>().notNull().default([]),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  lineItems: jsonb("line_items").$type<NormalizedLineItem[]>().notNull().default([]),
  payments: jsonb("payments").$type<NormalizedPayment[]>().notNull().default([]),
  raw: jsonb("raw"),
  source: text("source").notNull().default("rest"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const payouts = pgTable(
  "payouts",
  {
    id: serial("id").primaryKey(),
    jobUuid: text("job_uuid").notNull(),
    profileId: integer("profile_id").notNull(),
    workizTeamId: text("workiz_team_id"),
    status: text("status").notNull().default("pending"),
    holdReason: text("hold_reason"),
    jobTotal: numeric("job_total", { precision: 12, scale: 2 }).notNull().default("0"),
    discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    colorSealTotal: numeric("color_seal_total", { precision: 12, scale: 2 }).notNull().default("0"),
    cardServiceAmount: numeric("card_service_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    nonCardServiceAmount: numeric("non_card_service_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    cardTipAmount: numeric("card_tip_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    nonCardTipAmount: numeric("non_card_tip_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    nonColorRate: numeric("non_color_rate", { precision: 8, scale: 6 }).notNull(),
    colorRate: numeric("color_rate", { precision: 8, scale: 6 }).notNull(),
    tipShare: numeric("tip_share", { precision: 8, scale: 6 }).notNull(),
    nonColorPayout: numeric("non_color_payout", { precision: 12, scale: 4 }).notNull().default("0"),
    colorPayout: numeric("color_payout", { precision: 12, scale: 4 }).notNull().default("0"),
    tipPayout: numeric("tip_payout", { precision: 12, scale: 4 }).notNull().default("0"),
    basePayout: numeric("base_payout", { precision: 12, scale: 4 }).notNull().default("0"),
    totalPayout: numeric("total_payout", { precision: 12, scale: 4 }).notNull().default("0"),
    splitCount: integer("split_count").notNull().default(1),
    splitShare: numeric("split_share", { precision: 8, scale: 6 }).notNull().default("1"),
    /** "job" = whole job, "dedicated" = marked items only, "crew" = everything except marked items. */
    segmentKind: text("segment_kind").notNull().default("job"),
    segmentMarker: text("segment_marker"),
    calcMode: text("calc_mode"),
    breakdown: jsonb("breakdown"),
    inputHash: text("input_hash"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: text("paid_by"),
    adminNote: text("admin_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payouts_job_profile_unique").on(t.jobUuid, t.profileId)],
)

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    payoutId: integer("payout_id").notNull(),
    profileId: integer("profile_id").notNull(),
    jobUuid: text("job_uuid").notNull(),
    channel: text("channel").notNull().default("workiz_note"),
    /** previewed | sending | sent | resent | failed */
    status: text("status").notNull().default("previewed"),
    message: text("message").notNull(),
    providerResponse: jsonb("provider_response"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  // One in-flight or completed delivery per payout: the guard against duplicate texts.
  (t) => [uniqueIndex("notifications_payout_delivery_unique").on(t.payoutId).where(sql`${t.status} in ('sending', 'sent')`)],
)

/**
 * Payment records Workiz's job API never returns. `job/get` only reports the balance
 * (`JobAmountDue`); the payment type reaches us either through an invoice webhook
 * (`data.payments[]`) or an admin confirming what the Workiz Payments tab shows.
 * Rows are merged into the job's payments on every sync, so they survive re-fetches.
 */
export const jobPayments = pgTable(
  "job_payments",
  {
    id: serial("id").primaryKey(),
    jobUuid: text("job_uuid").notNull(),
    /** Workiz payment id ("PAY-…") when the record came from Workiz; null for admin confirmations. */
    externalId: text("external_id"),
    /** invoice-webhook | manual */
    source: text("source").notNull(),
    method: text("method").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    tipAmount: numeric("tip_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    invoiceId: text("invoice_id"),
    reference: text("reference"),
    recordedBy: text("recorded_by"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The same Workiz payment delivered twice (webhook retry, two automations) is one row.
  (t) => [uniqueIndex("job_payments_external_unique").on(t.jobUuid, t.externalId).where(sql`${t.externalId} is not null`)],
)

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
})

export const syncEvents = pgTable("sync_events", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  jobUuid: text("job_uuid"),
  ok: boolean("ok").notNull().default(true),
  summary: text("summary"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type NormalizedLineItem = {
  id: string | null
  name: string
  /** Secondary text field from Workiz (Description/Notes) when it differs from the name; searched for technician markers. */
  description?: string | null
  /** Workiz item `Type` ("service", "product", "DISCOUNT_TYPE"). */
  type?: string | null
  quantity: number
  unitPrice: number
  /** Extended amount (unit price x quantity). Negative for discount lines. */
  total: number
  isColorSeal: boolean
  /** True for Workiz discount lines, which arrive with a positive price and `Type: "DISCOUNT_TYPE"`. */
  isDiscount?: boolean
  matchedBy: "catalog" | "keyword" | "none"
}

/** Where a payment record came from. Absent on rows saved before provenance was tracked (all were job payloads). */
export type PaymentSource = "workiz-job" | "invoice-webhook" | "manual"

export type NormalizedPayment = {
  id: string | null
  amount: number
  method: string
  isCard: boolean
  isTip: boolean
  date: string | null
  source?: PaymentSource
  /** False when the method text is not one we can place on the card / non-card side; the payout is held. */
  methodKnown?: boolean
  /** Admin who confirmed a manual record. */
  recordedBy?: string | null
}

export type JobPaymentRow = typeof jobPayments.$inferSelect

export type TechnicianProfile = typeof technicianProfiles.$inferSelect
export type WorkizJobRow = typeof workizJobs.$inferSelect
export type PayoutRow = typeof payouts.$inferSelect
export type NotificationRow = typeof notifications.$inferSelect
export type TeamMappingRow = typeof workizTeamMappings.$inferSelect
export type SyncEventRow = typeof syncEvents.$inferSelect
