import { describe, expect, it } from "vitest"
import { calcPayoutWithPaymentSplit, toCents } from "@/lib/payout/calculator"
import { gateReason, releaseBlocker } from "@/lib/payout/engine"
import { planSegments, type JobSegment } from "@/lib/payout/segments"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { normalizeJob } from "@/lib/workiz/normalize"

/**
 * Audit fixtures. Every expected number below was worked out by hand from the
 * agreed rules (commission after discounts, 3.5% only on the card-paid share,
 * tips split among regular technicians only) and is written as a literal, so a
 * change in the implementation cannot silently move the expectation.
 *
 * Test-only rate profiles; real technician rates are never read here.
 */
const settings = DEFAULT_WORKIZ_SETTINGS
const noCatalog = new Map<string, boolean>()

type Tech = {
  id: number
  name: string
  lineItemMarker: string | null
  rates: { nonColorRate: number; colorRate: number }
  options: { separateColorSeal: boolean; tipShare: number }
}
const REG_A: Tech = { id: 901, name: "Test Reg A", lineItemMarker: null, rates: { nonColorRate: 0.2, colorRate: 0.25 }, options: { separateColorSeal: true, tipShare: 0.5 } }
const REG_B: Tech = { id: 902, name: "Test Reg B", lineItemMarker: null, rates: { nonColorRate: 0.3, colorRate: 0.35 }, options: { separateColorSeal: true, tipShare: 0.5 } }
const TIM: Tech = { id: 903, name: "Test Tim", lineItemMarker: "T", rates: { nonColorRate: 0.8, colorRate: 0.8 }, options: { separateColorSeal: false, tipShare: 1 } }

const owners = [TIM]
const pay = (seg: JobSegment, t: Tech) =>
  calcPayoutWithPaymentSplit(
    { jobTotal: seg.jobTotal, colorSealTotal: seg.colorSealTotal, cardServiceAmount: seg.cardServiceAmount, cardTip: seg.cardTipAmount, nonCardOwedTip: seg.nonCardTipAmount },
    t.rates,
    t.options,
  )
const cents = (n: number) => toCents(n)

const TEAM_TWO_REG = [
  { id: 9001, Name: "Test Reg A" },
  { id: 9002, Name: "Test Reg B" },
]

/** $1,000 of services including $500 "Grout Color Sealing", $100 recorded tip, paid by one method. */
const thousandWithColor = (method: string) =>
  normalizeJob(
    {
      UUID: "AUDIT-F1",
      SerialId: "F1",
      Status: "Done",
      Team: TEAM_TWO_REG,
      SubTotal: 1000,
      JobTotalPrice: 1000,
      LineItems: [
        { Name: "Regrout master shower", Price: 500, Quantity: 1, Type: "service" },
        { Name: "Grout Color Sealing", Price: 500, Quantity: 1, Type: "service" },
      ],
      Payments: [
        { id: "p1", Amount: 1000, Method: method },
        { id: "p2", Amount: 100, Method: method, IsTip: true },
      ],
    },
    settings,
    noCatalog,
  )

describe("Required example 1: $1,000 incl. $500 color, $100 tip split two ways", () => {
  it("cash/check/Zelle: 20%/25% technician receives $275.00", () => {
    const job = thousandWithColor("Check")
    expect(job.jobTotal).toBe(1000)
    expect(job.colorSealTotal).toBe(500)
    expect(job.cardServiceAmount).toBe(0)
    expect(job.nonCardTipAmount).toBe(100)

    const plan = planSegments(job, [REG_A, REG_B], owners)
    const seg = plan.segmentFor.get(REG_A.id)!
    // 500*0.20 + 500*0.25 + 100/2 = 100 + 125 + 50
    expect(cents(pay(seg, REG_A).totalPayout)).toBe(275.0)
    expect(pay(seg, REG_A).mode).toBe("legacy-non-card")
  })

  it("all-card: 20%/25% technician receives $265.38", () => {
    const job = thousandWithColor("Visa")
    expect(job.cardServiceAmount).toBe(1000)
    expect(job.cardTipAmount).toBe(100)

    const plan = planSegments(job, [REG_A, REG_B], owners)
    const result = pay(plan.segmentFor.get(REG_A.id)!, REG_A)
    // 500*0.965*0.20 + 500*0.965*0.25 + 100*0.965/2 = 96.50 + 120.625 + 48.25 = 265.375 -> $265.38
    expect(result.totalPayout).toBeCloseTo(265.375, 9)
    expect(cents(result.totalPayout)).toBe(265.38)
    expect(result.mode).toBe("legacy-card")
  })

  it("a technician with different rates on the same job is paid on their own profile", () => {
    const job = thousandWithColor("Check")
    const plan = planSegments(job, [REG_A, REG_B], owners)
    const a = pay(plan.segmentFor.get(REG_A.id)!, REG_A)
    const b = pay(plan.segmentFor.get(REG_B.id)!, REG_B)
    // B: 500*0.30 + 500*0.35 + 50 = 150 + 175 + 50
    expect(cents(b.totalPayout)).toBe(375.0)
    expect(cents(a.totalPayout)).toBe(275.0)
    // Each is a full individual commission on the same base, not a share of one crew total.
    expect(plan.segmentFor.get(REG_A.id)!.jobTotal).toBe(1000)
    expect(plan.segmentFor.get(REG_B.id)!.jobTotal).toBe(1000)
    // The tip is what is split (two regular technicians), the service commission is not.
    expect(a.tipPayout).toBe(50)
    expect(b.tipPayout).toBe(50)
  })
})

describe("Required example 2: $100 whole-job discount on $1,000 incl. $500 color", () => {
  it("commission inputs become $900 total and $450 color", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-F2",
        Status: "Done",
        Team: TEAM_TWO_REG,
        SubTotal: 1000,
        JobTotalPrice: 900,
        LineItems: [
          { Name: "Regrout master shower", Price: 500, Quantity: 1, Type: "service" },
          { Name: "Grout Color Sealing", Price: 500, Quantity: 1, Type: "service" },
          { Name: "discount", Price: 100, Quantity: 1, Type: "DISCOUNT_TYPE" },
        ],
        Payments: [{ id: "p1", Amount: 900, Method: "Zelle" }],
      },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(900)
    expect(job.colorSealTotal).toBe(450)
    expect(job.discountAmount).toBe(100)
    const seg = planSegments(job, [REG_A, REG_B], owners).segmentFor.get(REG_A.id)!
    expect(seg.jobTotal).toBe(900)
    expect(seg.colorSealTotal).toBe(450)
    // 450*0.20 + 450*0.25 = 90 + 112.50; the discount is deducted exactly once.
    expect(cents(pay(seg, REG_A).totalPayout)).toBe(202.5)
  })

  it("an item-specific discount stays on its item (marked Tim discount never touches the crew)", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-F2b",
        Status: "Done",
        Team: [...TEAM_TWO_REG, { id: 9003, Name: "Test Tim" }],
        SubTotal: 1500,
        JobTotalPrice: 1400,
        LineItems: [
          { Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" },
          { Name: "*T* Grout repair", Price: 500, Quantity: 1, Type: "service" },
          { Name: "*T* repair discount", Price: 100, Quantity: 1, Type: "DISCOUNT_TYPE" },
        ],
        Payments: [{ id: "p1", Amount: 1400, Method: "Check" }],
      },
      settings,
      noCatalog,
    )
    const plan = planSegments(job, [REG_A, REG_B, TIM], owners)
    expect(plan.segmentFor.get(TIM.id)!.jobTotal).toBe(400)
    expect(plan.segmentFor.get(REG_A.id)!.jobTotal).toBe(1000)
    expect(cents(pay(plan.segmentFor.get(TIM.id)!, TIM).totalPayout)).toBe(320.0)
    expect(cents(pay(plan.segmentFor.get(REG_A.id)!, REG_A).totalPayout)).toBe(200.0)
  })
})

describe("Required example 3: $200 card deposit + $800 check balance on $1,000 regular work", () => {
  it("a 20% technician receives $198.60 (fee only on the card-paid $200)", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-F3",
        Status: "Done",
        Team: [{ id: 9001, Name: "Test Reg A" }],
        SubTotal: 1000,
        JobTotalPrice: 1000,
        LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" }],
        Payments: [
          { id: "dep", Amount: 200, Method: "Visa", Date: "2026-09-01 10:00:00" },
          { id: "bal", Amount: 800, Method: "Check", Date: "2026-09-10 16:00:00" },
        ],
      },
      settings,
      noCatalog,
    )
    expect(job.cardServiceAmount).toBe(200)
    expect(job.nonCardServiceAmount).toBe(800)
    expect(job.fullyPaid).toBe(true)
    const seg = planSegments(job, [REG_A], owners).segmentFor.get(REG_A.id)!
    const result = pay(seg, REG_A)
    // 200*0.965*0.20 + 800*0.20 = 38.60 + 160.00
    expect(result.totalPayout).toBeCloseTo(198.6, 9)
    expect(cents(result.totalPayout)).toBe(198.6)
    expect(result.mode).toBe("split")
    // Not the whole job at the card rate (that would be $193.00) and not fee-free ($200.00).
    expect(cents(result.totalPayout)).not.toBe(193.0)
    expect(cents(result.totalPayout)).not.toBe(200.0)
  })

  it("a deposit alone is not fully paid; the job becomes eligible only once the balance arrives", () => {
    const raw = {
      UUID: "AUDIT-F3b",
      Status: "Done",
      Team: [{ id: 9001, Name: "Test Reg A" }],
      SubTotal: 1000,
      JobTotalPrice: 1000,
      LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" }],
      Payments: [{ id: "dep", Amount: 200, Method: "Visa" }],
    }
    const depositOnly = normalizeJob(raw, settings, noCatalog)
    expect(depositOnly.fullyPaid).toBe(false)
    expect(gateReason(depositOnly, settings)).toBe("Job is not fully paid")
    expect(releaseBlocker(depositOnly, settings)).toBe("Job is not fully paid in Workiz")

    const paid = normalizeJob({ ...raw, Payments: [...raw.Payments, { id: "bal", Amount: 800, Method: "Check" }] }, settings, noCatalog)
    expect(paid.fullyPaid).toBe(true)
    expect(gateReason(paid, settings)).toBeNull()
    expect(releaseBlocker(paid, settings)).toBeNull()
  })

  it("two deposits and a balance: the fee applies to both card deposits and nothing else", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-F3c",
        Status: "Done",
        Team: [{ id: 9001, Name: "Test Reg A" }],
        SubTotal: 1000,
        JobTotalPrice: 1000,
        LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" }],
        Payments: [
          { id: "d1", Amount: 100, Method: "Visa" },
          { id: "d2", Amount: 150, Method: "Mastercard" },
          { id: "bal", Amount: 750, Method: "Cash" },
        ],
      },
      settings,
      noCatalog,
    )
    expect(job.cardServiceAmount).toBe(250)
    const result = pay(planSegments(job, [REG_A], owners).segmentFor.get(REG_A.id)!, REG_A)
    // 250*0.965*0.20 + 750*0.20 = 48.25 + 150
    expect(cents(result.totalPayout)).toBe(198.25)
  })
})

describe("Required example 4: shared job with Tim, all card", () => {
  const shared = () =>
    normalizeJob(
      {
        UUID: "AUDIT-F4",
        SerialId: "F4",
        Status: "Done",
        Team: [...TEAM_TWO_REG, { id: 9003, Name: "Test Tim" }],
        SubTotal: 2000,
        JobTotalPrice: 1800,
        LineItems: [
          { Name: "Regrout and caulk", Price: 1000, Quantity: 1, Type: "service" },
          { Name: "Grout Color Sealing", Price: 500, Quantity: 1, Type: "service" },
          { Name: "*T* Shower restoration", Price: 500, Quantity: 1, Type: "service" },
          { Name: "discount", Price: 200, Quantity: 1, Type: "DISCOUNT_TYPE" },
        ],
        Payments: [
          { id: "p1", Amount: 1800, Method: "Credit Card" },
          { id: "p2", Amount: 100, Method: "Credit Card", IsTip: true },
        ],
      },
      settings,
      noCatalog,
    )

  it("each regular technician (20%/25%) receives $330.51", () => {
    const job = shared()
    expect(job.jobTotal).toBe(1800)
    const plan = planSegments(job, [REG_A, { ...REG_A, id: 904, name: "Test Reg A2" }, TIM], owners)
    expect(plan.warnings).toEqual([])
    const crew = plan.segmentFor.get(REG_A.id)!
    expect(crew.kind).toBe("crew")
    // Discount 200 over 2000 gross -> 90%: crew regular 900, crew color 450, Tim 450.
    expect(crew.jobTotal).toBe(1350)
    expect(crew.colorSealTotal).toBe(450)
    expect(crew.cardServiceAmount).toBe(1350)
    expect(crew.cardTipAmount).toBe(100)
    const result = pay(crew, REG_A)
    // 900*0.965*0.20 + 450*0.965*0.25 + 100*0.965/2 = 173.70 + 108.5625 + 48.25 = 330.5125
    expect(result.totalPayout).toBeCloseTo(330.5125, 9)
    expect(cents(result.totalPayout)).toBe(330.51)
    const second = pay(plan.segmentFor.get(904)!, REG_A)
    expect(cents(second.totalPayout)).toBe(330.51)
    expect(plan.splitCountFor.get(REG_A.id)).toBe(2)
  })

  it("Tim receives $347.40 and no tip, and his item is out of the crew's base", () => {
    const job = shared()
    const plan = planSegments(job, [REG_A, { ...REG_A, id: 904, name: "Test Reg A2" }, TIM], owners)
    const tim = plan.segmentFor.get(TIM.id)!
    expect(tim.kind).toBe("dedicated")
    expect(tim.jobTotal).toBe(450)
    expect(tim.cardTipAmount).toBe(0)
    expect(tim.nonCardTipAmount).toBe(0)
    const result = pay(tim, TIM)
    // 450*0.965*0.80 = 347.40
    expect(result.totalPayout).toBeCloseTo(347.4, 9)
    expect(cents(result.totalPayout)).toBe(347.4)
    expect(result.tipPayout).toBe(0)
    // Segments partition the invoice exactly: 1350 + 450 = 1800.
    expect(plan.segmentation.verification.balanced).toBe(true)
    expect(plan.segmentation.verification.doubleCountedItems).toBe(0)
  })

  it("a *T* color-seal item belongs to Tim at his flat rate, not to the crew's color total", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-F4b",
        Status: "Done",
        Team: [...TEAM_TWO_REG, { id: 9003, Name: "Test Tim" }],
        SubTotal: 1500,
        JobTotalPrice: 1500,
        LineItems: [
          { Name: "Regrout", Price: 1000, Quantity: 1, Type: "service" },
          { Name: "*T* Grout Color Sealing", Price: 500, Quantity: 1, Type: "service" },
        ],
        Payments: [{ id: "p1", Amount: 1500, Method: "Check" }],
      },
      settings,
      noCatalog,
    )
    expect(job.colorSealTotal).toBe(500)
    const plan = planSegments(job, [REG_A, REG_B, TIM], owners)
    const crew = plan.segmentFor.get(REG_A.id)!
    const tim = plan.segmentFor.get(TIM.id)!
    expect(crew.colorSealTotal).toBe(0)
    expect(crew.jobTotal).toBe(1000)
    expect(tim.colorSealTotal).toBe(500)
    expect(cents(pay(tim, TIM).totalPayout)).toBe(400.0)
    expect(pay(tim, TIM).colorPayout).toBe(0)
    expect(cents(pay(crew, REG_A).totalPayout)).toBe(200.0)
  })

  it("Tim on the job with nothing marked, or items marked for an absent Tim, holds the job for review", () => {
    const nothingMarked = normalizeJob(
      { UUID: "AUDIT-F4c", Status: "Done", Team: [...TEAM_TWO_REG, { id: 9003, Name: "Test Tim" }], SubTotal: 1000, JobTotalPrice: 1000, LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1 }], Payments: [{ Amount: 1000, Method: "Check" }] },
      settings,
      noCatalog,
    )
    const p1 = planSegments(nothingMarked, [REG_A, REG_B, TIM], owners)
    expect(p1.warnings.some((w) => w.includes("no line items carry *T*"))).toBe(true)
    expect(gateReason(nothingMarked, settings, p1.warnings)).not.toBeNull()

    const absentTim = normalizeJob(
      { UUID: "AUDIT-F4d", Status: "Done", Team: TEAM_TWO_REG, SubTotal: 1000, JobTotalPrice: 1000, LineItems: [{ Name: "*T* Regrout", Price: 1000, Quantity: 1 }], Payments: [{ Amount: 1000, Method: "Check" }] },
      settings,
      noCatalog,
    )
    const p2 = planSegments(absentTim, [REG_A, REG_B], owners)
    expect(p2.warnings.some((w) => w.includes("not assigned to this job"))).toBe(true)
    expect(gateReason(absentTim, settings, p2.warnings)).not.toBeNull()
  })
})

describe("Service classification and line-item arithmetic", () => {
  it("multiple color-seal items add up; ordinary clear 'Grout Sealing' stays regular work", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-C1",
        Status: "Done",
        Team: TEAM_TWO_REG,
        SubTotal: 1300,
        JobTotalPrice: 1300,
        LineItems: [
          { Name: "Grout Sealing (clear)", Price: 300, Quantity: 1 },
          { Name: "Grout Color Sealing - floor", Price: 400, Quantity: 1 },
          { Name: "Grout Color Sealing - walls", Price: 600, Quantity: 1 },
        ],
        Payments: [{ Amount: 1300, Method: "Zelle" }],
      },
      settings,
      noCatalog,
    )
    expect(job.colorSealTotal).toBe(1000)
    expect(job.jobTotal).toBe(1300)
    expect(job.lineItems[0].isColorSeal).toBe(false)
    // 300*0.20 + 1000*0.25
    expect(cents(pay(planSegments(job, [REG_A], owners).segmentFor.get(REG_A.id)!, REG_A).totalPayout)).toBe(310.0)
  })

  it("uses Price x Quantity exactly once, and trusts an explicit extended Total when Workiz sends one", () => {
    const byQty = normalizeJob(
      { UUID: "AUDIT-C2", Status: "Done", Team: TEAM_TWO_REG, SubTotal: 500, JobTotalPrice: 500, LineItems: [{ Name: "Regrout bathroom", Price: 250, Quantity: 2 }], Payments: [{ Amount: 500, Method: "Check" }] },
      settings,
      noCatalog,
    )
    expect(byQty.lineItems[0].total).toBe(500)
    expect(byQty.jobTotal).toBe(500)

    const withTotal = normalizeJob(
      { UUID: "AUDIT-C3", Status: "Done", Team: TEAM_TWO_REG, SubTotal: 500, JobTotalPrice: 500, LineItems: [{ Name: "Regrout bathroom", Price: 250, Quantity: 2, Total: 500 }], Payments: [{ Amount: 500, Method: "Check" }] },
      settings,
      noCatalog,
    )
    expect(withTotal.lineItems[0].total).toBe(500)
    expect(withTotal.jobTotal).toBe(500)
  })

  it("keeps tips and tax out of the commission base", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-C4",
        Status: "Done",
        Team: TEAM_TWO_REG,
        SubTotal: 1000,
        JobTotalPrice: 1070,
        TaxAmount: 70,
        LineItems: [{ Name: "Regrout", Price: 1000, Quantity: 1 }],
        Payments: [
          { Amount: 1070, Method: "Visa" },
          { Amount: 50, Method: "Visa", IsTip: true },
        ],
      },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(1000)
    expect(job.cardServiceAmount).toBe(1000)
    expect(job.cardTipAmount).toBe(50)
    expect(job.fullyPaid).toBe(true)
  })

  it("does not treat words that merely contain 'tip' as tips", () => {
    const job = normalizeJob(
      { UUID: "AUDIT-C5", Status: "Done", Team: TEAM_TWO_REG, SubTotal: 700, JobTotalPrice: 700, LineItems: [{ Name: "Multiple shower stalls", Price: 700, Quantity: 1 }], Payments: [{ Amount: 700, Method: "Check" }] },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(700)
    expect(job.nonCardTipAmount).toBe(0)
  })
})

describe("Payment records", () => {
  it("deduplicates a payment echoed twice and separates an embedded tip", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-P1",
        Status: "Done",
        Team: TEAM_TWO_REG,
        SubTotal: 500,
        JobTotalPrice: 500,
        LineItems: [{ Name: "Regrout", Price: 500, Quantity: 1 }],
        Payments: [
          { id: "same", Amount: 550, Method: "Amex", Tip: 50 },
          { id: "same", Amount: 550, Method: "Amex", Tip: 50 },
        ],
      },
      settings,
      noCatalog,
    )
    expect(job.totalPaid).toBe(550)
    expect(job.cardServiceAmount).toBe(500)
    expect(job.cardTipAmount).toBe(50)
    expect(job.fullyPaid).toBe(true)
  })

  it("a refund (negative payment) reduces the paid total and stops the job from being fully paid", () => {
    const job = normalizeJob(
      {
        UUID: "AUDIT-P2",
        Status: "Done",
        Team: TEAM_TWO_REG,
        SubTotal: 500,
        JobTotalPrice: 500,
        LineItems: [{ Name: "Regrout", Price: 500, Quantity: 1 }],
        Payments: [
          { id: "a", Amount: 500, Method: "Visa" },
          { id: "r", Amount: -100, Method: "Visa" },
        ],
      },
      settings,
      noCatalog,
    )
    expect(job.totalPaid).toBe(400)
    expect(job.fullyPaid).toBe(false)
    expect(gateReason(job, settings)).toBe("Job is not fully paid")
  })

  it("a cancelled or written-off job never becomes ready even with a zero balance", () => {
    const cancelled = normalizeJob(
      { UUID: "AUDIT-P3", Status: "Canceled", Team: TEAM_TWO_REG, SubTotal: 500, JobTotalPrice: 0, JobAmountDue: 0, LineItems: [{ Name: "Regrout", Price: 500, Quantity: 1 }] },
      settings,
      noCatalog,
    )
    expect(gateReason(cancelled, settings)).toMatch(/not payable/)

    const writtenOff = normalizeJob(
      { UUID: "AUDIT-P4", Status: "Done", Team: TEAM_TWO_REG, SubTotal: 500, JobTotalPrice: 0, JobAmountDue: 0, LineItems: [{ Name: "Regrout", Price: 500, Quantity: 1 }] },
      settings,
      noCatalog,
    )
    expect(writtenOff.jobTotal).toBe(0)
    expect(gateReason(writtenOff, settings)).not.toBeNull()
  })
})

describe("Missing or ambiguous data is flagged, never treated as zero", () => {
  it("no line items -> warning and hold; no team -> nobody to pay", () => {
    const noItems = normalizeJob({ UUID: "AUDIT-M1", Status: "Done", Team: TEAM_TWO_REG, SubTotal: 500, JobTotalPrice: 500, JobAmountDue: 0 }, settings, noCatalog)
    expect(noItems.jobTotal).toBe(500)
    expect(noItems.warnings.some((w) => w.includes("no line items"))).toBe(true)
    expect(gateReason(noItems, settings)).not.toBeNull()

    const noTeam = normalizeJob({ UUID: "AUDIT-M2", Status: "Done", SubTotal: 500, JobTotalPrice: 500, JobAmountDue: 0, LineItems: [{ Name: "Regrout", Price: 500 }] }, settings, noCatalog)
    expect(noTeam.teamIds).toEqual([])
    expect(planSegments(noTeam, [], owners).segmentFor.size).toBe(0)
  })

  it("team names without ids cannot be mapped and are flagged", () => {
    const job = normalizeJob({ UUID: "AUDIT-M3", Status: "Done", Team: [{ Name: "Somebody" }], SubTotal: 500, JobTotalPrice: 500, JobAmountDue: 0, LineItems: [{ Name: "Regrout", Price: 500 }] }, settings, noCatalog)
    expect(job.teamIds).toEqual([])
    expect(job.warnings.some((w) => w.includes("without ids"))).toBe(true)
  })

  it("throws on a job without a UUID instead of saving a phantom record", () => {
    expect(() => normalizeJob({ Status: "Done" } as never, settings, noCatalog)).toThrow(/UUID/)
  })
})

describe("Rounding", () => {
  it("keeps full precision internally and rounds half-up to cents only for display and storage", () => {
    expect(cents(265.375)).toBe(265.38)
    expect(cents(330.5125)).toBe(330.51)
    expect(cents(198.6)).toBe(198.6)
    const r = calcPayoutWithPaymentSplit({ jobTotal: 333.33, colorSealTotal: 0, cardServiceAmount: 333.33, cardTip: 0, nonCardOwedTip: 0 }, REG_A.rates, REG_A.options)
    // 333.33*0.965*0.2 = 64.33269
    expect(r.totalPayout).toBeCloseTo(64.33269, 9)
    expect(cents(r.totalPayout)).toBe(64.33)
  })
})
