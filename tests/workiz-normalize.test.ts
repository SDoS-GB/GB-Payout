import { describe, expect, it } from "vitest"
import { calcLegacyJobPayout, calcPayoutWithPaymentSplit } from "@/lib/payout/calculator"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { isPayableStatus, normalizeJob } from "@/lib/workiz/normalize"
import { renderTemplate } from "@/lib/notifications/template"

const settings = DEFAULT_WORKIZ_SETTINGS
const noCatalog = new Map<string, boolean>()

const baseJob = {
  UUID: "abc-123",
  SerialId: "1042",
  Status: "Done",
  FirstName: "Jane",
  LastName: "Doe",
  Team: [
    { id: 11, Name: "Vadim" },
    { id: 12, Name: "Denis" },
  ],
  Tags: ["shower"],
}

describe("normalizeJob – revenue & discounts", () => {
  it("uses SubTotal as the post-discount, pre-tax service revenue", () => {
    const job = normalizeJob(
      {
        ...baseJob,
        SubTotal: 900,
        JobTotal: 963,
        TaxAmount: 63,
        Discount: 100,
        Items: [
          { Name: "Frameless shower door", Price: 800, Quantity: 1 },
          { Name: "Color Seal upgrade", Price: 200, Quantity: 1 },
        ],
        Payments: [{ Amount: 963, Method: "Credit Card" }],
      },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(900)
    expect(job.discountAmount).toBe(100)
    // Color seal 200 of 1000 gross scales to 900 net → 180
    expect(job.colorSealTotal).toBe(180)
    expect(job.taxAmount).toBe(63)
    // Card payment of 963 (with tax) scaled to pre-tax 900
    expect(job.cardServiceAmount).toBe(900)
    expect(job.nonCardServiceAmount).toBe(0)
    expect(job.fullyPaid).toBe(true)
  })

  it("derives discounts from negative line items when Workiz gives no Discount field", () => {
    const job = normalizeJob(
      {
        ...baseJob,
        Items: [
          { Name: "Install", Price: 500, Quantity: 1 },
          { Name: "Promo", Price: -50, Quantity: 1 },
        ],
        Payments: [{ Amount: 450, Method: "Check" }],
      },
      settings,
      noCatalog,
    )
    expect(job.discountAmount).toBe(50)
    expect(job.jobTotal).toBe(450)
    expect(job.nonCardServiceAmount).toBe(450)
  })
})

describe("normalizeJob – mixed payments and tips", () => {
  it("splits card vs non-card service dollars and keeps tips separate", () => {
    const job = normalizeJob(
      {
        ...baseJob,
        SubTotal: 1000,
        JobTotal: 1000,
        Items: [{ Name: "Enclosure", Price: 1000, Quantity: 1 }],
        Payments: [
          { Amount: 600, Method: "Visa" },
          { Amount: 400, Method: "Zelle" },
          { Amount: 40, Method: "Visa", IsTip: true },
          { Amount: 20, Method: "Cash", IsTip: true },
        ],
      },
      settings,
      noCatalog,
    )
    expect(job.cardServiceAmount).toBe(600)
    expect(job.nonCardServiceAmount).toBe(400)
    expect(job.cardTipAmount).toBe(40)
    expect(job.nonCardTipAmount).toBe(20)
    expect(job.fullyPaid).toBe(true)

    const rates = { nonColorRate: 0.2, colorRate: 0.25 }
    const result = calcPayoutWithPaymentSplit(
      { jobTotal: 1000, colorSealTotal: 0, cardServiceAmount: 600, cardTip: 40, nonCardOwedTip: 20 },
      rates,
      { separateColorSeal: true, tipShare: 0.5 },
    )
    // Card part: 600*0.965*0.2 = 115.8, non-card part: 400*0.2 = 80
    expect(result.basePayout).toBeCloseTo(195.8, 10)
    // Tips: 40*0.965*0.5 = 19.3, 20*0.5 = 10
    expect(result.tipPayout).toBeCloseTo(29.3, 10)
    expect(result.mode).toBe("split")

    // Sanity: equals summing two legacy runs, one per payment type.
    const cardLegacy = calcLegacyJobPayout({ jobTotal: 600, colorSealTotal: 0, tip: 40, isCreditCard: true }, rates, { separateColorSeal: true, tipShare: 0.5 })
    const cashLegacy = calcLegacyJobPayout({ jobTotal: 400, colorSealTotal: 0, tip: 20, isCreditCard: false }, rates, { separateColorSeal: true, tipShare: 0.5 })
    expect(result.totalPayout).toBeCloseTo(cardLegacy.totalPayout + cashLegacy.totalPayout, 10)
  })

  it("splits a payment that carries an embedded Tip amount", () => {
    const job = normalizeJob(
      {
        ...baseJob,
        SubTotal: 500,
        Items: [{ Name: "Door", Price: 500, Quantity: 1 }],
        Payments: [{ Amount: 550, Method: "Mastercard", Tip: 50 }],
      },
      settings,
      noCatalog,
    )
    expect(job.cardServiceAmount).toBe(500)
    expect(job.cardTipAmount).toBe(50)
    expect(job.nonCardTipAmount).toBe(0)
  })

  it("treats a 'Tip' line item as a tip, not service revenue", () => {
    const job = normalizeJob(
      {
        ...baseJob,
        Items: [
          { Name: "Door", Price: 500, Quantity: 1 },
          { Name: "Tip", Price: 25, Quantity: 1 },
        ],
        Payments: [{ Amount: 525, Method: "Check" }],
      },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(500)
    expect(job.nonCardTipAmount).toBe(25)
    expect(job.nonCardServiceAmount).toBe(500)
  })

  it("flags jobs with no payment data and assumes non-card", () => {
    const job = normalizeJob({ ...baseJob, SubTotal: 300, Items: [{ Name: "Door", Price: 300 }] }, settings, noCatalog)
    expect(job.warnings.some((w) => w.startsWith("No payment records"))).toBe(true)
    expect(job.nonCardServiceAmount).toBe(300)
    expect(job.fullyPaid).toBe(false)
  })
})

describe("normalizeJob – color seal detection", () => {
  it("prefers catalog product ids over keyword matching", () => {
    const catalog = new Map<string, boolean>([["77", true], ["78", false]])
    const job = normalizeJob(
      {
        ...baseJob,
        SubTotal: 300,
        Items: [
          { id: 77, Name: "Premium finish", Price: 100 },
          { id: 78, Name: "Color Seal (legacy sku)", Price: 100 },
          { Name: "Glass", Price: 100 },
        ],
        Payments: [{ Amount: 300, Method: "Cash" }],
      },
      settings,
      catalog,
    )
    expect(job.colorSealTotal).toBe(100)
    expect(job.lineItems.find((i) => i.id === "77")?.matchedBy).toBe("catalog")
    expect(job.lineItems.find((i) => i.id === "78")?.isColorSeal).toBe(false)
  })
})

describe("payable status gating", () => {
  it("matches configured statuses case-insensitively", () => {
    expect(isPayableStatus("done", settings)).toBe(true)
    expect(isPayableStatus("Completed", settings)).toBe(true)
    expect(isPayableStatus("Submitted", settings)).toBe(false)
    expect(isPayableStatus(null, settings)).toBe(false)
  })
})

describe("notification template", () => {
  it("renders placeholders and leaves unknown ones visible", () => {
    const out = renderTemplate("Hi {{technician}}: {{totalPayout}} {{unknownKey}}", {
      technician: "Vadim",
      jobSerial: "1",
      jobUuid: "u",
      clientName: "c",
      jobTotal: "$1.00",
      discountLine: "",
      colorSealLine: "",
      tipLine: "",
      basePayout: "$0.20",
      tipPayout: "$0.00",
      totalPayout: "$0.20",
      status: "ready",
      holdReason: "",
    })
    expect(out).toBe("Hi Vadim: $0.20 {{unknownKey}}")
  })
})
