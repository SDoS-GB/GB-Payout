import { describe, expect, it } from "vitest"
import { calcLegacyJobPayout, calcPayoutWithPaymentSplit } from "@/lib/payout/calculator"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { UNITEMIZED_SURPLUS_PREFIX, isBlockingWarning, isPayableStatus, normalizeJob } from "@/lib/workiz/normalize"
import { externalRowsToPayments, TIP_INCLUSION_RAW_KEY } from "@/lib/workiz/payments"

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
  // Verified against live job/get payloads (Sept 2026): SubTotal is the PRE-discount sum of the
  // service lines, discounts are LineItems with Type "DISCOUNT_TYPE" and a positive Price, and
  // JobTotalPrice = SubTotal - discounts (+ unitemized tax). 7 of 9 discounted live jobs matched exactly.
  it("treats SubTotal as pre-discount and subtracts DISCOUNT_TYPE lines to reach the service revenue", () => {
    const job = normalizeJob(
      {
        ...baseJob,
        SubTotal: 1000,
        JobTotalPrice: 963,
        TaxAmount: 63,
        LineItems: [
          { Name: "Frameless shower door", Price: 800, Quantity: 1, Type: "service" },
          { Name: "Color Seal upgrade", Price: 200, Quantity: 1, Type: "service" },
          { Name: "discount", Price: 100, Quantity: 1, Type: "DISCOUNT_TYPE" },
        ],
        Payments: [{ Amount: 963, Method: "Credit Card" }],
      },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(900)
    expect(job.discountAmount).toBe(100)
    expect(job.lineItems.find((i) => i.isDiscount)?.total).toBe(-100)
    // Color seal 200 of 1000 gross scales to 900 net → 180
    expect(job.colorSealTotal).toBe(180)
    expect(job.taxAmount).toBe(63)
    // Card payment of 963 (with tax) scaled to pre-tax 900
    expect(job.cardServiceAmount).toBe(900)
    expect(job.nonCardServiceAmount).toBe(0)
    expect(job.fullyPaid).toBe(true)
  })

  it("treats a JobTotalPrice shortfall with no discount line as an unitemized whole-job discount and flags it (live job #924820)", () => {
    const job = normalizeJob(
      { ...baseJob, Team: [{ id: 15, Name: "Tim" }], SubTotal: 475, JobTotalPrice: 425, JobAmountDue: 0, LineItems: [{ Name: "Walk-in Shower Restoration & Seal", Price: 475, Quantity: 1, Type: "service" }] },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(425)
    expect(job.discountAmount).toBe(50)
    expect(job.warnings.some((w) => w.startsWith("Unitemized discount"))).toBe(true)
  })

  it("does not lower the service total when JobTotalPrice is higher; the surplus is a likely tip and holds the payout", () => {
    const job = normalizeJob(
      { ...baseJob, SubTotal: 450, JobTotalPrice: 457.43, JobAmountDue: 0, LineItems: [{ Name: "Regrout", Price: 450, Quantity: 1, Type: "service" }] },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(450)
    expect(job.discountAmount).toBe(0)
    expect(job.unitemizedSurplus).toBe(7.43)
    const surplus = job.warnings.find((w) => w.startsWith(UNITEMIZED_SURPLUS_PREFIX))
    expect(surplus).toMatch(/\$7\.43 above the itemized service total \$450\.00/)
    expect(isBlockingWarning(surplus!)).toBe(true)
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

  it("flags jobs with no payment data or balance as payment-method-unknown and provisionally non-card", () => {
    const job = normalizeJob({ ...baseJob, SubTotal: 300, Items: [{ Name: "Door", Price: 300 }] }, settings, noCatalog)
    expect(job.warnings.some((w) => w.startsWith("Payment method unknown"))).toBe(true)
    expect(job.nonCardServiceAmount).toBe(300)
    expect(job.fullyPaid).toBe(false)
    expect(job.paidEvidence).toBe("none")
  })

  it("uses the Workiz balance as the only paid signal when the payload has no Payments (live shape) and still flags the method", () => {
    const paid = normalizeJob({ ...baseJob, SubTotal: 300, JobTotalPrice: 300, JobAmountDue: 4.5474735088646e-13, LineItems: [{ Name: "Door", Price: 300, Quantity: 1 }] }, settings, noCatalog)
    expect(paid.fullyPaid).toBe(true)
    expect(paid.paidEvidence).toBe("balance")
    expect(paid.totalPaid).toBe(300)
    expect(paid.warnings.some((w) => w.startsWith("Payment method unknown"))).toBe(true)

    const partial = normalizeJob({ ...baseJob, SubTotal: 300, JobTotalPrice: 300, JobAmountDue: 200, LineItems: [{ Name: "Door", Price: 300, Quantity: 1 }] }, settings, noCatalog)
    expect(partial.fullyPaid).toBe(false)
    expect(partial.totalPaid).toBe(100)
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

describe("job #924884 (UUID 1N6S4G): Workiz folds its Tip field into JobTotalPrice without any API field", () => {
  // Stored job/get payload, 2026-09-25. Workiz's own invoice screen: Subtotal 2,376.06, Discount 118.80,
  // Tax 0.00, Tip 231.67, Total 2,488.93; Payments tab: 712.82 card deposit + 1,776.11 card (tip inside it).
  const raw924884 = (over: Record<string, unknown> = {}) => ({
    UUID: "1N6S4G",
    SerialId: 924884,
    Status: "Done",
    JobType: "Estimate",
    Team: [
      { id: 9003, Name: "Arthur" },
      { id: 9004, Name: "Viktor" },
    ],
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
    ...over,
  })

  const manualRow = (id: number, method: string, amount: number, tip: number) => ({
    id,
    externalId: null,
    source: "manual",
    method,
    amount: amount.toFixed(2),
    tipAmount: tip.toFixed(2),
    paidAt: new Date("2026-09-25T21:00:00.000Z"),
    recordedBy: "admin",
    raw: tip > 0 ? { [TIP_INCLUSION_RAW_KEY]: "included" } : null,
  })

  it("from the job payload alone: S 2257.26, color 900.95, and a $231.67 surplus that is flagged as a likely tip", () => {
    const job = normalizeJob(raw924884(), settings, noCatalog)
    expect(job.subTotal).toBe(2376.06)
    expect(job.discountAmount).toBe(118.8)
    expect(job.jobTotal).toBe(2257.26)
    // 948.37 x (2257.26 / 2376.06) = 948.37 x 0.95 = 900.9515
    expect(job.colorSealTotal).toBe(900.95)
    expect(job.cardTipAmount + job.nonCardTipAmount).toBe(0)
    expect(job.unitemizedSurplus).toBe(231.67)
    expect(job.warnings.some((w) => w.startsWith(UNITEMIZED_SURPLUS_PREFIX) && w.includes("$231.67"))).toBe(true)
    // Clear grout sealing is regular work; it must not be reported as a missed color-seal item.
    expect(job.warnings.some((w) => w.includes("mention"))).toBe(false)
    expect(job.lineItems.filter((i) => i.isColorSeal).map((i) => i.name)).toEqual(["Grout Color Sealing – Floors (All Areas)"])
  })

  it("admin-confirmed card payments with the tip inside the final charge: paid in full, all card, tip $231.67 by card, no surplus left", () => {
    const external = externalRowsToPayments([manualRow(1, "Card", 712.82, 0), manualRow(2, "Card", 1776.11, 231.67)], settings.cardMethodKeywords)
    expect(external.map((p) => [p.isTip, p.amount])).toEqual([
      [false, 712.82],
      [false, 1544.44],
      [true, 231.67],
    ])
    const job = normalizeJob(raw924884(), settings, noCatalog, { externalPayments: external })
    expect(job.cardServiceAmount).toBe(2257.26)
    expect(job.nonCardServiceAmount).toBe(0)
    expect(job.cardTipAmount).toBe(231.67)
    expect(job.nonCardTipAmount).toBe(0)
    expect(job.totalPaid).toBe(2488.93)
    expect(job.fullyPaid).toBe(true)
    expect(job.paidEvidence).toBe("payments")
    expect(job.unitemizedSurplus).toBe(0)
    expect(job.warnings.filter(isBlockingWarning)).toEqual([])
  })

  it("confirming the two card payments without the tip keeps the surplus hold and records no tip", () => {
    const external = externalRowsToPayments([manualRow(1, "Card", 712.82, 0), manualRow(2, "Card", 1776.11, 0)], settings.cardMethodKeywords)
    const job = normalizeJob(raw924884(), settings, noCatalog, { externalPayments: external })
    expect(job.fullyPaid).toBe(true)
    expect(job.cardServiceAmount).toBe(2257.26) // 2488.93 of card money scaled onto the service total
    expect(job.cardTipAmount + job.nonCardTipAmount).toBe(0)
    expect(job.unitemizedSurplus).toBe(231.67)
    expect(job.warnings.filter(isBlockingWarning).map((w) => w.split(":")[0])).toEqual([UNITEMIZED_SURPLUS_PREFIX])
  })

  it("a tip handed to the technician on top of the invoice never counts toward the balance", () => {
    // Same job, but Workiz's total carries no tip; a $40 cash tip is recorded on its own.
    const external = externalRowsToPayments([manualRow(1, "Card", 2257.26, 0), manualRow(2, "Cash", 40, 40)], settings.cardMethodKeywords)
    const job = normalizeJob(raw924884({ JobTotalPrice: 2257.26 }), settings, noCatalog, { externalPayments: external })
    expect(job.nonCardTipAmount).toBe(40)
    expect(job.unitemizedSurplus).toBe(0)
    expect(job.totalPaid).toBe(2297.26)
    expect(job.fullyPaid).toBe(true)
    expect(job.warnings.filter(isBlockingWarning)).toEqual([])
  })
})
