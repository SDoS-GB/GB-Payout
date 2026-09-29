import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"
import { testDatabase as db, testPostgres, initializeTestDatabase, resetTestDatabase } from "./helpers/payout-database"
import { appSettings, jobPayments, ownerNotificationAttempts, ownerNotifications, payouts, technicianProfiles, webhookEvents, workizJobs, workizTeamMappings } from "@/lib/db/schema"
import { DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_WORKIZ_SETTINGS, type NotificationSettings } from "@/lib/settings"
import { WorkizClient, type WorkizRawJob } from "@/lib/workiz/client"
import { processRawJob, syncDocumentWebhook } from "@/lib/workiz/sync"
import { persistPayments, paymentEvidence } from "@/lib/workiz/payment-store"
import { claimWebhookEvent, pendingWebhookEvents, rememberJobIds, storeWebhookEvent, unprocessedEventsForJob, WEBHOOK_MAX_ATTEMPTS } from "@/lib/workiz/events"
import { drainWebhookEvents } from "@/lib/workiz/event-worker"
import { parseWebhookBody } from "@/lib/workiz/webhook"
import { claimOwnerNotification, drainOwnerNotifications, reconcileOwnerDelivery, refreshOwnerOutbox, sendOwnerNotification } from "@/lib/notifications/owner-worker"
import { OWNER_MAX_ATTEMPTS } from "@/lib/notifications/owner-status"
import type { ExternalPaymentInput } from "@/lib/workiz/payments"

vi.mock("@/lib/db", async () => ({ db: (await import("./helpers/payout-database")).testDatabase }))

const uuid = "TEST760"
const workiz = { ...DEFAULT_WORKIZ_SETTINGS, apiToken: "test-only-token", apiSecret: "test-only-secret" }
const owner: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ownerRecipient: { workizTeamId: "owner-test", name: "Test owner", phoneMasked: "•••• 1234" }, automationConfirmedAt: "2026-09-01T00:00:00Z", automationRuleName: "Test owner rule" }
const readyJob = (overrides: WorkizRawJob = {}): WorkizRawJob => ({
  UUID: uuid, SerialId: "924878-test", Status: "Done", JobType: "Work", FirstName: "Test", LastName: "Customer",
  LastStatusUpdate: "2026-09-23 14:05:32", JobDateTime: "2026-08-01 10:00:00", SubTotal: 760, JobTotalPrice: 760, JobAmountDue: 0,
  Team: [{ id: "tech-arthur", Name: "Arthur" }, { id: "tech-viktor", Name: "Viktor" }], Tags: [],
  LineItems: [{ Name: "Regular cleaning", Price: 575, Quantity: 1, Type: "service" }, { Name: "Color sealing", Price: 185, Quantity: 1, Type: "service" }], ...overrides,
})
const payment = (id: string, amount: number, method: string, overrides: Partial<ExternalPaymentInput> = {}): ExternalPaymentInput => ({ externalId: id, source: "invoice-webhook", method, amount, tipAmount: 0, paidAt: "2026-09-23T18:00:00Z", paidAtFromPayload: true, sourceUpdatedAt: "2026-09-23T18:00:00Z", paymentState: "active", invoiceId: "IV-TEST", reference: null, recordedBy: null, raw: {}, ...overrides })
const deposit = () => payment("PAY-DEPOSIT", 172.5, "Credit", { source: "estimate-webhook", invoiceId: "ES-TEST", paidAt: "2026-09-15T14:00:00Z", sourceUpdatedAt: "2026-09-15T14:00:00Z" })
const final = (method = "Check") => payment("PAY-FINAL", 587.5, method)
const rows = () => db.select().from(payouts).orderBy(payouts.id)
const notification = async () => (await db.select().from(ownerNotifications).where(eq(ownerNotifications.jobUuid, uuid)))[0]
const process = (raw = readyJob(), settings = owner, options = {}) => processRawJob(raw, "webhook", { settings: workiz, catalog: new Map(), openingCutoff: null, owner: settings, ...options })

beforeAll(initializeTestDatabase, 30_000)
afterAll(() => testPostgres.close())
beforeEach(async () => {
  await resetTestDatabase()
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Live provider requests are forbidden in automated tests")))
  vi.stubEnv("VERCEL_ENV", "preview")
  await db.insert(appSettings).values([{ key: "workiz", value: workiz }, { key: "notifications", value: owner }])
  await db.insert(technicianProfiles).values([
    { id: 3, name: "Arthur", pinHash: "unused-test-hash", nonColorRate: "0.20", colorRate: "0.25", tipShare: "0.5" },
    { id: 4, name: "Viktor", pinHash: "unused-test-hash", nonColorRate: "0.20", colorRate: "0.25", tipShare: "0.5" },
  ])
  await db.insert(workizTeamMappings).values([{ workizTeamId: "tech-arthur", profileId: 3 }, { workizTeamId: "tech-viktor", profileId: 4 }])
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("durable payment history and normal payout processing", () => {
  it.each(["payment-first", "completion-first"])("handles %s without losing the September 15 deposit", async (order) => {
    if (order === "completion-first") {
      await process()
      expect((await rows()).every((p) => p.status === "hold")).toBe(true)
    }
    await persistPayments(uuid, [deposit()], { tipInclusion: "separate" })
    if (order === "payment-first") {
      await process(readyJob({ Status: "In progress", JobAmountDue: 587.5, LastStatusUpdate: "2026-09-15 10:00:00" }))
      expect((await rows()).every((p) => p.status === "pending")).toBe(true)
    }
    await persistPayments(uuid, [final()], { tipInclusion: "separate" })
    await process()
    const saved = await rows()
    expect(saved.map((p) => p.status)).toEqual(["ready", "ready"])
    expect(saved.map((p) => Number(p.totalPayout).toFixed(2))).toEqual(["159.97", "159.97"])
    expect(saved.every((p) => p.paidAt === null)).toBe(true)
    const [oldDeposit] = await db.select().from(jobPayments).where(eq(jobPayments.externalId, "PAY-DEPOSIT"))
    expect(oldDeposit.paidAt?.toISOString()).toBe("2026-09-15T14:00:00.000Z")
    expect(await notification()).toMatchObject({ status: "preview_only", attempts: 0, sentAt: null, deliveredAt: null })
  })

  it.each(["Check", "Cash", "Zelle"])("captures manually recorded %s payments from a provider document event", async (method) => {
    vi.spyOn(WorkizClient.prototype, "getJob").mockResolvedValue(readyJob())
    await persistPayments(uuid, [deposit()], { tipInclusion: "separate" })
    const parsed = parseWebhookBody({ trigger: { type: "invoice_paid", timestamp: "2026-09-23T18:05:32Z" }, data: { id: "IV-TEST", uuid, jobId: "JOB-TEST760", serialId: "invoice-number-not-job", totalPrice: 760, amountDue: 0, payments: [{ id: "PAY-FINAL", type: method, amount: 587.5, tipAmount: 0 }] } })
    expect(await syncDocumentWebhook({ parsed, via: "isolated test" })).toMatchObject({ resolved: true, stored: 1 })
    expect((await rows()).map((p) => Number(p.totalPayout).toFixed(2))).toEqual(["159.97", "159.97"])
    expect((await db.select().from(workizJobs))[0].serialId).toBe("924878-test")
  })

  it("keeps a partial payment hold until the delayed final record arrives", async () => {
    await persistPayments(uuid, [deposit()])
    await process()
    expect((await rows()).every((p) => p.status === "hold" && p.holdReason?.includes("remaining"))).toBe(true)
    expect((await notification()).message).toBe("")
    await persistPayments(uuid, [final()])
    const result = await process()
    expect(result.engine.updated).toBe(2)
    expect((await notification()).message).toContain("Viktor: $159.97")
  })

  it("applies a card tip fee once and splits tips only after the fee", async () => {
    await persistPayments(uuid, [payment("PAY-WITH-TIP", 800, "Credit", { tipAmount: 40 })], { tipInclusion: "included" })
    await process(readyJob({ JobTotalPrice: 800 }))
    expect((await rows()).map((p) => Number(p.totalPayout).toFixed(2))).toEqual(["174.91", "174.91"])
    expect((await rows()).map((p) => Number(p.tipPayout))).toEqual([19.3, 19.3])
  })

  it("deduplicates a stable payment ID across sources and preserves a known deposit date", async () => {
    await persistPayments(uuid, [deposit()])
    await persistPayments(uuid, [{ ...deposit(), source: "invoice-webhook", invoiceId: "IV-TEST", paidAt: null, paidAtFromPayload: false }])
    const saved = await db.select().from(jobPayments)
    expect(saved).toHaveLength(1)
    expect(saved[0].paidAt?.toISOString()).toBe("2026-09-15T14:00:00.000Z")
    expect((await paymentEvidence(uuid, workiz)).payments.map((p) => p.amount)).toEqual([172.5])
  })

  it("does not erase payment history when a job summary omits or empties its payment array", async () => {
    await persistPayments(uuid, [deposit(), final()])
    await process()
    await process({ UUID: uuid, Status: "Done", JobAmountDue: 0, Payments: [] })
    expect(await db.select().from(jobPayments)).toHaveLength(2)
    expect((await rows()).every((p) => p.status === "ready")).toBe(true)
  })

  it("ignores a stale summary while keeping current payment evidence", async () => {
    await persistPayments(uuid, [deposit(), final()])
    await process()
    await process(readyJob({ Status: "In progress", JobAmountDue: 587.5, LastStatusUpdate: "2026-09-15 10:00:00" }))
    expect((await db.select().from(workizJobs))[0]).toMatchObject({ status: "Done", fullyPaid: true })
    expect((await rows()).every((p) => p.status === "ready")).toBe(true)
  })

  it("retains a newer refund and rejects a stale attempt to resurrect the payment", async () => {
    await persistPayments(uuid, [deposit(), final()])
    await persistPayments(uuid, [{ ...deposit(), paymentState: "refunded", sourceUpdatedAt: "2026-09-24T12:00:00Z" }])
    const stale = await persistPayments(uuid, [deposit()])
    expect(stale.stale).toBe(1)
    await process()
    expect((await rows()).every((p) => p.status === "hold")).toBe(true)
    expect((await db.select().from(jobPayments).where(eq(jobPayments.externalId, "PAY-DEPOSIT")))[0].paymentState).toBe("refunded")
  })

  it("holds conflicting unversioned payment changes instead of assuming non-card", async () => {
    await persistPayments(uuid, [deposit(), final()])
    const result = await persistPayments(uuid, [{ ...deposit(), method: "Cash", sourceUpdatedAt: null }])
    expect(result.conflicts).toBe(1)
    await process()
    expect((await rows()).every((p) => p.status === "hold" && p.holdReason?.includes("conflict"))).toBe(true)
  })

  it("retains but holds a payment omitted by a newer document payment list", async () => {
    await persistPayments(uuid, [final()])
    await persistPayments(uuid, [], { documentSnapshot: { id: "IV-TEST", updatedAt: "2026-09-24T12:00:00Z" } })
    const [saved] = await db.select().from(jobPayments)
    expect(saved).toMatchObject({ externalId: "PAY-FINAL", amount: "587.50", paymentState: "review" })
    expect((await paymentEvidence(uuid, workiz)).issues.join(" ")).toMatch(/absent from a newer/)
  })

  it("rejects payments lacking a stable ID and cross-job ID collisions", async () => {
    await expect(persistPayments(uuid, [{ ...deposit(), externalId: null }])).rejects.toThrow(/stable/)
    await persistPayments(uuid, [deposit()])
    await expect(persistPayments("OTHERJOB", [deposit()])).rejects.toThrow(/different job/)
    expect(await db.select().from(jobPayments)).toHaveLength(1)
  })

  it.each(["paid", "void"])("does not rewrite %s payout history when new payment evidence arrives", async (status) => {
    await process()
    await db.update(payouts).set({ status, totalPayout: "161.2500" })
    const before = await rows()
    await persistPayments(uuid, [deposit(), final()])
    await process()
    const after = await rows()
    expect(after.map((p) => [p.id, p.status, p.totalPayout, p.inputHash])).toEqual(before.map((p) => [p.id, p.status, p.totalPayout, p.inputHash]))
    expect((await notification()).status).toBe("blocked")
  })
})

describe("durable webhook leases, identity, and delayed mapping", () => {
  const jobEvent = () => ({ trigger: { type: "job_status_changed", timestamp: "2026-09-23T18:05:32Z" }, data: { id: "JOB-TEST760", uuid, serialId: "924878-test", status: "Done" } })
  const estimateEvent = () => ({ trigger: { type: "estimate_paid", timestamp: "2026-09-15T14:00:00Z" }, data: { id: "ES-TEST", jobId: "JOB-TEST760", serialId: "estimate-number", totalPrice: 760, amountDue: 587.5, payments: [{ id: "PAY-DEPOSIT", amount: 172.5, type: "Credit", tipAmount: 0 }] } })

  it("stores duplicate events once and prevents two workers from claiming them", async () => {
    const payload = jobEvent()
    const parsed = parseWebhookBody(payload)
    const [a, b] = await Promise.all([storeWebhookEvent(parsed, payload, uuid), storeWebhookEvent(parsed, payload, uuid)])
    expect(a.row.id).toBe(b.row.id)
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    const claims = await Promise.all([claimWebhookEvent(a.row.id), claimWebhookEvent(a.row.id)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await db.select().from(webhookEvents)).toHaveLength(1)
  })

  it("parks an older deposit before the JOB-ID mapping, then replays it when completion teaches the UUID", async () => {
    const getJob = vi.spyOn(WorkizClient.prototype, "getJob").mockResolvedValue(readyJob())
    const estimate = estimateEvent()
    const stored = await storeWebhookEvent(parseWebhookBody(estimate), estimate, null)
    expect(await drainWebhookEvents({ limit: 1 })).toMatchObject({ stillUnresolved: 1 })
    expect(getJob).not.toHaveBeenCalled()
    expect((await db.select().from(webhookEvents))[0]).toMatchObject({ status: "unresolved", attempts: 0 })
    const completed = jobEvent()
    await storeWebhookEvent(parseWebhookBody(completed), completed, uuid)
    expect(await drainWebhookEvents({ limit: 2 })).toMatchObject({ resolved: 2 })
    expect((await db.select().from(webhookEvents).where(eq(webhookEvents.id, stored.row.id)))[0].status).toBe("processed")
    expect((await db.select().from(jobPayments))[0]).toMatchObject({ externalId: "PAY-DEPOSIT", jobUuid: uuid, amount: "172.50" })
    expect((await rows()).every((p) => p.status === "hold")).toBe(true)
    await persistPayments(uuid, [final()])
    await process()
    expect((await rows()).every((p) => p.status === "ready")).toBe(true)
  })

  it("persists a mapped deposit even if job/get fails, then schedules a bounded retry", async () => {
    await rememberJobIds({ internalId: "JOB-TEST760", uuid })
    vi.spyOn(WorkizClient.prototype, "getJob").mockRejectedValue(new TypeError("Temporary provider failure"))
    const event = estimateEvent()
    await storeWebhookEvent(parseWebhookBody(event), event, null)
    expect(await drainWebhookEvents({ limit: 1 })).toMatchObject({ failed: 1 })
    expect(await db.select().from(jobPayments)).toHaveLength(1)
    const [saved] = await db.select().from(webhookEvents)
    expect(saved).toMatchObject({ status: "failed", attempts: 1, lockToken: null })
    expect(saved.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    expect(await unprocessedEventsForJob(uuid)).toHaveLength(1)
  })

  it("stops retries at the cap and exposes unresolved data to the owner send gate", async () => {
    const payload = jobEvent()
    const { row } = await storeWebhookEvent(parseWebhookBody(payload), payload, uuid)
    await db.update(webhookEvents).set({ status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: new Date(0) }).where(eq(webhookEvents.id, row.id))
    expect(await pendingWebhookEvents()).toEqual([])
    expect(await unprocessedEventsForJob(uuid)).toMatchObject([{ status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS }])
  })

  it("redacts credentials from persisted payloads", async () => {
    const payload = { ...jobEvent(), auth_secret: "must-not-persist", data: { ...jobEvent().data, api_key: "must-not-persist", nested: { password: "must-not-persist", amount: 760 } } }
    const stored = await storeWebhookEvent(parseWebhookBody(payload), payload, uuid)
    expect(JSON.stringify(stored.row.payload)).not.toContain("must-not-persist")
    expect(JSON.stringify(stored.row.payload)).toContain("760")
  })
})

describe("owner outbox remains independent of changed payout counts", () => {
  const automatic = { ...owner, sendEnabled: true, verifiedDeliveryAt: "2026-09-01T00:00:00Z", automaticSince: "2026-09-01T00:00:00Z" }
  async function prepare() {
    await persistPayments(uuid, [deposit(), final()])
    await process(readyJob(), automatic)
    return notification()
  }

  it("materializes and claims unchanged ready-but-unsent work without duplicate notifications", async () => {
    const first = await prepare()
    const result = await process(readyJob(), automatic)
    expect(result.engine).toMatchObject({ updated: 0, unchanged: 2 })
    expect(await notification()).toMatchObject({ id: first.id, status: "queued", snapshotHash: first.snapshotHash })
    const claimed = await Promise.all([claimOwnerNotification(first.id, workiz.payoutReadyTag), claimOwnerNotification(first.id, workiz.payoutReadyTag)])
    expect(claimed.filter(Boolean)).toHaveLength(1)
    expect(await db.select().from(ownerNotifications)).toHaveLength(1)
    expect(await db.select().from(ownerNotificationAttempts)).toHaveLength(1)
  })

  it("never turns preview execution into a live attempt or sent record", async () => {
    const row = await prepare()
    expect(await sendOwnerNotification(row.id)).toMatchObject({ status: "preview_only" })
    expect(await drainOwnerNotifications({ refresh: false })).toMatchObject({ attempted: 0, preview: true })
    expect(await notification()).toMatchObject({ attempts: 0, sentAt: null, deliveredAt: null })
    expect(await db.select().from(ownerNotificationAttempts)).toHaveLength(0)
  })

  it("suppresses historical message floods even when automatic sending is enabled", async () => {
    await persistPayments(uuid, [deposit(), final()])
    await process(readyJob(), { ...automatic, automaticSince: "2026-09-29T00:00:00Z" })
    expect(await notification()).toMatchObject({ status: "blocked", attempts: 0, blockReason: expect.stringMatching(/Historical job/) })
    const row = await notification()
    await db.update(ownerNotifications).set({ requestedAt: new Date(), requestedBy: "admin" }).where(eq(ownerNotifications.id, row.id))
    await process(readyJob(), { ...automatic, automaticSince: "2026-09-29T00:00:00Z" })
    expect((await notification()).status).toBe("queued")
  })

  it("preserves an ambiguous attempt, retry timer and original destination across resyncs", async () => {
    const row = await prepare()
    const retry = new Date(Date.now() + 60_000)
    await db.update(ownerNotifications).set({ status: "failed", requiresReview: true, lastError: "Ambiguous provider timeout", nextAttemptAt: retry }).where(eq(ownerNotifications.id, row.id))
    await process(readyJob(), { ...automatic, ownerRecipient: { workizTeamId: "different-owner", name: "Changed owner", phoneMasked: "•••• 9999" } })
    expect(await notification()).toMatchObject({ status: "failed", requiresReview: true, nextAttemptAt: retry, destinationId: "owner-test", destinationMasked: "•••• 1234" })
    expect(await claimOwnerNotification(row.id, workiz.payoutReadyTag)).toBeNull()
  })

  it("recovers an abandoned preflight without pretending that a provider write occurred", async () => {
    const row = await prepare()
    await claimOwnerNotification(row.id, workiz.payoutReadyTag)
    await db.update(ownerNotifications).set({ leaseUntil: new Date(0) }).where(eq(ownerNotifications.id, row.id))
    const getJob = vi.spyOn(WorkizClient.prototype, "getJob")
    await reconcileOwnerDelivery(row.id)
    expect(await notification()).toMatchObject({ status: "queued", leaseToken: null, sentAt: null })
    expect(getJob).not.toHaveBeenCalled()
  })

  it("reconciles an ambiguous trigger with only a read and never records Delivered", async () => {
    const row = await prepare()
    const claimed = await claimOwnerNotification(row.id, workiz.payoutReadyTag)
    await db.update(ownerNotifications).set({ status: "failed", requiresReview: true }).where(eq(ownerNotifications.id, row.id))
    await db.update(ownerNotificationAttempts).set({ requestStartedAt: new Date(), status: "ambiguous" }).where(eq(ownerNotificationAttempts.id, claimed!.leaseToken!))
    vi.spyOn(WorkizClient.prototype, "getJob").mockResolvedValue({ ...readyJob(), JobNotes: row.message, Tags: [workiz.payoutReadyTag] })
    const write = vi.spyOn(WorkizClient.prototype, "updateJob")
    await reconcileOwnerDelivery(row.id)
    expect(await notification()).toMatchObject({ status: "provider_accepted", sentSnapshotHash: row.snapshotHash, deliveredAt: null, requiresReview: false })
    expect(write).not.toHaveBeenCalled()
    await process(readyJob(), automatic)
    expect(await claimOwnerNotification(row.id, workiz.payoutReadyTag)).toBeNull()
  })

  it("does not reset the retry cap on an unchanged ready payout", async () => {
    const row = await prepare()
    await db.update(ownerNotifications).set({ status: "failed", attempts: OWNER_MAX_ATTEMPTS }).where(eq(ownerNotifications.id, row.id))
    await process(readyJob(), automatic)
    expect(await notification()).toMatchObject({ status: "failed", attempts: OWNER_MAX_ATTEMPTS })
    expect(await claimOwnerNotification(row.id, workiz.payoutReadyTag)).toBeNull()
  })

  it("does not auto-requeue a definite provider rejection on an unchanged snapshot", async () => {
    const row = await prepare()
    await db.update(ownerNotifications).set({ status: "failed", attempts: 1, lastError: "Workiz rejected the write: 403", nextAttemptAt: null }).where(eq(ownerNotifications.id, row.id))
    await process(readyJob(), automatic)
    expect(await notification()).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: null })
    expect(await claimOwnerNotification(row.id, workiz.payoutReadyTag)).toBeNull()
  })

  it("requires a fresh explicit request after the reviewed message changes", async () => {
    const row = await prepare()
    await db.update(ownerNotifications).set({ requestedAt: new Date(), requestedBy: "admin" }).where(eq(ownerNotifications.id, row.id))
    await db.update(technicianProfiles).set({ nonColorRate: "0.21" }).where(eq(technicianProfiles.id, 3))
    await process(readyJob(), { ...automatic, automaticSince: "2026-09-29T00:00:00Z" })
    expect(await notification()).toMatchObject({ status: "blocked", requestedAt: null, requestedBy: null, blockReason: expect.stringMatching(/explicitly requested payout changed/) })
    await process(readyJob(), { ...automatic, automaticSince: "2026-09-29T00:00:00Z" })
    expect((await notification()).status).toBe("blocked")
  })

  it("creates missing outbox rows before cycling existing blocked rows", async () => {
    const row = await prepare()
    await process(readyJob({ UUID: "OTHER760" }))
    await db.delete(ownerNotifications).where(eq(ownerNotifications.id, row.id))
    await refreshOwnerOutbox(1)
    expect(await notification()).toBeDefined()
  })

  it("makes no provider reads after a worker hits the quota budget", async () => {
    const row = await prepare()
    await db.update(ownerNotifications).set({ status: "failed", requiresReview: true, nextAttemptAt: new Date(0) }).where(eq(ownerNotifications.id, row.id))
    vi.stubEnv("VERCEL_ENV", "production")
    const read = vi.spyOn(WorkizClient.prototype, "getJob")
    expect(await drainOwnerNotifications({ refresh: false, limit: 0 })).toMatchObject({ attempted: 0 })
    expect(read).not.toHaveBeenCalled()
  })

  it("blocks the whole job when any required technician becomes unmapped", async () => {
    const row = await prepare()
    await process(readyJob({ Team: [{ id: "tech-arthur", Name: "Arthur" }, { id: "new-unmapped", Name: "New technician" }] }), automatic)
    expect(await notification()).toMatchObject({ status: "blocked", message: "" })
    expect(await claimOwnerNotification(row.id, workiz.payoutReadyTag)).toBeNull()
  })
})
