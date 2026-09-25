import { describe, expect, it } from "vitest"
import type { TechnicianProfile } from "@/lib/db/schema"
import { CARD_FEE_RATE, calcPayoutWithCardShare, cardShareOf, serviceFactorFor, toCents } from "@/lib/payout/calculator"
import { addCompanions } from "@/lib/payout/companions"
import { computeForProfile, gateReason, invoiceCardFee } from "@/lib/payout/engine"
import { normalizeWorkType, planSegments, workTypeMatches, type PlannableProfile, type SegmentPlan } from "@/lib/payout/segments"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { PAYMENT_METHOD_UNKNOWN_PREFIX, TIP_METHOD_UNCLEAR_PREFIX, UNITEMIZED_SURPLUS_PREFIX, normalizeJob, type NormalizedJob } from "@/lib/workiz/normalize"
import { TIP_INCLUSION_RAW_KEY, externalRowsToPayments } from "@/lib/workiz/payments"

/**
 * Synthetic fixtures for the 2026-09-23 payout corrections. Every expected
 * number is a hand-computed literal:
 *   commission = discounted eligible amount x (1 - cardShare x 3.5%) x rate
 *   cardShare  = card-paid service dollars / discounted service subtotal (invoice-wide)
 *   tips       = business-held tip x (fee only on the card-paid part) / regular technicians
 * Rates are test profiles shaped like the confirmed roster; no real profile is read.
 */
const settings = DEFAULT_WORKIZ_SETTINGS
const noCatalog = new Map<string, boolean>()
const cents = toCents

type Tech = PlannableProfile & Pick<TechnicianProfile, "nonColorRate" | "colorRate" | "tipShare" | "separateColorSeal">
const tech = (id: number, name: string, nonColor: number, color: number, extra: Partial<Tech> = {}): Tech => ({
  id,
  name,
  lineItemMarker: null,
  ownedWorkType: null,
  nonColorRate: nonColor.toFixed(6),
  colorRate: color.toFixed(6),
  tipShare: "0.500000",
  separateColorSeal: true,
  ...extra,
})

const ARTHUR = tech(3, "Arthur", 0.2, 0.25)
const VIKTOR = tech(4, "Viktor", 0.2, 0.25)
const VADIM = tech(1, "Vadim", 0.25, 0.25)
const DENIS = tech(2, "Denis", 0.2, 0.25)
const TIM = tech(5, "Tim", 0.8, 0.8, { lineItemMarker: "T", ownedWorkType: "Tim's Job", tipShare: "0.000000", separateColorSeal: false })
const ROSTER: Tech[] = [VADIM, DENIS, ARTHUR, VIKTOR, TIM]

const TEAM = { arthur: { id: "9003", Name: "Arthur" }, viktor: { id: "9004", Name: "Viktor" }, tim: { id: "9005", Name: "Tim" }, vadim: { id: "9001", Name: "Vadim" } }

/** What the engine does per technician: invoice-wide card share + the plan's tip share. */
function payoutFor(job: NormalizedJob, plan: SegmentPlan, t: Tech) {
  const segment = plan.segmentFor.get(t.id)
  if (!segment) throw new Error(`${t.name} is not on the plan`)
  return computeForProfile(segment, t as unknown as TechnicianProfile, { tipShare: plan.tipShareFor.get(t.id) ?? 0, cardServiceShare: cardShareOf(job.cardServiceAmount, job.jobTotal) })
}

const raw760 = (over: Record<string, unknown> = {}) => ({
  UUID: "FIX-760",
  SerialId: "924878-synthetic",
  Status: "Done",
  JobType: "Work",
  Team: [TEAM.arthur, TEAM.viktor],
  SubTotal: 760,
  JobTotalPrice: 760,
  JobAmountDue: 0,
  LineItems: [
    { Name: "Restorative Tile & Grout Floor Cleaning (Bathroom 1)", Price: 289.02, Quantity: 1, Type: "service" },
    { Name: "Restorative Tile & Grout Floor Cleaning (Bathroom 2)", Price: 177.3, Quantity: 1, Type: "service" },
    { Name: "Shower Tile And Grout Deep Cleaning Service", Price: 108.68, Quantity: 1, Type: "service" },
    { Name: "Grout Color Sealing – Floors", Price: 185, Quantity: 1, Type: "service" },
  ],
  Payments: [
    { id: "dep", Amount: 172.5, Method: "Visa", Date: "2026-09-15 10:30:00" },
    { id: "bal", Amount: 587.5, Method: "Check", Date: "2026-09-23 14:00:00" },
  ],
  ...over,
})

describe("Fixture 1: mixed card/check, ordinary job ($575 regular + $185 color; $172.50 card + $587.50 check)", () => {
  const job = normalizeJob(raw760(), settings, noCatalog)

  it("normalizes the invoice: S = 760, C = 172.50, color 185, no discount, fully paid", () => {
    expect(job.jobTotal).toBe(760)
    expect(job.colorSealTotal).toBe(185)
    expect(job.discountAmount).toBe(0)
    expect(job.cardServiceAmount).toBe(172.5)
    expect(job.nonCardServiceAmount).toBe(587.5)
    expect(job.cardTipAmount + job.nonCardTipAmount).toBe(0)
    expect(job.fullyPaid).toBe(true)
    expect(gateReason(job, settings)).toBeNull()
  })

  it("derives one invoice-wide card factor: 22.6973684211% card, fee $6.0375 -> $6.04, reduction 0.7944078947%, adjusted $753.9625 -> $753.96", () => {
    const fee = invoiceCardFee(job)
    expect(fee.cardShare).toBeCloseTo(0.226973684211, 12)
    expect(fee.fee).toBeCloseTo(6.0375, 12)
    expect(cents(fee.fee)).toBe(6.04)
    expect(1 - fee.serviceFactor).toBeCloseTo(0.007944078947, 12)
    expect(fee.adjustedServiceSubtotal).toBeCloseTo(753.9625, 10)
    expect(cents(fee.adjustedServiceSubtotal)).toBe(753.96)
    expect(fee.feeRate).toBe(CARD_FEE_RATE)
  })

  it("a standard 20%/25% technician receives $159.97 (from $161.25 before the fee), each of them, undivided", () => {
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    expect(plan.warnings).toEqual([])
    const arthur = payoutFor(job, plan, ARTHUR)
    const viktor = payoutFor(job, plan, VIKTOR)
    // Pre-fee: 575 x 0.20 + 185 x 0.25 = 115 + 46.25 = 161.25; x 0.99205592105 = 159.969...
    expect(arthur.basePayout + 0).toBeCloseTo(161.25 * serviceFactorFor(172.5 / 760), 9)
    expect(cents(arthur.totalPayout)).toBe(159.97)
    expect(cents(viktor.totalPayout)).toBe(159.97)
    expect(arthur.mode).toBe("split")
    expect(plan.segmentFor.get(ARTHUR.id)!.jobTotal).toBe(760)
    expect(plan.segmentFor.get(VIKTOR.id)!.jobTotal).toBe(760)
  })

  it("Vadim at 25%/25% receives $188.49 on the same invoice-wide factor", () => {
    const withVadim = normalizeJob(raw760({ Team: [TEAM.vadim] }), settings, noCatalog)
    const plan = planSegments(withVadim, [VADIM], ROSTER)
    // 760 x 0.25 = 190 x 0.99205592105 = 188.4906...
    expect(cents(payoutFor(withVadim, plan, VADIM).totalPayout)).toBe(188.49)
  })

  it("is not what the per-portion or whole-card shortcuts would give", () => {
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    const total = cents(payoutFor(job, plan, ARTHUR).totalPayout)
    expect(total).not.toBe(161.25) // fee ignored
    expect(total).not.toBe(cents(161.25 * 0.965)) // whole job treated as card
    expect(total).not.toBe(cents(161.25 / 2)) // divided by head count
  })
})

describe("Fixture 2: Work Type \"Tim's Job\" gives Tim the whole $760 at 80%", () => {
  const timsJob = (over: Record<string, unknown> = {}) => normalizeJob(raw760({ JobType: "Tim's Job", Team: [TEAM.tim, TEAM.arthur, TEAM.viktor], ...over }), settings, noCatalog)

  it("Tim receives $603.17 including the color-sealing line; regular crew earns no service commission", () => {
    const job = timsJob()
    const plan = planSegments(job, [TIM, ARTHUR, VIKTOR], ROSTER)
    expect(plan.warnings).toEqual([])
    const tim = plan.segmentFor.get(TIM.id)!
    expect(tim.kind).toBe("dedicated")
    expect(tim.ownership).toBe("work-type")
    expect(tim.workType).toBe("Tim's Job")
    expect(tim.jobTotal).toBe(760)
    expect(tim.itemIndexes).toEqual([0, 1, 2, 3])
    // 760 x 0.80 = 608 x 0.99205592105 = 603.17
    expect(cents(payoutFor(job, plan, TIM).totalPayout)).toBe(603.17)

    for (const t of [ARTHUR, VIKTOR]) {
      const seg = plan.segmentFor.get(t.id)!
      expect(seg.kind).toBe("crew")
      expect(seg.jobTotal).toBe(0)
      expect(seg.itemIndexes).toEqual([])
      expect(payoutFor(job, plan, t).totalPayout).toBe(0)
    }
    expect(plan.segmentation.verification.balanced).toBe(true)
    expect(plan.segmentation.verification.doubleCountedItems).toBe(0)
  })

  it("gives the same result with or without *T* markers on the items (services counted once)", () => {
    const marked = timsJob({
      LineItems: [
        { Name: "Restorative Tile & Grout Floor Cleaning (Bathroom 1) *T*", Price: 289.02, Quantity: 1, Type: "service" },
        { Name: "Restorative Tile & Grout Floor Cleaning (Bathroom 2)", Price: 177.3, Quantity: 1, Type: "service" },
        { Name: "* T * Shower Tile And Grout Deep Cleaning Service", Price: 108.68, Quantity: 1, Type: "service" },
        { Name: "Grout Color Sealing – Floors *T*", Price: 185, Quantity: 1, Type: "service" },
      ],
    })
    const plan = planSegments(marked, [TIM, ARTHUR, VIKTOR], ROSTER)
    expect(plan.warnings).toEqual([])
    expect(plan.segmentFor.get(TIM.id)!.jobTotal).toBe(760)
    expect(cents(payoutFor(marked, plan, TIM).totalPayout)).toBe(603.17)
    expect(payoutFor(marked, plan, ARTHUR).totalPayout).toBe(0)
  })

  it("matches the Work Type regardless of case, surrounding whitespace and curly apostrophes, but not job status, tags or notes", () => {
    for (const v of ["Tim's Job", "  tim's job ", "TIM\u2019S JOB", "Tim\u2019s  Job", "Tim\u2018s Job"]) {
      expect(workTypeMatches(v, "Tim's Job"), v).toBe(true)
      const plan = planSegments(timsJob({ JobType: v }), [TIM, ARTHUR], ROSTER)
      expect(plan.segmentFor.get(TIM.id)!.ownership, v).toBe("work-type")
    }
    expect(normalizeWorkType("Tim\u2019s  Job ")).toBe("tim's job")
    for (const v of ["Timothy's Job", "Tim Job", "Work", "Tim's", null, ""]) expect(workTypeMatches(v, "Tim's Job"), String(v)).toBe(false)

    // Status / tags / description saying "Tim's Job" never make it Tim's job.
    const decoy = normalizeJob(raw760({ Status: "Tim's Job", Tags: ["Tim's Job"], JobNotes: "Tim's Job", Team: [TEAM.tim, TEAM.arthur] }), settings, noCatalog)
    expect(decoy.jobType).toBe("Work")
    const plan = planSegments(decoy, [TIM, ARTHUR], ROSTER)
    expect(plan.segmentFor.get(TIM.id)!.ownership).not.toBe("work-type")
  })

  it("flags a Tim's Job when Tim is not assigned in Workiz, and still pays the crew nothing on it", () => {
    const job = timsJob({ Team: [TEAM.arthur, TEAM.viktor] })
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    expect(plan.warnings.some((w) => w.includes("Tim is not assigned to this job"))).toBe(true)
    expect(gateReason(job, settings, plan.warnings)).not.toBeNull()
    expect(plan.segmentFor.get(ARTHUR.id)!.jobTotal).toBe(0)
  })

  it("pairing never overrides whole-job ownership: Denis rides with Vadim onto a Tim's Job and both earn nothing", () => {
    const job = timsJob({ Team: [TEAM.tim, TEAM.vadim] })
    const { profiles, added } = addCompanions([TIM, VADIM].map((t) => ({ ...t, active: true, worksWithProfileId: t.id === DENIS.id ? VADIM.id : null })), ROSTER.map((t) => ({ ...t, active: true, worksWithProfileId: t.id === DENIS.id ? VADIM.id : null })))
    expect(added.map((a) => a.companion.name)).toEqual(["Denis"])
    const plan = planSegments(job, profiles, ROSTER)
    expect(cents(payoutFor(job, plan, TIM).totalPayout)).toBe(603.17)
    expect(payoutFor(job, plan, VADIM).totalPayout).toBe(0)
    expect(payoutFor(job, plan, DENIS).totalPayout).toBe(0)
  })

  it("job-level and item-level discounts reduce Tim's base exactly once", () => {
    const job = timsJob({
      SubTotal: 760,
      JobTotalPrice: 700,
      LineItems: [...raw760().LineItems, { Name: "discount", Price: 60, Quantity: 1, Type: "DISCOUNT_TYPE" }],
      Payments: [{ id: "p", Amount: 700, Method: "Check" }],
    })
    expect(job.jobTotal).toBe(700)
    expect(job.discountAmount).toBe(60)
    const plan = planSegments(job, [TIM], ROSTER)
    expect(plan.segmentFor.get(TIM.id)!.jobTotal).toBe(700)
    // 700 x 0.80, non-card
    expect(cents(payoutFor(job, plan, TIM).totalPayout)).toBe(560)
  })
})

describe("Fixture 3: shared job ($600 regular + $200 crew color + $200 *T* items, $100 business-held tip, all check)", () => {
  const shared = (over: Record<string, unknown> = {}) =>
    normalizeJob(
      {
        UUID: "FIX-SHARED",
        Status: "Done",
        JobType: "Work",
        Team: [TEAM.arthur, TEAM.viktor, TEAM.tim],
        SubTotal: 1000,
        JobTotalPrice: 1000,
        LineItems: [
          { Name: "Regrout master bath", Price: 600, Quantity: 1, Type: "service" },
          { Name: "Grout Color Sealing – Floors", Price: 200, Quantity: 1, Type: "service" },
          { Name: "Re-bond Hollow Tiles (6 tiles total) *T*", Price: 120, Quantity: 1, Type: "service" },
          { Name: "Walk-in Master Shower Re-Grouting *T*", Price: 80, Quantity: 1, Type: "service" },
        ],
        Payments: [
          { id: "p1", Amount: 1000, Method: "Check" },
          { id: "tip", Amount: 100, Method: "Check", IsTip: true },
        ],
        ...over,
      },
      settings,
      noCatalog,
    )

  it("Arthur $220.00, Viktor $220.00, Tim $160.00; Tim is excluded from the tip and its divisor", () => {
    const job = shared()
    expect(job.jobTotal).toBe(1000)
    expect(job.colorSealTotal).toBe(200)
    expect(job.nonCardTipAmount).toBe(100)
    const plan = planSegments(job, [ARTHUR, VIKTOR, TIM], ROSTER)
    expect(plan.warnings).toEqual([])

    const crew = plan.segmentFor.get(ARTHUR.id)!
    expect(crew.kind).toBe("crew")
    expect(crew.ownership).toBe("crew")
    expect(crew.jobTotal).toBe(800)
    expect(crew.colorSealTotal).toBe(200)
    const tim = plan.segmentFor.get(TIM.id)!
    expect(tim.kind).toBe("dedicated")
    expect(tim.ownership).toBe("marker")
    expect(tim.jobTotal).toBe(200)

    expect(plan.tips.total).toBe(100)
    expect(plan.tips.recipients.map((r) => r.name)).toEqual(["Arthur", "Viktor"])
    expect(plan.tips.share).toBe(0.5)
    expect(plan.tips.excluded.map((e) => e.name)).toEqual(["Tim"])
    expect(plan.tipShareFor.get(TIM.id)).toBe(0)

    // Arthur: 600 x 0.20 + 200 x 0.25 + 100 / 2 = 120 + 50 + 50
    const arthur = payoutFor(job, plan, ARTHUR)
    expect(cents(arthur.totalPayout)).toBe(220)
    expect(arthur.tipPayout).toBe(50)
    expect(cents(payoutFor(job, plan, VIKTOR).totalPayout)).toBe(220)
    // Tim: 200 x 0.80, no tip
    const timPay = payoutFor(job, plan, TIM)
    expect(cents(timPay.totalPayout)).toBe(160)
    expect(timPay.tipPayout).toBe(0)
    expect(plan.segmentation.verification.balanced).toBe(true)
  })

  it("a Tim-marked color-sealing item is paid at Tim's 80%, never at the crew's 25%", () => {
    const job = shared({
      LineItems: [
        { Name: "Regrout master bath", Price: 600, Quantity: 1, Type: "service" },
        { Name: "Grout Color Sealing – Floors", Price: 200, Quantity: 1, Type: "service" },
        { Name: "Grout Color Sealing – Shower *T*", Price: 200, Quantity: 1, Type: "service" },
      ],
    })
    expect(job.colorSealTotal).toBe(400)
    const plan = planSegments(job, [ARTHUR, VIKTOR, TIM], ROSTER)
    expect(plan.segmentFor.get(ARTHUR.id)!.colorSealTotal).toBe(200)
    expect(plan.segmentFor.get(TIM.id)!.colorSealTotal).toBe(200)
    expect(cents(payoutFor(job, plan, TIM).totalPayout)).toBe(160)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(220)
  })

  it("ordinary T / Tim text does not claim an item; only the delimited marker does", () => {
    const job = shared({
      LineItems: [
        { Name: "Tile & Grout cleaning", Price: 300, Quantity: 1, Type: "service" },
        { Name: "Tim recommended sealer", Price: 300, Quantity: 1, Type: "service" },
        { Name: "T-shaped trim caulk", Price: 200, Quantity: 1, Type: "service" },
        { Name: "Shower re-grout * T *", Price: 200, Quantity: 1, Type: "service" },
      ],
    })
    const plan = planSegments(job, [ARTHUR, VIKTOR, TIM], ROSTER)
    expect(plan.warnings).toEqual([])
    expect(plan.segmentFor.get(TIM.id)!.itemNames).toEqual(["Shower re-grout * T *"])
    expect(plan.segmentFor.get(ARTHUR.id)!.jobTotal).toBe(800)
  })

  it("Denis pairs with Vadim on the crew portion: Vadim 25%/25%, Denis 20%/25%, tip halved between them only", () => {
    const job = shared({ Team: [TEAM.vadim, TEAM.tim] })
    const withPairing = (t: Tech) => ({ ...t, active: true, worksWithProfileId: t.id === DENIS.id ? VADIM.id : null })
    const { profiles } = addCompanions([VADIM, TIM].map(withPairing), ROSTER.map(withPairing))
    expect(profiles.map((p) => p.name)).toEqual(["Vadim", "Tim", "Denis"])
    const plan = planSegments(job, profiles, ROSTER)
    expect(plan.tips.recipients.map((r) => r.name).sort()).toEqual(["Denis", "Vadim"])
    // Vadim: 800 x 0.25 + 50 = 250 ; Denis: 600 x 0.20 + 200 x 0.25 + 50 = 220 ; Tim 160
    expect(cents(payoutFor(job, plan, VADIM).totalPayout)).toBe(250)
    expect(cents(payoutFor(job, plan, DENIS).totalPayout)).toBe(220)
    expect(cents(payoutFor(job, plan, TIM).totalPayout)).toBe(160)
    // Denis is included exactly once even if Workiz also lists him.
    const listed = addCompanions([VADIM, DENIS, TIM].map(withPairing), ROSTER.map(withPairing))
    expect(listed.profiles.filter((p) => p.id === DENIS.id)).toHaveLength(1)
    expect(listed.added).toEqual([])
  })

  it("a tip with no regular technician on the job is flagged, never handed to Tim or dropped", () => {
    const job = shared({ Team: [TEAM.tim], LineItems: [{ Name: "Shower re-grout *T*", Price: 1000, Quantity: 1, Type: "service" }] })
    const plan = planSegments(job, [TIM], ROSTER)
    expect(plan.tips.needsReview).toMatch(/Tip allocation needs review/)
    expect(gateReason(job, settings, plan.warnings)).toMatch(/Tip allocation needs review/)
    expect(payoutFor(job, plan, TIM).tipPayout).toBe(0)
    expect(plan.tips.total).toBe(100)
  })
})

describe("Fixture 4: original calculator baseline ($1,000 incl. $500 color, $100 tip, two regular technicians)", () => {
  const baseline = (method: string) =>
    normalizeJob(
      {
        UUID: "FIX-BASE",
        Status: "Done",
        Team: [TEAM.arthur, TEAM.viktor],
        SubTotal: 1000,
        JobTotalPrice: 1000,
        LineItems: [
          { Name: "Regrout", Price: 500, Quantity: 1, Type: "service" },
          { Name: "Grout Color Sealing", Price: 500, Quantity: 1, Type: "service" },
        ],
        Payments: [
          { id: "p1", Amount: 1000, Method: method },
          { id: "tip", Amount: 100, Method: method, IsTip: true },
        ],
      },
      settings,
      noCatalog,
    )

  it("non-card: each receives $275.00 (legacy path)", () => {
    const job = baseline("Check")
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    expect(plan.tips.share).toBe(0.5)
    const r = payoutFor(job, plan, ARTHUR)
    expect(cents(r.totalPayout)).toBe(275)
    expect(r.mode).toBe("legacy-non-card")
    expect(cents(payoutFor(job, plan, VIKTOR).totalPayout)).toBe(275)
  })

  it("all-card: each receives $265.38 (legacy path)", () => {
    const job = baseline("Visa")
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    const r = payoutFor(job, plan, ARTHUR)
    expect(r.totalPayout).toBeCloseTo(265.375, 9)
    expect(cents(r.totalPayout)).toBe(265.38)
    expect(r.mode).toBe("legacy-card")
  })

  it("three regular technicians split the tip three ways; service commission is never divided", () => {
    const job = normalizeJob({ ...baselineRaw("Check"), Team: [TEAM.arthur, TEAM.viktor, TEAM.vadim] }, settings, noCatalog)
    const plan = planSegments(job, [ARTHUR, VIKTOR, VADIM], ROSTER)
    expect(plan.tips.share).toBeCloseTo(1 / 3, 12)
    const arthur = payoutFor(job, plan, ARTHUR)
    expect(arthur.basePayout).toBe(225)
    expect(arthur.tipPayout).toBeCloseTo(100 / 3, 9)
    expect(cents(payoutFor(job, plan, VADIM).totalPayout)).toBe(cents(250 + 100 / 3))
  })

  function baselineRaw(method: string) {
    return {
      UUID: "FIX-BASE-3",
      Status: "Done",
      SubTotal: 1000,
      JobTotalPrice: 1000,
      LineItems: [
        { Name: "Regrout", Price: 500, Quantity: 1, Type: "service" },
        { Name: "Grout Color Sealing", Price: 500, Quantity: 1, Type: "service" },
      ],
      Payments: [
        { id: "p1", Amount: 1000, Method: method },
        { id: "tip", Amount: 100, Method: method, IsTip: true },
      ],
    }
  }
})

describe("Card fee distribution details", () => {
  it("multiple card payments and a check are summed into one card share; a duplicate sync of the same payment is ignored", () => {
    const payments = [
      { id: "d1", Amount: 100, Method: "Visa" },
      { id: "d2", Amount: 72.5, Method: "Mastercard" },
      { id: "bal", Amount: 587.5, Method: "Check" },
    ]
    const once = normalizeJob(raw760({ Payments: payments }), settings, noCatalog)
    const twice = normalizeJob(raw760({ Payments: [...payments, ...payments] }), settings, noCatalog)
    expect(once.cardServiceAmount).toBe(172.5)
    expect(twice.cardServiceAmount).toBe(172.5)
    expect(twice.totalPaid).toBe(760)
    expect(cents(payoutFor(twice, planSegments(twice, [ARTHUR, VIKTOR], ROSTER), ARTHUR).totalPayout)).toBe(159.97)
  })

  it("uses the same invoice-wide factor for the crew and for Tim's marked items", () => {
    const job = normalizeJob(
      {
        UUID: "FIX-FACTOR",
        Status: "Done",
        Team: [TEAM.arthur, TEAM.tim],
        SubTotal: 1000,
        JobTotalPrice: 1000,
        LineItems: [
          { Name: "Regrout", Price: 800, Quantity: 1, Type: "service" },
          { Name: "Shower re-grout *T*", Price: 200, Quantity: 1, Type: "service" },
        ],
        Payments: [
          { id: "c", Amount: 400, Method: "Visa" },
          { id: "k", Amount: 600, Method: "Check" },
        ],
      },
      settings,
      noCatalog,
    )
    const plan = planSegments(job, [ARTHUR, TIM], ROSTER)
    const factor = serviceFactorFor(0.4) // 1 - 0.4 x 0.035 = 0.986
    expect(factor).toBeCloseTo(0.986, 12)
    const arthur = payoutFor(job, plan, ARTHUR)
    const tim = payoutFor(job, plan, TIM)
    expect(arthur.serviceFactor).toBeCloseTo(factor, 12)
    expect(tim.serviceFactor).toBeCloseTo(factor, 12)
    expect(cents(arthur.totalPayout)).toBe(cents(800 * factor * 0.2)) // 157.76
    expect(cents(tim.totalPayout)).toBe(cents(200 * factor * 0.8)) // 157.76
    // Not the segment's own card dollars against its own total (would be the same here only by coincidence of proportional allocation).
    expect(arthur.cardServiceShare).toBeCloseTo(0.4, 12)
  })

  it("card tips carry the fee, other tips do not, and the service factor is never applied to a tip", () => {
    const job = normalizeJob(
      raw760({
        Payments: [
          { id: "dep", Amount: 172.5, Method: "Visa" },
          { id: "bal", Amount: 587.5, Method: "Check" },
          { id: "t1", Amount: 40, Method: "Visa", IsTip: true },
          { id: "t2", Amount: 60, Method: "Cash", IsTip: true },
        ],
      }),
      settings,
      noCatalog,
    )
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    const r = payoutFor(job, plan, ARTHUR)
    expect(r.cardTipPayout).toBeCloseTo(40 * 0.965 * 0.5, 10)
    expect(r.nonCardTipPayout).toBeCloseTo(30, 10)
    expect(cents(r.totalPayout)).toBe(cents(161.25 * serviceFactorFor(172.5 / 760) + 19.3 + 30))
  })

  it("a tip that is an invoice line on a mixed-method invoice is split and held for review, not given the dominant method", () => {
    const job = normalizeJob(
      raw760({
        SubTotal: 860,
        JobTotalPrice: 860,
        LineItems: [...raw760().LineItems, { Name: "Tip", Price: 100, Quantity: 1, Type: "service" }],
        Payments: [
          { id: "dep", Amount: 272.5, Method: "Visa" },
          { id: "bal", Amount: 587.5, Method: "Check" },
        ],
      }),
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(760)
    expect(job.cardTipAmount + job.nonCardTipAmount).toBe(100)
    expect(job.warnings.some((w) => w.startsWith(TIP_METHOD_UNCLEAR_PREFIX))).toBe(true)
    expect(gateReason(job, settings)).toMatch(TIP_METHOD_UNCLEAR_PREFIX)
  })

  it("S = 0 is explicit: card share 0, factor 1, and the job is held as zero", () => {
    expect(cardShareOf(100, 0)).toBe(0)
    expect(serviceFactorFor(0)).toBe(1)
    expect(serviceFactorFor(1)).toBeCloseTo(0.965, 12)
    expect(serviceFactorFor(2)).toBeCloseTo(0.965, 12) // clamped
    const r = calcPayoutWithCardShare({ jobTotal: 0, colorSealTotal: 0, cardServiceShare: 0, cardTip: 0, nonCardOwedTip: 0 }, { nonColorRate: 0.2, colorRate: 0.25 }, { separateColorSeal: true, tipShare: 0.5 })
    expect(r.totalPayout).toBe(0)
    const zero = normalizeJob(raw760({ SubTotal: 0, JobTotalPrice: 0, LineItems: [], Payments: [] }), settings, noCatalog)
    expect(zero.jobTotal).toBe(0)
    expect(zero.warnings).toContain("Job total is zero")
    expect(gateReason(zero, settings)).not.toBeNull()
    expect(invoiceCardFee(zero)).toMatchObject({ cardShare: 0, serviceFactor: 1, fee: 0, adjustedServiceSubtotal: 0 })
  })

  it("unavailable payment details hold the payout for review instead of inventing a card share", () => {
    const job = normalizeJob(raw760({ Payments: undefined, JobAmountDue: 0 }), settings, noCatalog)
    expect(job.payments).toEqual([])
    expect(job.paidEvidence).toBe("balance")
    expect(job.warnings.some((w) => w.startsWith(PAYMENT_METHOD_UNKNOWN_PREFIX))).toBe(true)
    expect(gateReason(job, settings)).toMatch(PAYMENT_METHOD_UNKNOWN_PREFIX)
    // The provisional figure is the fee-free $161.25; the real one needs the payment split.
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(161.25)
    expect(invoiceCardFee(job).cardShare).toBe(0)
  })

  it("an unrecognised payment method is held, never defaulted to cash", () => {
    const job = normalizeJob(raw760({ Payments: [{ id: "x", Amount: 760, Method: "Barter" }] }), settings, noCatalog)
    expect(job.warnings.some((w) => w.startsWith(PAYMENT_METHOD_UNKNOWN_PREFIX))).toBe(true)
    expect(gateReason(job, settings)).not.toBeNull()
  })
})

describe("Fixture 5: live job #924884 — $2,376.06 less 5% discount, all card, $231.67 card tip inside the final charge", () => {
  // Workiz's invoice: Subtotal 2,376.06, Discount 118.80, Tax 0.00, Tip 231.67, Total 2,488.93.
  // Payments tab: 712.82 card deposit, 1,776.11 card final (the tip rode on it). Arthur and Viktor 20%/25%.
  const raw924884 = {
    UUID: "1N6S4G",
    SerialId: "924884",
    Status: "Done",
    JobType: "Estimate",
    Team: [TEAM.arthur, TEAM.viktor],
    SubTotal: 2376.06,
    JobTotalPrice: 2488.93,
    JobAmountDue: 0,
    LineItems: [
      { Name: "Restorative Tile & Grout Floor Cleaning (All Areas)", Type: "service", Price: 677.69, Qty: 1 },
      { Name: "Grout Color Sealing – Floors (All Areas)", Type: "service", Price: 948.37, Qty: 1 },
      { Name: "Shower Tile And Grout Deep Cleaning Service | Master", Type: "service", Price: 95, Qty: 1 },
      { Name: "Grout Sealing | Walk-in Shower | 2 Coats | Master", Type: "service", Price: 185, Qty: 1 },
      { Name: "Shower Tile And Grout Deep Cleaning Service | Guest Shower", Type: "service", Price: 85, Qty: 1 },
      { Name: "Grout Sealing | Walk-in Shower | 2 Coats | Guest Shower ", Type: "service", Price: 175, Qty: 1 },
      { Name: "Shower Tile And Grout Deep Cleaning Service | Guest Tub Shower", Type: "service", Price: 75, Qty: 1 },
      { Name: "Grout Sealing | Guest Tub Shower | 2 Coats", Type: "service", Price: 135, Qty: 1 },
      { Name: "discount", Type: "DISCOUNT_TYPE", Price: 118.803, Qty: 1 },
    ],
  }
  const confirmed = externalRowsToPayments(
    [
      { id: 1, externalId: null, source: "manual", method: "Card", amount: "712.82", tipAmount: "0.00", paidAt: new Date("2026-09-15T16:39:00.000Z"), recordedBy: "admin", raw: null },
      { id: 2, externalId: null, source: "manual", method: "Card", amount: "1776.11", tipAmount: "231.67", paidAt: new Date("2026-09-25T21:38:00.000Z"), recordedBy: "admin", raw: { [TIP_INCLUSION_RAW_KEY]: "included" } },
    ],
    settings.cardMethodKeywords,
  )
  const job = normalizeJob(raw924884, settings, noCatalog, { externalPayments: confirmed })

  it("normalizes to S = 2257.26 (color 900.95 / regular 1356.31), 100% card, tip 231.67 by card, paid in full, nothing blocking", () => {
    expect(job.jobTotal).toBe(2257.26)
    expect(job.colorSealTotal).toBe(900.95)
    expect(job.cardServiceAmount).toBe(2257.26)
    expect(job.cardTipAmount).toBe(231.67)
    expect(job.nonCardTipAmount).toBe(0)
    expect(job.fullyPaid).toBe(true)
    expect(job.unitemizedSurplus).toBe(0)
    expect(gateReason(job, settings)).toBeNull()
    const fee = invoiceCardFee(job)
    expect(fee.cardShare).toBe(1)
    expect(fee.serviceFactor).toBeCloseTo(1 - CARD_FEE_RATE, 12)
  })

  it("Arthur and Viktor each receive $590.90: $479.12 commission + $111.78 tip share, after the 3.5% card fee on both", () => {
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    expect(plan.warnings).toEqual([])
    for (const t of [ARTHUR, VIKTOR]) {
      const pay = payoutFor(job, plan, t)
      // (1356.31 x 0.20 + 900.95 x 0.25) x 0.965 = 496.4995 x 0.965 = 479.1220...
      expect(pay.basePayout).toBeCloseTo(496.4995 * (1 - CARD_FEE_RATE), 9)
      expect(cents(pay.basePayout)).toBe(479.12)
      // 231.67 x 0.965 / 2 = 111.7808...
      expect(pay.tipPayout).toBeCloseTo((231.67 * (1 - CARD_FEE_RATE)) / 2, 9)
      expect(cents(pay.tipPayout)).toBe(111.78)
      expect(cents(pay.totalPayout)).toBe(590.9)
    }
  })

  it("without the confirmed tip the same job is held for the $231.67 surplus and would pay only $479.12", () => {
    const noTip = normalizeJob(raw924884, settings, noCatalog, {
      externalPayments: externalRowsToPayments(
        [
          { id: 1, externalId: null, source: "manual", method: "Card", amount: "712.82", tipAmount: "0.00", paidAt: null, recordedBy: "admin", raw: null },
          { id: 2, externalId: null, source: "manual", method: "Card", amount: "1776.11", tipAmount: "0.00", paidAt: null, recordedBy: "admin", raw: null },
        ],
        settings.cardMethodKeywords,
      ),
    })
    expect(noTip.unitemizedSurplus).toBe(231.67)
    expect(gateReason(noTip, settings)).toMatch(UNITEMIZED_SURPLUS_PREFIX)
    const plan = planSegments(noTip, [ARTHUR, VIKTOR], ROSTER)
    expect(cents(payoutFor(noTip, plan, ARTHUR).totalPayout)).toBe(479.12)
  })
})
