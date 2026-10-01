import { describe, expect, it } from "vitest"
import { calcPayoutWithPaymentSplit } from "@/lib/payout/calculator"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { UNITEMIZED_DISCOUNT_PREFIX, UNITEMIZED_SURPLUS_PREFIX, isBlockingWarning, normalizeJob, type NormalizedJob } from "@/lib/workiz/normalize"
import { externalRowsToPayments, TIP_INCLUSION_RAW_KEY } from "@/lib/workiz/payments"

const settings = DEFAULT_WORKIZ_SETTINGS
const noCatalog = new Map<string, boolean>()

const manualRow = (id: number, method: string, amount: number, tip = 0) => ({
  id,
  externalId: null,
  source: "manual",
  method,
  amount: amount.toFixed(2),
  tipAmount: tip.toFixed(2),
  paidAt: new Date("2026-10-01T18:00:00.000Z"),
  recordedBy: "admin",
  raw: tip > 0 ? { [TIP_INCLUSION_RAW_KEY]: "included" } : null,
})

const payoutFor = (job: NormalizedJob, rate: number, tipShare: number) => {
  const r = calcPayoutWithPaymentSplit(
    { jobTotal: job.jobTotal, colorSealTotal: job.colorSealTotal, cardServiceAmount: job.cardServiceAmount, cardTip: job.cardTipAmount, nonCardOwedTip: job.nonCardTipAmount },
    { nonColorRate: rate, colorRate: rate },
    { separateColorSeal: false, tipShare },
  )
  return { commission: Math.round(r.basePayout * 100) / 100, tip: Math.round(r.tipPayout * 100) / 100, total: Math.round(r.totalPayout * 100) / 100 }
}

describe("job #924889 (James Wilkins): unitemized 5% discount AND a $92.65 tip inside JobTotalPrice", () => {
  const lines: Array<[string, number]> = [
    ["Acid Wash Grout On Floors", 866.31],
    ["Stain Resistant Grout Treatment – Floors", 979.75],
    ["Walk-in Shower 1 sealing", 150.0],
    ["Walk-in Shower 2 sealing", 135.0],
    ["Tub Shower 3 sealing", 128.81],
  ]
  const raw = {
    UUID: "924889",
    SerialId: 924889,
    Status: "Done",
    Team: [
      { id: 9004, Name: "Viktor" },
      { id: 9003, Name: "Arthur" },
    ],
    SubTotal: 2259.87,
    JobTotalPrice: 2239.53,
    JobAmountDue: 0,
    LineItems: lines.map(([Name, Price]) => ({ Name, Price, Qty: 1, Type: "service" })),
  }
  const external = externalRowsToPayments([manualRow(1, "Card", 293.93), manualRow(2, "Card", 1945.6, 92.65)], settings.cardMethodKeywords)
  const job = normalizeJob(raw, settings, noCatalog, { externalPayments: external })

  it("subtracts the recorded tip from JobTotalPrice before inferring the discount", () => {
    expect(job.jobTotal).toBe(2146.88)
    expect(job.discountAmount).toBe(112.99)
    expect(job.unitemizedSurplus).toBe(0)
    expect(job.fullyPaid).toBe(true)
    // The $0 balance is fully explained by the records; no untyped non-card money is invented.
    expect(job.cardServiceAmount).toBe(2146.88)
    expect(job.nonCardServiceAmount).toBe(0)
    expect(job.cardTipAmount).toBe(92.65)
    expect(job.nonCardTipAmount).toBe(0)
  })

  it("spreads the discount over every line item in proportion (exactly 5% here)", () => {
    expect(job.lineItems.map((i) => i.netTotal)).toEqual([823.0, 930.76, 142.5, 128.25, 122.37])
    expect(job.jobTotal / 2259.87).toBeCloseTo(0.95, 4)
  })

  it("still holds the payout until an admin confirms the inferred discount, with no surplus or method warning", () => {
    const blocking = job.warnings.filter(isBlockingWarning)
    expect(blocking.map((w) => w.split(":")[0])).toEqual([UNITEMIZED_DISCOUNT_PREFIX])
    expect(blocking[0]).toContain("$112.99")
    expect(blocking[0]).toContain("$92.65 tip")
    expect(job.warnings.some((w) => w.startsWith(UNITEMIZED_SURPLUS_PREFIX))).toBe(false)
  })

  it("pays Viktor and Arthur $459.05 each (commission $414.35 + tip share $44.70)", () => {
    const p = payoutFor(job, 0.2, 0.5)
    expect(p.commission).toBe(414.35)
    expect(p.tip).toBe(44.7)
    expect(p.total).toBe(459.05)
  })
})

describe("jobs without a tip keep their existing results", () => {
  it("#924885: $50 discount line, all card, two techs at 20% → $329.24 each", () => {
    const job = normalizeJob(
      {
        UUID: "924885",
        Status: "Done",
        Team: [
          { id: 1, Name: "Tech A" },
          { id: 2, Name: "Tech B" },
        ],
        SubTotal: 1755.92,
        JobTotalPrice: 1705.92,
        JobAmountDue: 0,
        LineItems: [
          { Name: "Tile & grout restoration", Price: 1755.92, Qty: 1, Type: "service" },
          { Name: "discount", Price: 50, Qty: 1, Type: "DISCOUNT_TYPE" },
        ],
      },
      settings,
      noCatalog,
      { externalPayments: externalRowsToPayments([manualRow(1, "Card", 1705.92)], settings.cardMethodKeywords) },
    )
    expect(job.jobTotal).toBe(1705.92)
    expect(job.discountAmount).toBe(50)
    expect(job.cardServiceAmount).toBe(1705.92)
    expect(job.warnings.filter(isBlockingWarning)).toEqual([])
    expect(payoutFor(job, 0.2, 0.5).total).toBe(329.24)
  })

  it("#924883: $75 discount, 30% card → Denis 20% $236.43, Vadim 25% $295.54", () => {
    const job = normalizeJob(
      {
        UUID: "924883",
        Status: "Done",
        Team: [
          { id: 12, Name: "Denis" },
          { id: 11, Name: "Vadim" },
        ],
        SubTotal: 1269.7,
        JobTotalPrice: 1194.7,
        JobAmountDue: 0,
        LineItems: [
          { Name: "Shower regrout", Price: 1269.7, Qty: 1, Type: "service" },
          { Name: "discount", Price: 75, Qty: 1, Type: "DISCOUNT_TYPE" },
        ],
      },
      settings,
      noCatalog,
      { externalPayments: externalRowsToPayments([manualRow(1, "Card", 358.41), manualRow(2, "Cash", 836.29)], settings.cardMethodKeywords) },
    )
    expect(job.jobTotal).toBe(1194.7)
    expect(job.cardServiceAmount).toBe(358.41)
    expect(job.nonCardServiceAmount).toBe(836.29)
    expect(job.warnings.filter(isBlockingWarning)).toEqual([])
    expect(payoutFor(job, 0.2, 0.5).total).toBe(236.43)
    expect(payoutFor(job, 0.25, 0.5).total).toBe(295.54)
  })
})
