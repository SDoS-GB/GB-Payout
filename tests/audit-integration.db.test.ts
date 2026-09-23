import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Database-backed audit of the sync -> payout -> owner-text pipeline.
 *
 * Runs ONLY when AUDIT_DATABASE_URL points at an isolated Neon branch (never
 * production): `AUDIT_DATABASE_URL=... pnpm vitest run tests/audit-integration.db.test.ts`.
 * No Workiz calls are made: raw job payloads are fed straight into processRawJob and the
 * Workiz client used for delivery is an in-memory fake that records tag/description writes
 * and can be told to fail or to "apply then time out". Every row it creates is prefixed with
 * the run id and removed afterwards.
 */
const AUDIT_URL = process.env.AUDIT_DATABASE_URL
if (AUDIT_URL) process.env.DATABASE_URL = AUDIT_URL

type Mods = {
  db: typeof import("@/lib/db")["db"]
  schema: typeof import("@/lib/db/schema")
  sync: typeof import("@/lib/workiz/sync")
  owner: typeof import("@/lib/notifications/owner")
  events: typeof import("@/lib/workiz/events")
  webhook: typeof import("@/lib/workiz/webhook")
  settings: typeof import("@/lib/settings")
  orm: typeof import("drizzle-orm")
}

const RUN = `AUDIT-${Date.now().toString(36)}`
const TEAM = { A: `${RUN}-9001`, B: `${RUN}-9002`, TIM: `${RUN}-9003`, UNMAPPED: `${RUN}-9004` }
const money = (v: string | number | null | undefined) => Math.round(Number(v) * 100) / 100

/** In-memory stand-in for the Workiz client: what deliverToWorkiz reads and writes. */
class FakeWorkiz {
  jobs = new Map<string, { Tags: string[]; JobNotes: string }>()
  updates: Array<{ uuid: string; Tags?: string[]; JobNotes?: string }> = []
  failMode: "none" | "throw" | "apply-then-throw" = "none"
  seed(uuid: string) {
    if (!this.jobs.has(uuid)) this.jobs.set(uuid, { Tags: ["Work"], JobNotes: "Office note: gate code 1234" })
  }
  async getJob(uuid: string) {
    this.seed(uuid)
    const j = this.jobs.get(uuid)!
    return { UUID: uuid, Tags: [...j.Tags], JobNotes: j.JobNotes }
  }
  async updateJob(uuid: string, fields: { Tags?: string[]; JobNotes?: string }) {
    this.seed(uuid)
    if (this.failMode === "throw") throw new Error("Workiz POST job/update/ failed with 504: gateway timeout")
    this.updates.push({ uuid, ...fields })
    const j = this.jobs.get(uuid)!
    if (fields.Tags) j.Tags = Array.from(new Set([...j.Tags, ...fields.Tags]))
    if (fields.JobNotes !== undefined) j.JobNotes = fields.JobNotes
    if (this.failMode === "apply-then-throw") throw new Error("socket hang up after the update was applied")
    return { flag: true, msg: "Job updated" }
  }
}

describe.skipIf(!AUDIT_URL)("Audit integration on isolated Neon branch", () => {
  let m: Mods
  let ids: { A: number; B: number; TIM: number }
  let workizSettings: Awaited<ReturnType<Mods["settings"]["getWorkizSettings"]>>
  let notificationSettings: Awaited<ReturnType<Mods["settings"]["getNotificationSettings"]>>
  const catalog = new Map<string, boolean>()
  const fake = new FakeWorkiz()
  const client = () => fake as unknown as import("@/lib/workiz/client").WorkizClient

  const raw = (uuid: string, over: Record<string, unknown> = {}) => ({
    UUID: `${RUN}-${uuid}`,
    SerialId: `${RUN}-${uuid}`,
    Status: "Done",
    FirstName: "Audit",
    LastName: "Customer",
    JobDateTime: "2026-09-10 09:00:00",
    LastStatusUpdate: "2026-09-10 14:30:00",
    Team: [
      { id: TEAM.A, Name: "Audit Reg A" },
      { id: TEAM.B, Name: "Audit Reg B" },
      { id: TEAM.TIM, Name: "Audit Tim" },
    ],
    SubTotal: 2000,
    JobTotalPrice: 1800,
    LineItems: [
      { Name: "Regrout and caulk", Price: 1000, Quantity: 1, Type: "service" },
      { Name: "Grout Color Sealing", Price: 500, Quantity: 1, Type: "service" },
      { Name: "*AT* Shower restoration", Price: 500, Quantity: 1, Type: "service" },
      { Name: "discount", Price: 200, Quantity: 1, Type: "DISCOUNT_TYPE" },
    ],
    Payments: [
      { id: `${uuid}-p1`, Amount: 1800, Method: "Credit Card" },
      { id: `${uuid}-p2`, Amount: 100, Method: "Credit Card", IsTip: true },
    ],
    ...over,
  })

  /** Sync without a Workiz client: payouts + owner row, no delivery (like a cron with texts off). */
  const runJob = (r: ReturnType<typeof raw>) => m.sync.processRawJob(r as never, "rest", { settings: workizSettings, catalog })
  /** Sync with the fake client: delivers when the row is queued (like the webhook path). */
  const runJobLive = (r: ReturnType<typeof raw>) => m.sync.processRawJob(r as never, "webhook", { settings: workizSettings, catalog, client: client(), via: "audit-live" })
  const payoutsFor = async (uuid: string) => {
    const { eq } = m.orm
    return m.db.select().from(m.schema.payouts).where(eq(m.schema.payouts.jobUuid, `${RUN}-${uuid}`)).orderBy(m.schema.payouts.profileId)
  }
  const ownerFor = async (uuid: string) => (await m.owner.getOwnerNotification(`${RUN}-${uuid}`))!
  const setTexts = async (enabled: boolean) => {
    workizSettings = await m.settings.saveWorkizSettings({ payoutReadyTagEnabled: enabled, payoutReadyTag: "Payout Ready" }, "audit")
  }

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      schema: await import("@/lib/db/schema"),
      sync: await import("@/lib/workiz/sync"),
      owner: await import("@/lib/notifications/owner"),
      events: await import("@/lib/workiz/events"),
      webhook: await import("@/lib/workiz/webhook"),
      settings: await import("@/lib/settings"),
      orm: await import("drizzle-orm"),
    }
    const host = new URL(AUDIT_URL as string).hostname
    // Refuse to run against anything that is not the audit branch compute.
    if (!/audit|raspy|firefly/i.test(host) && !process.env.AUDIT_ALLOW_ANY_HOST) {
      throw new Error(`AUDIT_DATABASE_URL host ${host} does not look like the audit branch; refusing to run`)
    }
    await setTexts(false)
    notificationSettings = await m.settings.saveNotificationSettings({ ownerRecipient: { workizTeamId: `${RUN}-owner`, name: "Audit Owner", phoneMasked: "•••• 0000" } }, "audit")
    const [a, b, tim] = await m.db
      .insert(m.schema.technicianProfiles)
      .values([
        { name: `${RUN} Reg A`, pinHash: "audit", nonColorRate: "0.2", colorRate: "0.25", tipShare: "0.5", separateColorSeal: true },
        { name: `${RUN} Reg B`, pinHash: "audit", nonColorRate: "0.3", colorRate: "0.35", tipShare: "0.5", separateColorSeal: true },
        { name: `${RUN} Tim`, pinHash: "audit", nonColorRate: "0.8", colorRate: "0.8", tipShare: "0", separateColorSeal: false, lineItemMarker: "AT" },
      ])
      .returning({ id: m.schema.technicianProfiles.id })
    ids = { A: a.id, B: b.id, TIM: tim.id }
    await m.db.insert(m.schema.workizTeamMappings).values([
      { workizTeamId: TEAM.A, workizName: "Audit Reg A", profileId: ids.A, source: "audit" },
      { workizTeamId: TEAM.B, workizName: "Audit Reg B", profileId: ids.B, source: "audit" },
      { workizTeamId: TEAM.TIM, workizName: "Audit Tim", profileId: ids.TIM, source: "audit" },
    ])
  }, 60_000)

  afterAll(async () => {
    if (!m) return
    const { like, inArray } = m.orm
    const jobs = await m.db.select({ uuid: m.schema.workizJobs.uuid }).from(m.schema.workizJobs).where(like(m.schema.workizJobs.uuid, `${RUN}-%`))
    const uuids = jobs.map((j) => j.uuid)
    if (uuids.length) {
      await m.db.delete(m.schema.ownerNotifications).where(inArray(m.schema.ownerNotifications.jobUuid, uuids))
      await m.db.delete(m.schema.jobPayments).where(inArray(m.schema.jobPayments.jobUuid, uuids))
      await m.db.delete(m.schema.payouts).where(inArray(m.schema.payouts.jobUuid, uuids))
      await m.db.delete(m.schema.syncEvents).where(inArray(m.schema.syncEvents.jobUuid, uuids))
      await m.db.delete(m.schema.workizJobs).where(inArray(m.schema.workizJobs.uuid, uuids))
    }
    await m.db.delete(m.schema.webhookEvents).where(like(m.schema.webhookEvents.jobInternalId, `JOB-${RUN}%`))
    await m.db.delete(m.schema.workizJobIds).where(like(m.schema.workizJobIds.internalId, `JOB-${RUN}%`))
    await m.db.delete(m.schema.workizTeamMappings).where(like(m.schema.workizTeamMappings.workizTeamId, `${RUN}-%`))
    await m.db.delete(m.schema.technicianProfiles).where(like(m.schema.technicianProfiles.name, `${RUN} %`))
    await setTexts(false)
    const { pool } = await import("@/lib/db")
    await pool.end()
  }, 60_000)

  it("saves one payout per technician on each technician's own rates, all ready, none combined; owner text is preview-only while texts are off", async () => {
    const result = await runJob(raw("shared"))
    expect(result.engine.created).toBe(3)
    expect(result.engine.held).toBe(0)
    const rows = await payoutsFor("shared")
    expect(rows).toHaveLength(3)
    const byProfile = new Map(rows.map((r) => [r.profileId, r]))
    // Hand-computed: A 900*.965*.2 + 450*.965*.25 + 100*.965/2 = 330.5125
    expect(money(byProfile.get(ids.A)!.totalPayout)).toBe(330.51)
    // B on 30%/35%: 900*.965*.3 + 450*.965*.35 + 48.25 = 460.7875
    expect(money(byProfile.get(ids.B)!.totalPayout)).toBe(460.79)
    // Tim: 450*.965*.8 = 347.40, no tip
    expect(money(byProfile.get(ids.TIM)!.totalPayout)).toBe(347.4)
    expect(money(byProfile.get(ids.TIM)!.tipPayout)).toBe(0)
    for (const r of rows) expect(r.status).toBe("ready")

    const owner = await ownerFor("shared")
    expect(owner.status).toBe("preview_only")
    expect(owner.blockReason).toMatch(/switched off/)
    expect(owner.destinationLabel).toBe("Audit Owner")
    expect(owner.destinationMasked).toBe("•••• 0000")
    // One line per technician with their own amount; never a combined crew total.
    expect(owner.message).toContain(`${RUN} Reg A: $330.51`)
    expect(owner.message).toContain(`${RUN} Reg B: $460.79`)
    expect(owner.message).toContain(`${RUN} Tim: $347.40`)
    expect(owner.message).not.toContain("1138.70")
    expect(owner.message).toContain("Client payments: Card $1,800.00")
    expect(owner.message).toContain("Card fee applied proportionally.")
    expect(owner.message).toContain("Completed Sep 10, 2026")
    expect(owner.sentAt).toBeNull()
  }, 60_000)

  it("re-processing the same job (repeated/overlapping sync, duplicate webhook) changes no payout and never delivers", async () => {
    const before = await payoutsFor("shared")
    const second = await runJob(raw("shared"))
    expect(second.engine.created).toBe(0)
    expect(second.engine.updated).toBe(0)
    expect(second.engine.unchanged).toBe(3)
    const after = await payoutsFor("shared")
    expect(after.map((r) => r.inputHash)).toEqual(before.map((r) => r.inputHash))
    expect((await ownerFor("shared")).status).toBe("preview_only")
    expect(fake.updates).toHaveLength(0)
  }, 60_000)

  it("three concurrent syncs of a brand-new job cannot create duplicate payouts or owner rows", async () => {
    const results = await Promise.allSettled([runJob(raw("race")), runJob(raw("race")), runJob(raw("race"))])
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)
    const rows = await payoutsFor("race")
    expect(rows).toHaveLength(3)
    const { eq } = m.orm
    const ownerRows = await m.db.select().from(m.schema.ownerNotifications).where(eq(m.schema.ownerNotifications.jobUuid, `${RUN}-race`))
    expect(ownerRows).toHaveLength(1)
  }, 60_000)

  it("payment before completion: pending while Submitted (owner text blocked), ready once Done", async () => {
    const first = await runJob(raw("paidfirst", { Status: "Submitted", LastStatusUpdate: "2026-09-10 09:05:00" }))
    expect(first.engine.created).toBe(3)
    for (const r of await payoutsFor("paidfirst")) expect(r.status).toBe("pending")
    const blocked = await ownerFor("paidfirst")
    expect(blocked.status).toBe("blocked")
    expect(blocked.blockReason).toMatch(/pending/)
    const second = await runJob(raw("paidfirst"))
    expect(second.engine.updated).toBe(3)
    for (const r of await payoutsFor("paidfirst")) expect(r.status).toBe("ready")
    expect((await ownerFor("paidfirst")).status).toBe("preview_only")
  }, 60_000)

  it("completion before payment: held while a deposit is outstanding, ready when the balance lands", async () => {
    await runJob(raw("doneFirst", { Payments: [{ id: "dep", Amount: 500, Method: "Visa" }] }))
    for (const r of await payoutsFor("doneFirst")) expect(r.holdReason).toBe("Job is not fully paid")
    expect((await ownerFor("doneFirst")).blockReason).toMatch(/on hold - Job is not fully paid/)
    await runJob(raw("doneFirst", { Payments: [{ id: "dep", Amount: 500, Method: "Visa" }, { id: "bal", Amount: 1300, Method: "Check" }, { id: "tip", Amount: 100, Method: "Check", IsTip: true }] }))
    const rows = await payoutsFor("doneFirst")
    for (const r of rows) expect(r.status).toBe("ready")
    const a = rows.find((r) => r.profileId === ids.A)!
    expect(money(a.cardServiceAmount)).toBe(375)
    expect(money(a.nonCardServiceAmount)).toBe(975)
    expect(money(a.nonCardTipAmount)).toBe(100)
    const owner = await ownerFor("doneFirst")
    expect(owner.status).toBe("preview_only")
    expect(owner.message).toContain("Client payments: Card $500.00; Check $1,300.00")
  }, 60_000)

  it("live Workiz shape (no Payments array): a zero balance proves paid but the method is unknown, so the payout is held and the owner text is blocked", async () => {
    await runJob(raw("balanceOnly", { Payments: undefined, JobAmountDue: 0 }))
    for (const r of await payoutsFor("balanceOnly")) {
      expect(r.status).toBe("hold")
      expect(r.holdReason).toMatch(/^Payment method unknown/)
    }
    const owner = await ownerFor("balanceOnly")
    expect(owner.status).toBe("blocked")
    expect(owner.blockReason).toMatch(/Payment method unknown/)
  }, 60_000)

  it("#924878 shape: an older webhook deposit survives re-delivery and a recent job re-fetch; the check entered as recovery completes it at $159.97", async () => {
    const uuid = `${RUN}-gb924878`
    // Sep 15: estimate/invoice webhook reports the card deposit; Workiz gives no per-payment date.
    const deposit = { externalId: `PAY-${RUN}-dep`, source: "invoice-webhook" as const, method: "Credit charge", amount: 172.5, tipAmount: 0, paidAt: "2026-09-15T14:29:00Z", paidAtFromPayload: false, invoiceId: `IV-${RUN}`, reference: null, recordedBy: null }
    await m.sync.recordExternalPayments(uuid, [deposit])
    // Sep 23: the same payment id is re-delivered with today's arrival time. The stored date must not move.
    await m.sync.recordExternalPayments(uuid, [{ ...deposit, paidAt: "2026-09-23T18:05:35Z" }])
    const { eq } = m.orm
    let stored = await m.db.select().from(m.schema.jobPayments).where(eq(m.schema.jobPayments.jobUuid, uuid))
    expect(stored).toHaveLength(1)
    expect(stored[0].paidAt?.toISOString()).toBe("2026-09-15T14:29:00.000Z")

    // Job re-fetched with the live shape (no Payments, $0 due): only the deposit is typed -> held, not erased.
    const job = raw("gb924878", {
      Team: [{ id: TEAM.A, Name: "Audit Reg A" }],
      SubTotal: 760,
      JobTotalPrice: 760,
      JobAmountDue: 0,
      Payments: undefined,
      LastStatusUpdate: "2026-09-23 14:05:32",
      LineItems: [
        { Name: "Restorative Tile & Grout Floor Cleaning", Price: 575, Quantity: 1, Type: "service" },
        { Name: "Grout Color Sealing - Floors", Price: 185, Quantity: 1, Type: "service" },
      ],
    })
    await runJob(job)
    let rows = await payoutsFor("gb924878")
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("hold")
    expect(rows[0].holdReason).toMatch(/payment records cover only \$172\.50/)
    stored = await m.db.select().from(m.schema.jobPayments).where(eq(m.schema.jobPayments.jobUuid, uuid))
    expect(stored).toHaveLength(1)

    // The check Workiz never reported, entered through the labelled recovery path.
    await m.sync.replaceManualPayments(uuid, [{ method: "Check", amount: 587.5, paidAt: "2026-09-23T18:00:00Z", reference: "#125" }], "audit")
    await runJob(job)
    rows = await payoutsFor("gb924878")
    expect(rows[0].status).toBe("ready")
    expect(money(rows[0].totalPayout)).toBe(159.97)
    expect(money(rows[0].cardServiceAmount)).toBe(172.5)
    const owner = await ownerFor("gb924878")
    expect(owner.message).toContain("Client payments: Card $172.50; Check $587.50")
    expect(owner.message).toContain("Card fee applied proportionally.")
    expect(owner.message).toContain(`${RUN} Reg A: $159.97`)
    expect(owner.message).toContain("Completed Sep 23, 2026")
  }, 60_000)

  it("card tips from a document webhook: separate tips are split after the 3.5% fee; an ambiguous inclusion holds the job", async () => {
    const uuid = `${RUN}-cardtip`
    const job = raw("cardtip", { Team: [{ id: TEAM.A, Name: "Audit Reg A" }], SubTotal: 1000, JobTotalPrice: 1000, JobAmountDue: 0, Payments: undefined, LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" }] })
    const pay = { externalId: `PAY-${RUN}-tip`, source: "invoice-webhook" as const, method: "Credit charge", amount: 1000, tipAmount: 40, paidAt: null, paidAtFromPayload: false, invoiceId: null, reference: null, recordedBy: null }
    await m.sync.recordExternalPayments(uuid, [pay], { tipInclusion: "separate" })
    await runJob(job)
    let [row] = await payoutsFor("cardtip")
    expect(row.status).toBe("ready")
    expect(money(row.cardTipAmount)).toBe(40)
    // 1000*.965*.2 + 40*.965*.5 = 193 + 19.30
    expect(money(row.totalPayout)).toBe(212.3)

    await m.sync.recordExternalPayments(uuid, [pay], { tipInclusion: "unknown" })
    await runJob(job)
    ;[row] = await payoutsFor("cardtip")
    expect(row.status).toBe("hold")
    expect(row.holdReason).toMatch(/^Tip payment method unclear/)
  }, 60_000)

  it("an unmapped team member holds the mapped technicians' payouts and blocks the owner text", async () => {
    await runJob(
      raw("unmapped", {
        Team: [{ id: TEAM.A, Name: "Audit Reg A" }, { id: TEAM.UNMAPPED, Name: "Audit Newcomer" }],
        SubTotal: 1000,
        JobTotalPrice: 1000,
        LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" }],
        Payments: [{ id: "unmapped-p1", Amount: 1000, Method: "Check" }],
      }),
    )
    const rows = await payoutsFor("unmapped")
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("hold")
    expect(rows[0].holdReason).toContain(TEAM.UNMAPPED)
    expect((await ownerFor("unmapped")).status).toBe("blocked")
  }, 60_000)

  it("webhook events are stored once, duplicates are recognised, and estimate events resolve through the learned JOB id", async () => {
    const internalId = `JOB-${RUN}x`
    const estimate = {
      trigger: { type: "estimate_status_changed", timestamp: "2026-09-15T14:29:00Z" },
      data: { id: `ES-${RUN}`, jobId: internalId, status: "Approved", payments: [{ id: `PAY-${RUN}-est`, type: "Credit charge", amount: 172.5, tipAmount: 0 }] },
      metadata: { ruleName: "Estimate webhook" },
    }
    const parsed = m.webhook.parseWebhookBody(estimate)
    expect(parsed.kind).toBe("estimate")
    expect(parsed.jobInternalId).toBe(internalId)
    expect(parsed.uuidCandidates).toEqual([])
    expect(parsed.invoice?.payments[0].source).toBe("estimate-webhook")

    const first = await m.events.storeWebhookEvent(parsed, estimate, null)
    const second = await m.events.storeWebhookEvent(parsed, estimate, null)
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.row.id).toBe(first.row.id)

    expect(await m.events.resolveJobUuid(internalId)).toBeNull()
    await m.events.markWebhookEvent(first.row.id, "unresolved", { error: "not mapped yet" })
    expect((await m.events.pendingUnresolvedEvents({ internalId })).map((e) => e.id)).toEqual([first.row.id])
    await m.events.rememberJobIds({ internalId, uuid: `${RUN}-gb924878`, serialId: 924878 })
    expect(await m.events.resolveJobUuid(internalId)).toBe(`${RUN}-gb924878`)
    await m.events.markWebhookEvent(first.row.id, "processed", { jobUuid: `${RUN}-gb924878` })
    expect(await m.events.pendingUnresolvedEvents({ internalId })).toHaveLength(0)
  }, 60_000)

  it("paid and void payouts are never overwritten by later Workiz changes; reopen forces a recompute", async () => {
    const { eq } = m.orm
    let rows = await payoutsFor("shared")
    const a = rows.find((r) => r.profileId === ids.A)!
    const b = rows.find((r) => r.profileId === ids.B)!
    await m.db.update(m.schema.payouts).set({ status: "paid", paidAt: new Date(), paidBy: "audit" }).where(eq(m.schema.payouts.id, a.id))
    await m.db.update(m.schema.payouts).set({ status: "void" }).where(eq(m.schema.payouts.id, b.id))

    const changed = raw("shared", { JobTotalPrice: 1600, LineItems: [...raw("shared").LineItems.slice(0, 3), { Name: "discount", Price: 400, Quantity: 1, Type: "DISCOUNT_TYPE" }], Payments: [{ id: "shared-p1", Amount: 1600, Method: "Credit Card" }, { id: "shared-p2", Amount: 100, Method: "Credit Card", IsTip: true }] })
    const result = await runJob(changed)
    expect(result.engine.updated).toBe(1) // Tim only
    expect(result.engine.unchanged).toBe(2)

    rows = await payoutsFor("shared")
    expect(rows.find((r) => r.profileId === ids.A)!.status).toBe("paid")
    expect(money(rows.find((r) => r.profileId === ids.A)!.totalPayout)).toBe(330.51)
    expect(rows.find((r) => r.profileId === ids.B)!.status).toBe("void")
    expect(money(rows.find((r) => r.profileId === ids.TIM)!.totalPayout)).toBe(308.8)
    // The owner text now lists the paid technician as already paid, the void one not at all.
    const owner = await ownerFor("shared")
    expect(owner.message).toContain(`${RUN} Reg A: $330.51 - already paid`)
    expect(owner.message).not.toContain(`${RUN} Reg B`)

    await m.db.update(m.schema.payouts).set({ status: "pending", paidAt: null, paidBy: null, inputHash: null }).where(eq(m.schema.payouts.id, a.id))
    const again = await runJob(changed)
    expect(again.engine.updated).toBe(1)
    const a3 = (await payoutsFor("shared")).find((r) => r.profileId === ids.A)!
    expect(money(a3.totalPayout)).toBe(299.15)
    expect(a3.status).toBe("ready")
  }, 60_000)

  it("owner outbox: an unchanged ready-but-unsent job is delivered once texts are on, never twice, with racing runs, failures, retries and timeout reconciliation handled", async () => {
    await setTexts(true)
    notificationSettings = await m.settings.getNotificationSettings()
    const ctx = { settings: workizSettings, notificationSettings, client: client(), via: "audit" as const }

    // 1. A sync that changes nothing ("zero payouts updated") still queues and delivers the pending text.
    const before = fake.updates.length
    const res = await runJobLive(raw("paidfirst"))
    expect(res.engine.updated).toBe(0)
    let owner = await ownerFor("paidfirst")
    expect(owner.status).toBe("provider_accepted")
    expect(owner.sentAt).not.toBeNull()
    expect(owner.sentSnapshotHash).toBe(owner.snapshotHash)
    expect(fake.updates.length).toBe(before + 1)
    const written = fake.jobs.get(`${RUN}-paidfirst`)!
    expect(written.Tags).toContain("Payout Ready")
    expect(written.JobNotes.startsWith("GB payout ready")).toBe(true)
    expect(written.JobNotes).toContain("Office note: gate code 1234")
    expect(written.JobNotes).toContain(`${RUN} Reg A: $330.51`)
    const pr = owner.providerResponse as { deliveryReceipt: string }
    expect(pr.deliveryReceipt).toMatch(/no SMS receipt/)

    // 2. Repeated syncs and outbox runs do not send again.
    await runJobLive(raw("paidfirst"))
    const outbox = await m.owner.processOwnerOutbox(ctx)
    expect(outbox.accepted).toBe(0)
    expect(fake.updates.length).toBe(before + 1)

    // 3. Two runs racing on the same queued row: exactly one sends.
    await runJob(raw("doneFirst", { Payments: [{ id: "dep", Amount: 500, Method: "Visa" }, { id: "bal", Amount: 1300, Method: "Check" }, { id: "tip", Amount: 100, Method: "Check", IsTip: true }] }))
    const queued = await ownerFor("doneFirst")
    expect(queued.status).toBe("queued")
    const race = await Promise.all([m.owner.attemptDelivery(queued.id, ctx), m.owner.attemptDelivery(queued.id, ctx)])
    expect(race.filter((r) => r.outcome === "provider_accepted")).toHaveLength(1)
    expect(race.filter((r) => r.outcome === "skipped")).toHaveLength(1)
    expect(fake.updates.length).toBe(before + 2)

    // 4. Held / blocked jobs are never considered by the outbox.
    const held = await ownerFor("balanceOnly")
    expect(held.status).toBe("blocked")
    expect((await m.owner.attemptDelivery(held.id, ctx)).outcome).toBe("skipped")

    // 5. Provider failure: bounded retry, nothing sent, not re-attempted before its retry time.
    fake.failMode = "throw"
    await runJob(raw("race"))
    const raceRow = await ownerFor("race")
    const failed = await m.owner.attemptDelivery(raceRow.id, ctx)
    expect(failed.outcome).toBe("failed")
    if (failed.outcome === "failed") expect(failed.retryAt).not.toBeNull()
    let r = await ownerFor("race")
    expect(r.status).toBe("failed")
    expect(r.attempts).toBe(1)
    expect(r.lastError).toMatch(/504/)
    expect((await m.owner.processOwnerOutbox(ctx)).considered).toBe(0)
    expect(fake.updates.length).toBe(before + 2)

    // 6. Ambiguous timeout: Workiz applied the update but the response was lost. The retry finds
    //    the tag + block already on the job and records it instead of writing a second time.
    fake.failMode = "apply-then-throw"
    const { eq } = m.orm
    await m.db.update(m.schema.ownerNotifications).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(m.schema.ownerNotifications.id, raceRow.id))
    const second = await m.owner.attemptDelivery(raceRow.id, ctx)
    expect(second.outcome).toBe("failed")
    expect(fake.updates.length).toBe(before + 3)
    fake.failMode = "none"
    await m.db.update(m.schema.ownerNotifications).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(m.schema.ownerNotifications.id, raceRow.id))
    const third = await m.owner.attemptDelivery(raceRow.id, ctx)
    expect(third.outcome).toBe("provider_accepted")
    if (third.outcome === "provider_accepted") expect(third.reconciled).toBe(true)
    expect(fake.updates.length).toBe(before + 3)
    r = await ownerFor("race")
    expect(r.status).toBe("provider_accepted")

    // 7. A payout change after delivery is visible but never re-texts.
    await runJobLive(raw("paidfirst", { JobTotalPrice: 1700, LineItems: [...raw("paidfirst").LineItems.slice(0, 3), { Name: "discount", Price: 300, Quantity: 1, Type: "DISCOUNT_TYPE" }], Payments: [{ id: "paidfirst-p1", Amount: 1700, Method: "Credit Card" }, { id: "paidfirst-p2", Amount: 100, Method: "Credit Card", IsTip: true }] }))
    owner = await ownerFor("paidfirst")
    expect(owner.status).toBe("provider_accepted")
    expect(owner.blockReason).toMatch(/changed after this text was sent/)
    expect(owner.snapshotHash).not.toBe(owner.sentSnapshotHash)
    expect(fake.updates.length).toBe(before + 3)

    // 8. A stale queued snapshot is refreshed before sending: the current amounts go out.
    await runJob(raw("cardtip", { Team: [{ id: TEAM.A, Name: "Audit Reg A" }], SubTotal: 1000, JobTotalPrice: 1000, JobAmountDue: 0, Payments: undefined, LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" }] }))
    // cardtip is on hold (ambiguous tip) -> make it ready again with a separate tip, then poison the stored snapshot.
    await m.sync.recordExternalPayments(`${RUN}-cardtip`, [{ externalId: `PAY-${RUN}-tip`, source: "invoice-webhook", method: "Credit charge", amount: 1000, tipAmount: 40, paidAt: null, paidAtFromPayload: false, invoiceId: null, reference: null, recordedBy: null }], { tipInclusion: "separate" })
    await runJob(raw("cardtip", { Team: [{ id: TEAM.A, Name: "Audit Reg A" }], SubTotal: 1000, JobTotalPrice: 1000, JobAmountDue: 0, Payments: undefined, LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" }] }))
    const tipRow = await ownerFor("cardtip")
    expect(tipRow.status).toBe("queued")
    await m.db.update(m.schema.ownerNotifications).set({ snapshotHash: "stale", message: "STALE MESSAGE" }).where(eq(m.schema.ownerNotifications.id, tipRow.id))
    const sent = await m.owner.attemptDelivery(tipRow.id, ctx)
    expect(sent.outcome).toBe("provider_accepted")
    const fresh = await ownerFor("cardtip")
    expect(fresh.message).not.toContain("STALE")
    expect(fresh.message).toContain(`${RUN} Reg A: $212.30`)
    expect(fresh.sentSnapshotHash).not.toBe("stale")
    expect(fake.jobs.get(`${RUN}-cardtip`)!.JobNotes).toContain("Tip $40.00")

    await setTexts(false)
  }, 120_000)
})
