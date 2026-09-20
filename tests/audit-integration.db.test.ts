import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Database-backed audit of the sync -> payout -> notification pipeline.
 *
 * Runs ONLY when AUDIT_DATABASE_URL points at an isolated Neon branch (never
 * production): `AUDIT_DATABASE_URL=... pnpm vitest run tests/audit-integration.db.test.ts`.
 * No Workiz calls are made; raw job payloads are fed straight into processRawJob,
 * and message delivery is a mock. Every row it creates is prefixed with the run id
 * and removed afterwards.
 */
const AUDIT_URL = process.env.AUDIT_DATABASE_URL
if (AUDIT_URL) process.env.DATABASE_URL = AUDIT_URL

type Mods = {
  db: typeof import("@/lib/db")["db"]
  schema: typeof import("@/lib/db/schema")
  sync: typeof import("@/lib/workiz/sync")
  send: typeof import("@/lib/notifications/send")
  settings: typeof import("@/lib/settings")
  orm: typeof import("drizzle-orm")
}

const RUN = `AUDIT-${Date.now().toString(36)}`
const TEAM = { A: `${RUN}-9001`, B: `${RUN}-9002`, TIM: `${RUN}-9003`, UNMAPPED: `${RUN}-9004` }
const money = (v: string | number | null | undefined) => Math.round(Number(v) * 100) / 100

describe.skipIf(!AUDIT_URL)("Audit integration on isolated Neon branch", () => {
  let m: Mods
  let ids: { A: number; B: number; TIM: number }
  let workizSettings: Awaited<ReturnType<Mods["settings"]["getWorkizSettings"]>>
  const catalog = new Map<string, boolean>()

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

  const runJob = (r: ReturnType<typeof raw>) => m.sync.processRawJob(r as never, "rest", { settings: workizSettings, catalog })
  const payoutsFor = async (uuid: string) => {
    const { eq } = m.orm
    return m.db.select().from(m.schema.payouts).where(eq(m.schema.payouts.jobUuid, `${RUN}-${uuid}`)).orderBy(m.schema.payouts.profileId)
  }
  const notificationsFor = async (payoutId: number) => {
    const { eq } = m.orm
    return m.db.select().from(m.schema.notifications).where(eq(m.schema.notifications.payoutId, payoutId))
  }

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      schema: await import("@/lib/db/schema"),
      sync: await import("@/lib/workiz/sync"),
      send: await import("@/lib/notifications/send"),
      settings: await import("@/lib/settings"),
      orm: await import("drizzle-orm"),
    }
    const host = new URL(AUDIT_URL as string).hostname
    // Refuse to run against anything that is not the audit branch compute.
    if (!/audit|raspy|firefly/i.test(host) && !process.env.AUDIT_ALLOW_ANY_HOST) {
      throw new Error(`AUDIT_DATABASE_URL host ${host} does not look like the audit branch; refusing to run`)
    }
    workizSettings = await m.settings.getWorkizSettings()
    const [a, b, tim] = await m.db
      .insert(m.schema.technicianProfiles)
      .values([
        { name: `${RUN} Reg A`, pinHash: "audit", nonColorRate: "0.2", colorRate: "0.25", tipShare: "0.5", separateColorSeal: true },
        { name: `${RUN} Reg B`, pinHash: "audit", nonColorRate: "0.3", colorRate: "0.35", tipShare: "0.5", separateColorSeal: true },
        { name: `${RUN} Tim`, pinHash: "audit", nonColorRate: "0.8", colorRate: "0.8", tipShare: "1", separateColorSeal: false, lineItemMarker: "AT" },
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
      await m.db.delete(m.schema.notifications).where(inArray(m.schema.notifications.jobUuid, uuids))
      await m.db.delete(m.schema.payouts).where(inArray(m.schema.payouts.jobUuid, uuids))
      await m.db.delete(m.schema.syncEvents).where(inArray(m.schema.syncEvents.jobUuid, uuids))
      await m.db.delete(m.schema.workizJobs).where(inArray(m.schema.workizJobs.uuid, uuids))
    }
    await m.db.delete(m.schema.workizTeamMappings).where(like(m.schema.workizTeamMappings.workizTeamId, `${RUN}-%`))
    await m.db.delete(m.schema.technicianProfiles).where(like(m.schema.technicianProfiles.name, `${RUN} %`))
    await m.settings.saveNotificationSettings({ sendEnabled: false }, "audit")
    const { pool } = await import("@/lib/db")
    await pool.end()
  }, 60_000)

  it("saves one payout per technician on each technician's own rates, all ready, none combined", async () => {
    const result = await runJob(raw("shared"))
    expect(result.engine.created).toBe(3)
    expect(result.engine.held).toBe(0)
    const rows = await payoutsFor("shared")
    expect(rows).toHaveLength(3)
    const byProfile = new Map(rows.map((r) => [r.profileId, r]))
    // Hand-computed: A 900*.965*.2 + 450*.965*.25 + 100*.965/2 = 330.5125
    expect(money(byProfile.get(ids.A)!.totalPayout)).toBe(330.51)
    // B on 30%/35%: 900*.965*.3 + 450*.965*.35 + 48.25 = 260.55 + 151.9875 + 48.25 = 460.7875
    expect(money(byProfile.get(ids.B)!.totalPayout)).toBe(460.79)
    // Tim: 450*.965*.8 = 347.40, no tip
    expect(money(byProfile.get(ids.TIM)!.totalPayout)).toBe(347.4)
    expect(money(byProfile.get(ids.TIM)!.tipPayout)).toBe(0)
    for (const r of rows) expect(r.status).toBe("ready")
    expect(byProfile.get(ids.A)!.segmentKind).toBe("crew")
    expect(byProfile.get(ids.TIM)!.segmentKind).toBe("dedicated")
    expect(byProfile.get(ids.A)!.splitCount).toBe(2)
    // Saved snapshot agrees with the saved breakdown.
    const bd = byProfile.get(ids.A)!.breakdown as { totalPayout: number; job: { jobTotal: number }; verification: { balanced: boolean } }
    expect(money(bd.totalPayout)).toBe(330.51)
    expect(bd.job.jobTotal).toBe(1800)
    expect(bd.verification.balanced).toBe(true)
    // Sending is disabled: every notification is a preview, nothing is sent.
    for (const r of rows) {
      const n = await notificationsFor(r.id)
      expect(n.filter((x) => x.status === "sent")).toHaveLength(0)
      expect(n.filter((x) => x.status === "previewed")).toHaveLength(1)
    }
  }, 60_000)

  it("re-processing the same job (repeated/overlapping sync, duplicate webhook) changes nothing and adds no rows", async () => {
    const before = await payoutsFor("shared")
    const notesBefore = (await Promise.all(before.map((r) => notificationsFor(r.id)))).flat().length
    const second = await runJob(raw("shared"))
    expect(second.engine.created).toBe(0)
    expect(second.engine.updated).toBe(0)
    expect(second.engine.unchanged).toBe(3)
    const after = await payoutsFor("shared")
    expect(after).toHaveLength(3)
    expect(after.map((r) => r.inputHash)).toEqual(before.map((r) => r.inputHash))
    expect(after.map((r) => r.updatedAt.getTime())).toEqual(before.map((r) => r.updatedAt.getTime()))
    const notesAfter = (await Promise.all(after.map((r) => notificationsFor(r.id)))).flat().length
    expect(notesAfter).toBe(notesBefore)
  }, 60_000)

  it("three concurrent syncs of a brand-new job cannot create duplicate payouts", async () => {
    const results = await Promise.allSettled([runJob(raw("race")), runJob(raw("race")), runJob(raw("race"))])
    // A loser may hit the unique index; that is acceptable, a duplicate row is not.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)
    const rows = await payoutsFor("race")
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.profileId)).size).toBe(3)
  }, 60_000)

  it("payment before completion: pending while Submitted, ready once Done", async () => {
    const first = await runJob(raw("paidfirst", { Status: "Submitted", LastStatusUpdate: "2026-09-10 09:05:00" }))
    expect(first.engine.created).toBe(3)
    let rows = await payoutsFor("paidfirst")
    for (const r of rows) {
      expect(r.status).toBe("pending")
      expect(r.holdReason).toMatch(/not payable/)
    }
    const second = await runJob(raw("paidfirst"))
    expect(second.engine.updated).toBe(3)
    rows = await payoutsFor("paidfirst")
    for (const r of rows) expect(r.status).toBe("ready")
  }, 60_000)

  it("completion before payment: held while a deposit is outstanding, ready when the balance lands", async () => {
    const deposit = raw("doneFirst", { Payments: [{ id: "dep", Amount: 500, Method: "Visa" }] })
    await runJob(deposit)
    let rows = await payoutsFor("doneFirst")
    for (const r of rows) {
      expect(r.status).toBe("hold")
      expect(r.holdReason).toBe("Job is not fully paid")
    }
    await runJob(raw("doneFirst", { Payments: [{ id: "dep", Amount: 500, Method: "Visa" }, { id: "bal", Amount: 1300, Method: "Check" }, { id: "tip", Amount: 100, Method: "Check", IsTip: true }] }))
    rows = await payoutsFor("doneFirst")
    for (const r of rows) expect(r.status).toBe("ready")
    const a = rows.find((r) => r.profileId === ids.A)!
    // Card share 500/1800 of the crew base 1350 = 375 card, 975 non-card; color 450 of 1350.
    expect(money(a.cardServiceAmount)).toBe(375)
    expect(money(a.nonCardServiceAmount)).toBe(975)
    expect(money(a.nonCardTipAmount)).toBe(100)
  }, 60_000)

  it("live Workiz shape (no Payments array): a zero balance proves paid but the method is unknown, so the payout is held for review, not paid as non-card", async () => {
    await runJob(raw("balanceOnly", { Payments: undefined, JobAmountDue: 0 }))
    const rows = await payoutsFor("balanceOnly")
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.status).toBe("hold")
      expect(r.holdReason).toMatch(/^Payment method unknown/)
    }
  }, 60_000)

  it("an unmapped team member holds the mapped technicians' payouts and surfaces the id for mapping", async () => {
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
    const { eq } = m.orm
    const [mapping] = await m.db.select().from(m.schema.workizTeamMappings).where(eq(m.schema.workizTeamMappings.workizTeamId, TEAM.UNMAPPED))
    expect(mapping).toBeTruthy()
    expect(mapping.profileId).toBeNull()
    expect(mapping.workizName).toBe("Audit Newcomer")
    const n = await notificationsFor(rows[0].id)
    expect(n.every((x) => x.status !== "sent")).toBe(true)
  }, 60_000)

  it("paid and void payouts are never overwritten by later Workiz changes; reopen forces a recompute", async () => {
    const { eq } = m.orm
    let rows = await payoutsFor("shared")
    const a = rows.find((r) => r.profileId === ids.A)!
    const b = rows.find((r) => r.profileId === ids.B)!
    await m.db.update(m.schema.payouts).set({ status: "paid", paidAt: new Date(), paidBy: "audit" }).where(eq(m.schema.payouts.id, a.id))
    await m.db.update(m.schema.payouts).set({ status: "void" }).where(eq(m.schema.payouts.id, b.id))

    // Post-calculation change in Workiz: the discount grows to 400.
    const changed = raw("shared", { JobTotalPrice: 1600, LineItems: [...raw("shared").LineItems.slice(0, 3), { Name: "discount", Price: 400, Quantity: 1, Type: "DISCOUNT_TYPE" }], Payments: [{ id: "shared-p1", Amount: 1600, Method: "Credit Card" }, { id: "shared-p2", Amount: 100, Method: "Credit Card", IsTip: true }] })
    const result = await runJob(changed)
    expect(result.engine.updated).toBe(1) // Tim only
    expect(result.engine.unchanged).toBe(2)
    expect(result.engine.notes.some((n) => n.includes("is paid but Workiz data changed"))).toBe(true)
    expect(result.engine.notes.some((n) => n.includes("is void but Workiz data changed"))).toBe(true)

    rows = await payoutsFor("shared")
    const a2 = rows.find((r) => r.profileId === ids.A)!
    const b2 = rows.find((r) => r.profileId === ids.B)!
    const tim2 = rows.find((r) => r.profileId === ids.TIM)!
    expect(a2.status).toBe("paid")
    expect(money(a2.totalPayout)).toBe(330.51)
    expect(b2.status).toBe("void")
    // Tim: 500 * (1600/2000) = 400 -> 400*.965*.8 = 308.80
    expect(money(tim2.totalPayout)).toBe(308.8)

    // Reopen clears the fingerprint so the next sync recomputes on the current data.
    await m.db.update(m.schema.payouts).set({ status: "pending", paidAt: null, paidBy: null, inputHash: null }).where(eq(m.schema.payouts.id, a.id))
    const again = await runJob(changed)
    expect(again.engine.updated).toBe(1)
    const a3 = (await payoutsFor("shared")).find((r) => r.profileId === ids.A)!
    // A: 800*.965*.2 + 400*.965*.25 + 48.25 = 154.40 + 96.50 + 48.25 = 299.15
    expect(money(a3.totalPayout)).toBe(299.15)
    expect(a3.status).toBe("ready")
  }, 60_000)

  it("dry-run delivery: sends once, never twice, never for held payouts, and the message carries the payout details", async () => {
    await m.settings.saveNotificationSettings({ sendEnabled: true, channel: "workiz_note" }, "audit")
    const delivered: string[] = []
    const deliver = async ({ message }: { message: string }) => {
      delivered.push(message)
      return { mocked: true }
    }

    const ready = (await payoutsFor("paidfirst")).find((r) => r.profileId === ids.A)!
    const first = await m.send.notifyPayout(ready.id, { deliver })
    expect(first.status).toBe("sent")
    expect(delivered).toHaveLength(1)
    expect(first.message).toContain(`${RUN} Reg A`)
    expect(first.message).toContain("330.51")
    expect(first.message).toContain(`${RUN}-paidfirst`)

    const second = await m.send.notifyPayout(ready.id, { deliver })
    expect(second.status).toBe("skipped")
    expect(second.reason).toBe("Already sent")
    expect(delivered).toHaveLength(1)

    // Two syncs racing to deliver the same payout: exactly one wins.
    const other = (await payoutsFor("paidfirst")).find((r) => r.profileId === ids.B)!
    const race = await Promise.all([m.send.notifyPayout(other.id, { deliver }), m.send.notifyPayout(other.id, { deliver })])
    expect(race.filter((r) => r.status === "sent")).toHaveLength(1)
    expect(race.filter((r) => r.status === "skipped")).toHaveLength(1)
    expect(delivered).toHaveLength(2)
    const sentRows = (await notificationsFor(other.id)).filter((n) => n.status === "sent")
    expect(sentRows).toHaveLength(1)

    // Held payouts only preview, even with sending enabled.
    const held = (await payoutsFor("balanceOnly"))[0]
    const heldOutcome = await m.send.notifyPayout(held.id, { deliver })
    expect(heldOutcome.status).toBe("previewed")
    expect(heldOutcome.reason).toBe("Payout status is hold")
    expect(delivered).toHaveLength(2)

    // A later data change re-syncs the payout but does not re-send the text.
    await runJob(raw("paidfirst", { JobTotalPrice: 1700, LineItems: [...raw("paidfirst").LineItems.slice(0, 3), { Name: "discount", Price: 300, Quantity: 1, Type: "DISCOUNT_TYPE" }], Payments: [{ id: "paidfirst-p1", Amount: 1700, Method: "Credit Card" }, { id: "paidfirst-p2", Amount: 100, Method: "Credit Card", IsTip: true }] }))
    const afterChange = (await notificationsFor(ready.id)).filter((n) => n.status === "sent")
    expect(afterChange).toHaveLength(1)

    // An explicit admin re-send is allowed once and keeps the earlier delivery in history.
    const forced = await m.send.notifyPayout(ready.id, { deliver, force: true })
    expect(forced.status).toBe("sent")
    const history = await notificationsFor(ready.id)
    expect(history.filter((n) => n.status === "resent")).toHaveLength(1)
    expect(history.filter((n) => n.status === "sent")).toHaveLength(1)

    await m.settings.saveNotificationSettings({ sendEnabled: false }, "audit")
  }, 90_000)
})
