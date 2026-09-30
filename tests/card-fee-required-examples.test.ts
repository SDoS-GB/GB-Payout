import { describe, expect, it } from "vitest"
import type { JobPaymentRow, TechnicianProfile } from "@/lib/db/schema"
import { cardShareOf, toCents } from "@/lib/payout/calculator"
import { computeForProfile, gateReason, invoiceCardFee } from "@/lib/payout/engine"
import { planSegments, type PlannableProfile, type SegmentPlan } from "@/lib/payout/segments"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { PAYMENT_METHOD_UNKNOWN_PREFIX, normalizeJob, type NormalizedJob } from "@/lib/workiz/normalize"
import { classifyPaymentMethod, externalRowsToPayments, extractDocumentPayments } from "@/lib/workiz/payments"

/**
 * The owner's required worked examples (2026-09-30 brief), run through the same code the sync
 * uses: payment records -> normalizeJob -> planSegments -> computeForProfile. Every expected
 * value is the literal from the brief.
 *
 *   Service $1,000; card deposit $300; check final $700; no tip/tax/discount.
 *   Card fee 300 x 3.5% = $10.50; check fee $0; net $989.50; card share 30%;
 *   effective deduction 1.05%; every service dollar keeps 98.95% before commission.
 *   Standard 20% tech -> $197.90; Vadim 25% -> $247.38.
 *   $600 regular + $400 color sealing, standard tech -> $217.69.
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
const TIM = tech(5, "Tim", 0.8, 0.8, { lineItemMarker: "T", ownedWorkType: "Tim's Job", tipShare: "0.000000", separateColorSeal: false })
const ROSTER: Tech[] = [VADIM, ARTHUR, VIKTOR, TIM]
const TEAM = { arthur: { id: "9003", Name: "Arthur" }, viktor: { id: "9004", Name: "Viktor" }, vadim: { id: "9001", Name: "Vadim" }, tim: { id: "9005", Name: "Tim" } }

function payoutFor(job: NormalizedJob, plan: SegmentPlan, t: Tech) {
  const segment = plan.segmentFor.get(t.id)
  if (!segment) throw new Error(`${t.name} is not on the plan`)
  return computeForProfile(segment, t as unknown as TechnicianProfile, { tipShare: plan.tipShareFor.get(t.id) ?? 0, cardServiceShare: cardShareOf(job.cardServiceAmount, job.jobTotal) })
}

/** A stored `job_payments` row exactly as a webhook or an admin confirmation leaves it. */
let rowId = 0
const storedRow = (over: Partial<JobPaymentRow> & Pick<JobPaymentRow, "method" | "amount">): JobPaymentRow => ({
  id: ++rowId,
  jobUuid: "REQ-1000",
  externalId: over.externalId ?? `PAY-${rowId}`,
  source: over.source ?? "invoice-webhook",
  method: over.method,
  amount: over.amount,
  tipAmount: over.tipAmount ?? "0.00",
  paidAt: over.paidAt ?? null,
  paidAtFromPayload: over.paidAtFromPayload ?? true,
  invoiceId: over.invoiceId ?? null,
  reference: over.reference ?? null,
  recordedBy: over.recordedBy ?? null,
  raw: over.raw ?? null,
  createdAt: new Date("2026-09-20T12:00:00Z"),
  updatedAt: new Date("2026-09-20T12:00:00Z"),
})

/** The live shape: `job/get` carries no Payments[]; only the balance. Records arrive separately. */
const rawJob = (over: Record<string, unknown> = {}) => ({
  UUID: "REQ-1000",
  SerialId: "1000",
  Status: "Done",
  JobType: "Work",
  Team: [TEAM.arthur],
  LastStatusUpdate: "2026-09-24 16:30:00",
  SubTotal: 1000,
  JobTotalPrice: 1000,
  JobAmountDue: 0,
  LineItems: [{ Name: "Restorative Tile & Grout Floor Cleaning", Price: 1000, Quantity: 1, Type: "service" }],
  ...over,
})

const DEPOSIT_CARD_300 = storedRow({ externalId: "PAY-DEP", source: "estimate-webhook", method: "credit", amount: "300.00", invoiceId: "ES-77", paidAt: new Date("2026-09-10T14:05:00Z") })
const FINAL_CHECK_700 = storedRow({ externalId: "PAY-FIN", source: "invoice-webhook", method: "Check #1043", amount: "700.00", invoiceId: "IV-91", paidAt: new Date("2026-09-24T20:31:00Z") })

const withPayments = (raw: Record<string, unknown>, rows: JobPaymentRow[]) => normalizeJob(raw, settings, noCatalog, { externalPayments: externalRowsToPayments(rows, settings.cardMethodKeywords) })

describe("Required example: $1,000 service, $300 card deposit, $700 check final", () => {
  const job = withPayments(rawJob(), [DEPOSIT_CARD_300, FINAL_CHECK_700])

  it("recognises the estimate deposit (no invoice yet) and a check labelled with its number, without any processor status", () => {
    expect(job.payments).toHaveLength(2)
    expect(job.payments.map((p) => [p.method, p.isCard, p.methodKnown, p.amount])).toEqual([
      ["credit", true, true, 300],
      ["Check #1043", false, true, 700],
    ])
    expect(job.cardServiceAmount).toBe(300)
    expect(job.nonCardServiceAmount).toBe(700)
    expect(job.fullyPaid).toBe(true)
    expect(job.paidEvidence).toBe("payments")
    expect(job.warnings).toEqual([])
    expect(gateReason(job, settings)).toBeNull()
  })

  it("card fee $10.50, check fee $0.00, net $989.50, card share 30%, effective deduction 1.05%, retention 98.95%", () => {
    const fee = invoiceCardFee(job)
    expect(cents(fee.fee)).toBe(10.5)
    expect(fee.cardShare).toBeCloseTo(0.3, 12)
    expect(1 - fee.serviceFactor).toBeCloseTo(0.0105, 12)
    expect(fee.serviceFactor).toBeCloseTo(0.9895, 12)
    expect(cents(fee.adjustedServiceSubtotal)).toBe(989.5)
    // The non-card $700 carries no fee: the fee is exactly 3.5% of the card dollars, nothing more.
    expect(cents(fee.fee - 300 * 0.035)).toBe(0)
  })

  it("standard technician (20%) receives $197.90; two standard technicians each receive $197.90, not a shared 20%", () => {
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    expect(plan.warnings).toEqual([])
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(197.9)
    expect(cents(payoutFor(job, plan, VIKTOR).totalPayout)).toBe(197.9)
  })

  it("Vadim (25%) receives $247.38", () => {
    const solo = withPayments(rawJob({ Team: [TEAM.vadim] }), [DEPOSIT_CARD_300, FINAL_CHECK_700])
    const plan = planSegments(solo, [VADIM], ROSTER)
    expect(cents(payoutFor(solo, plan, VADIM).totalPayout)).toBe(247.38)
  })

  it("is not the whole-job-as-card ($193.00) nor the final-payment-method-only ($200.00) shortcut", () => {
    const plan = planSegments(job, [ARTHUR], ROSTER)
    const actual = cents(payoutFor(job, plan, ARTHUR).totalPayout)
    expect(actual).not.toBe(cents(1000 * 0.965 * 0.2))
    expect(actual).not.toBe(cents(1000 * 0.2))
    expect(actual).toBe(197.9)
  })
})

describe("Required example: $600 regular + $400 color sealing with the same payments", () => {
  const raw = rawJob({
    LineItems: [
      { Name: "Restorative Tile & Grout Floor Cleaning", Price: 600, Quantity: 1, Type: "service" },
      { Name: "Grout Color Sealing – Floors", Price: 400, Quantity: 1, Type: "service" },
    ],
  })
  const job = withPayments(raw, [DEPOSIT_CARD_300, FINAL_CHECK_700])

  it("standard technician receives ($600 x 98.95% x 20%) + ($400 x 98.95% x 25%) = $217.69", () => {
    expect(job.colorSealTotal).toBe(400)
    const plan = planSegments(job, [ARTHUR], ROSTER)
    const b = payoutFor(job, plan, ARTHUR)
    expect(cents(b.nonColorPayout)).toBe(118.74)
    expect(cents(b.colorPayout)).toBe(98.95)
    expect(cents(b.totalPayout)).toBe(217.69)
  })

  it("Vadim receives $1,000 x 98.95% x 25% = $247.38 (color sealing is also 25% for him)", () => {
    const solo = withPayments(rawJob({ Team: [TEAM.vadim], LineItems: (raw as { LineItems: unknown[] }).LineItems }), [DEPOSIT_CARD_300, FINAL_CHECK_700])
    const plan = planSegments(solo, [VADIM], ROSTER)
    expect(cents(payoutFor(solo, plan, VADIM).totalPayout)).toBe(247.38)
  })
})

describe("Other payment mixes on the $1,000 job", () => {
  const solo = (rows: JobPaymentRow[], team = [TEAM.arthur]) => {
    const job = withPayments(rawJob({ Team: team }), rows)
    const plan = planSegments(job, team[0] === TEAM.vadim ? [VADIM] : [ARTHUR], ROSTER)
    return { job, plan }
  }

  it("all card: $1,000 x 96.5% x 20% = $193.00", () => {
    const { job, plan } = solo([storedRow({ method: "Credit Card", amount: "1000.00" })])
    expect(job.cardServiceAmount).toBe(1000)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(193)
  })

  it("all check: no deduction, $200.00", () => {
    const { job, plan } = solo([storedRow({ method: "Check 2210", amount: "1000.00" })])
    expect(job.cardServiceAmount).toBe(0)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(200)
  })

  it("cash and Zelle in two instalments: no deduction, $200.00", () => {
    const { job, plan } = solo([storedRow({ method: "cash", amount: "450.00" }), storedRow({ method: "Zelle", amount: "550.00" })])
    expect(job.cardServiceAmount).toBe(0)
    expect(job.fullyPaid).toBe(true)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(200)
  })

  it("three instalments ($200 card, $300 Zelle, $500 card): card share 70%, factor 0.9755, $195.10", () => {
    const { job, plan } = solo([storedRow({ method: "Visa", amount: "200.00" }), storedRow({ method: "Zelle", amount: "300.00" }), storedRow({ method: "Mastercard", amount: "500.00" })])
    expect(job.cardServiceAmount).toBe(700)
    expect(invoiceCardFee(job).serviceFactor).toBeCloseTo(0.9755, 12)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(195.1)
  })

  it("a deposit alone does not make the job payable even when the deposit document shows $0 due", () => {
    const job = withPayments(rawJob({ JobAmountDue: 700 }), [DEPOSIT_CARD_300])
    expect(job.fullyPaid).toBe(false)
    expect(gateReason(job, settings)).toBe("Job is not fully paid")
  })

  it("a $0 balance with no payment records is identifiable as missing data, not silently zero-fee cash", () => {
    const job = normalizeJob(rawJob(), settings, noCatalog)
    expect(job.paidEvidence).toBe("balance")
    expect(job.warnings.some((w) => w.startsWith(PAYMENT_METHOD_UNKNOWN_PREFIX))).toBe(true)
    expect(gateReason(job, settings)).toMatch(PAYMENT_METHOD_UNKNOWN_PREFIX)
  })

  it("an explicit 'Other' payment keeps the classification review instead of being paid as non-card", () => {
    const { job } = solo([storedRow({ method: "Other", amount: "1000.00" })])
    expect(job.payments[0].methodKnown).toBe(false)
    expect(gateReason(job, settings)).toMatch(PAYMENT_METHOD_UNKNOWN_PREFIX)
  })

  it("a $100 discount is taken before commission: $300 card of the $900 discounted subtotal -> $900 x 98.8333% x 20% = $177.90", () => {
    // $300 card of a $900 discounted subtotal = 33.33% share, factor 1 - 0.011667 = 0.988333
    const raw = rawJob({ SubTotal: 1000, JobTotalPrice: 900, LineItems: [{ Name: "Cleaning", Price: 1000, Quantity: 1, Type: "service" }, { Name: "Discount", Price: 100, Quantity: 1, Type: "DISCOUNT_TYPE" }] })
    const job = withPayments(raw, [DEPOSIT_CARD_300, storedRow({ method: "Check #77", amount: "600.00" })])
    expect(job.jobTotal).toBe(900)
    expect(job.discountAmount).toBe(100)
    const plan = planSegments(job, [ARTHUR], ROSTER)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(cents(900 * (1 - (300 / 900) * 0.035) * 0.2))
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(177.9)
  })
})

describe("Tips: 3.5% only on card-paid tips, then the approved split; never a service rate on a tip", () => {
  it("$100 tip paid by card on a $1,000 check job, two regular technicians: each gets $48.25 tip, $200 service", () => {
    const rows = [storedRow({ method: "Check #5", amount: "1000.00" }), storedRow({ method: "Visa", amount: "100.00", tipAmount: "100.00", raw: { _tipInclusion: "included" } })]
    // The job total includes the tip Workiz folds into JobTotalPrice.
    const job = withPayments(rawJob({ Team: [TEAM.arthur, TEAM.viktor], JobTotalPrice: 1100 }), rows)
    expect(job.cardTipAmount).toBe(100)
    expect(job.nonCardTipAmount).toBe(0)
    expect(job.cardServiceAmount).toBe(0)
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    const a = payoutFor(job, plan, ARTHUR)
    expect(cents(a.basePayout)).toBe(200)
    expect(cents(a.tipPayout)).toBe(48.25) // 100 x 0.965 x 0.5
    expect(cents(a.totalPayout)).toBe(248.25)
    expect(cents(payoutFor(job, plan, VIKTOR).totalPayout)).toBe(248.25)
  })

  it("$100 tip paid by Zelle: no deduction, $50.00 each", () => {
    const rows = [storedRow({ method: "Visa", amount: "1000.00" }), storedRow({ method: "Zelle", amount: "100.00", tipAmount: "100.00", raw: { _tipInclusion: "included" } })]
    const job = withPayments(rawJob({ Team: [TEAM.arthur, TEAM.viktor], JobTotalPrice: 1100 }), rows)
    expect(job.nonCardTipAmount).toBe(100)
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    const a = payoutFor(job, plan, ARTHUR)
    expect(cents(a.tipPayout)).toBe(50)
    expect(cents(a.basePayout)).toBe(193) // service was all card
    expect(cents(a.totalPayout)).toBe(243)
  })

  it("a tip riding on a card payment is deducted once (not from both the service factor and the tip)", () => {
    // $300 card payment that includes a $50 tip -> $250 card service + $50 card tip; $750 check.
    const rows = [storedRow({ method: "Visa", amount: "300.00", tipAmount: "50.00", raw: { _tipInclusion: "included" } }), storedRow({ method: "Check #9", amount: "750.00" })]
    const job = withPayments(rawJob({ JobTotalPrice: 1050 }), rows)
    expect(job.cardServiceAmount).toBe(250)
    expect(job.nonCardServiceAmount).toBe(750)
    expect(job.cardTipAmount).toBe(50)
    const plan = planSegments(job, [ARTHUR], ROSTER)
    const b = payoutFor(job, plan, ARTHUR)
    expect(cents(b.basePayout)).toBe(cents(1000 * (1 - 0.25 * 0.035) * 0.2)) // 198.25
    expect(cents(b.tipPayout)).toBe(cents(50 * 0.965 * 1)) // solo regular tech keeps the whole tip: 48.25
    expect(cents(b.totalPayout)).toBe(246.5)
  })
})

describe("Tim's rules survive the per-payment card fee", () => {
  it("Work Type \"Tim's Job\": Tim gets 80% of $989.50 = $791.60; a listed crew member gets no service commission", () => {
    const job = withPayments(rawJob({ JobType: "Tim's Job", Team: [TEAM.tim, TEAM.arthur] }), [DEPOSIT_CARD_300, FINAL_CHECK_700])
    const plan = planSegments(job, [TIM, ARTHUR], ROSTER)
    expect(cents(payoutFor(job, plan, TIM).totalPayout)).toBe(791.6)
    expect(plan.segmentFor.get(ARTHUR.id)!.jobTotal).toBe(0)
  })

  it("*T* marked item on a crew job: Tim 80% of his item, crew paid on the rest, same factor", () => {
    const raw = rawJob({
      Team: [TEAM.tim, TEAM.arthur],
      LineItems: [
        { Name: "Restorative Cleaning", Price: 600, Quantity: 1, Type: "service" },
        { Name: "*T* Caulking repair", Price: 400, Quantity: 1, Type: "service" },
      ],
    })
    const job = withPayments(raw, [DEPOSIT_CARD_300, FINAL_CHECK_700])
    const plan = planSegments(job, [TIM, ARTHUR], ROSTER)
    expect(plan.segmentFor.get(TIM.id)!.jobTotal).toBe(400)
    expect(plan.segmentFor.get(ARTHUR.id)!.jobTotal).toBe(600)
    expect(cents(payoutFor(job, plan, TIM).totalPayout)).toBe(cents(400 * 0.9895 * 0.8)) // 316.64
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(cents(600 * 0.9895 * 0.2)) // 118.74
  })
})

describe("Method recognition from Workiz payment text", () => {
  it.each([
    ["Check #1043", "Check", false],
    ["check 88", "Check", false],
    ["Cheque", "Check", false],
    ["Cash", "Cash", false],
    ["Zelle", "Zelle", false],
    ["Cash App", "Cash App", false],
    ["credit", "Card", true],
    ["Credit Card", "Card", true],
    ["Visa ****1234", "Card", true],
    ["Workiz Pay", "Card", true],
  ])("%s -> %s (card: %s)", (text, label, isCard) => {
    const cls = classifyPaymentMethod(text, settings.cardMethodKeywords)
    expect(cls.known).toBe(true)
    expect(cls.label).toBe(label)
    expect(cls.isCard).toBe(isCard)
  })

  it("does not require a processor 'Succeeded' status: a manual check record with status 'pending' is still a payment", () => {
    const doc = extractDocumentPayments({ id: "IV-5", totalPrice: 700, amountDue: 0, payments: [{ id: "PAY-1", type: "Check #1043", amount: 700, status: "pending" }] }, "2026-09-24T20:31:00Z")
    expect(doc?.payments).toHaveLength(1)
    expect(doc?.payments[0].method).toBe("Check #1043")
    expect(doc?.payments[0].amount).toBe(700)
  })

  it("the same Workiz payment id seen through the estimate and the invoice counts once", () => {
    const rows = [
      storedRow({ externalId: "PAY-SAME", source: "estimate-webhook", method: "credit", amount: "300.00" }),
      storedRow({ externalId: "PAY-SAME", source: "invoice-webhook", method: "credit", amount: "300.00" }),
      FINAL_CHECK_700,
    ]
    const job = withPayments(rawJob(), rows)
    expect(job.payments).toHaveLength(2)
    expect(job.totalPaid).toBe(1000)
  })
})
