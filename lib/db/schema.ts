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
    /** Payment batch that currently settles this payout (null while unpaid or after a reversal). */
    batchId: integer("batch_id"),
    /** How the row was settled: "payment" (owner clicked Paid) or "opening" (declared paid before the cutoff). */
    settledKind: text("settled_kind"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payouts_job_profile_unique").on(t.jobUuid, t.profileId)],
)

/**
 * One owner payment to one technician: the selected job payouts settled together with a
 * single "Paid" click, or an opening-balance entry for work the owner declared already paid.
 * `paidAmount`/`method`/`paidOn` describe the REAL transfer and stay null when nobody recorded
 * them; `calculatedTotal` is the sum of the settled payout calculations and is never presented
 * as a verified transfer amount.
 */
export const paymentBatches = pgTable(
  "payment_batches",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id").notNull(),
    /** payment | opening */
    kind: text("kind").notNull().default("payment"),
    /** recorded | reversed */
    status: text("status").notNull().default("recorded"),
    /** Zelle | Cash | Check | Other; null = unknown (opening history). */
    method: text("method"),
    /** Effective payment date in the business timezone (YYYY-MM-DD); null = unknown. */
    paidOn: text("paid_on"),
    /** Amount actually handed to the technician; null = unknown. */
    paidAmount: numeric("paid_amount", { precision: 12, scale: 2 }),
    calculatedTotal: numeric("calculated_total", { precision: 12, scale: 2 }).notNull().default("0"),
    itemCount: integer("item_count").notNull().default(0),
    reference: text("reference"),
    /** Client-generated key so a double tap or retried request records one batch. */
    idempotencyKey: text("idempotency_key"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: text("recorded_by").notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by"),
    reversalReason: text("reversal_reason"),
    details: jsonb("details"),
  },
  (t) => [uniqueIndex("payment_batches_idempotency_unique").on(t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`)],
)

/**
 * One job payout inside a batch, frozen at the moment it was settled. The partial unique
 * index is the duplicate-settlement guard: a payout can be in at most one un-reversed batch,
 * whatever two taps, two tabs or a concurrent sync try to do.
 */
export const payoutSettlements = pgTable(
  "payout_settlements",
  {
    id: serial("id").primaryKey(),
    batchId: integer("batch_id").notNull(),
    payoutId: integer("payout_id").notNull(),
    profileId: integer("profile_id").notNull(),
    jobUuid: text("job_uuid").notNull(),
    /** Rounded amount the owner saw and settled. */
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    /** payouts.total_payout at full stored precision when settled. */
    exactAmount: numeric("exact_amount", { precision: 12, scale: 4 }).notNull(),
    calcVersion: text("calc_version"),
    inputHash: text("input_hash"),
    /** Copy of the payout row (money columns + breakdown) so history never depends on a later recalculation. */
    snapshot: jsonb("snapshot"),
    /** settled | reversed */
    status: text("status").notNull().default("settled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("payout_settlements_active_unique").on(t.payoutId).where(sql`${t.status} = 'settled'`)],
)

/**
 * A settled payout whose Workiz inputs changed afterwards. The settlement is never touched;
 * the owner reviews the difference here.
 */
export const payoutSourceChanges = pgTable(
  "payout_source_changes",
  {
    id: serial("id").primaryKey(),
    payoutId: integer("payout_id").notNull(),
    jobUuid: text("job_uuid").notNull(),
    profileId: integer("profile_id").notNull(),
    settledHash: text("settled_hash"),
    newHash: text("new_hash").notNull(),
    settledAmount: numeric("settled_amount", { precision: 12, scale: 4 }),
    recomputedAmount: numeric("recomputed_amount", { precision: 12, scale: 4 }),
    summary: text("summary"),
    /** open | acknowledged */
    status: text("status").notNull().default("open"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
  },
  (t) => [uniqueIndex("payout_source_changes_hash_unique").on(t.payoutId, t.newHash)],
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
    /**
     * True when `paidAt` came from the Workiz payload itself. Workiz's invoice/estimate
     * webhooks carry no per-payment date, so `paidAt` is usually the time the FIRST event
     * mentioning the payment arrived; a later re-delivery must not move it forward.
     */
    paidAtFromPayload: boolean("paid_at_from_payload").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The same Workiz payment delivered twice (webhook retry, two automations) is one row.
  (t) => [uniqueIndex("job_payments_external_unique").on(t.jobUuid, t.externalId).where(sql`${t.externalId} is not null`)],
)

/**
 * Every webhook Workiz posts, stored before anything is done with it. `eventKey` de-duplicates
 * retries; `status` tracks whether the event could be applied. Estimate/invoice events that
 * name only Workiz's internal job id (JOB-…) wait here as `unresolved` until a job event
 * teaches us that id's UUID, then are replayed.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key").notNull(),
    triggerType: text("trigger_type"),
    ruleName: text("rule_name"),
    /** job | invoice | estimate | self_test | ignored | unknown */
    kind: text("kind").notNull(),
    jobUuid: text("job_uuid"),
    /** Workiz internal job id ("JOB-…") when the payload carried one. */
    jobInternalId: text("job_internal_id"),
    serialId: text("serial_id"),
    /** Invoice or estimate id ("IV-…" / "ES-…") for document events. */
    documentId: text("document_id"),
    payload: jsonb("payload"),
    /** received | processed | unresolved | ignored | failed | duplicate */
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("webhook_events_key_unique").on(t.eventKey)],
)

/**
 * Workiz has two ids per job: the 6-character UUID the REST API and job webhooks use, and an
 * internal "JOB-…" id that invoice and estimate webhooks reference. Job and invoice events carry
 * both, so every one of them teaches the mapping; estimate events (deposits) carry only the
 * internal id and are resolved through this table.
 */
export const workizJobIds = pgTable("workiz_job_ids", {
  internalId: text("internal_id").primaryKey(),
  uuid: text("uuid").notNull(),
  serialId: text("serial_id"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * One row per job: the owner's "payout ready" text. This is the durable outbox the webhook,
 * cron and admin all drive. Delivery goes through Workiz (tag + job description → the owner's
 * Workiz SMS automation), so `provider_accepted` means Workiz confirmed the tag and summary
 * are on the job; `delivered` is only set when the owner confirms receipt — Workiz returns
 * no delivery receipt.
 */
export const ownerNotifications = pgTable(
  "owner_notifications",
  {
    id: serial("id").primaryKey(),
    jobUuid: text("job_uuid").notNull(),
    /** blocked | preview_only | queued | sending | provider_accepted | delivered | failed */
    status: text("status").notNull().default("blocked"),
    blockReason: text("block_reason"),
    /** Fingerprint of the payout set the message describes; a send is refused when it no longer matches. */
    snapshotHash: text("snapshot_hash"),
    /** Fingerprint that was actually delivered, so a later payout change is visible as "sent for an earlier snapshot". */
    sentSnapshotHash: text("sent_snapshot_hash"),
    message: text("message").notNull().default(""),
    channel: text("channel").notNull().default("workiz_tag_sms"),
    destinationLabel: text("destination_label"),
    destinationMasked: text("destination_masked"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    providerResponse: jsonb("provider_response"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredConfirmedBy: text("delivered_confirmed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("owner_notifications_job_unique").on(t.jobUuid)],
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

/**
 * Admin notifications the owner cleared from the bell panel. A row dismisses one underlying
 * record identity (lib/admin/notices.ts builds the keys from the Workiz job id plus the
 * specific issue, never from message text or sync times), so repeated syncs cannot bring a
 * cleared notice back while a genuinely new issue on the same job still gets its own key.
 * Dismissing never changes a payout, a hold, a source change or Workiz.
 */
export const adminNoticeDismissals = pgTable(
  "admin_notice_dismissals",
  {
    id: serial("id").primaryKey(),
    /** Admin account the dismissal belongs to (one shared admin login today). */
    account: text("account").notNull().default("admin"),
    noticeKey: text("notice_key").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
    dismissedBy: text("dismissed_by").notNull().default("admin"),
  },
  (t) => [uniqueIndex("admin_notice_dismissals_unique").on(t.account, t.noticeKey)],
)

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
export type PaymentSource = "workiz-job" | "invoice-webhook" | "estimate-webhook" | "manual"

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
  /** True when Workiz did not make clear whether this payment's amount included its tip; the payout is held. */
  tipAmbiguous?: boolean
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
export type WebhookEventRow = typeof webhookEvents.$inferSelect
export type OwnerNotificationRow = typeof ownerNotifications.$inferSelect
export type PaymentBatchRow = typeof paymentBatches.$inferSelect
export type PayoutSettlementRow = typeof payoutSettlements.$inferSelect
export type PayoutSourceChangeRow = typeof payoutSourceChanges.$inferSelect
