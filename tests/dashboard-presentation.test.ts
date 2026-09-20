import { describe, expect, it } from "vitest"
import type { TechnicianProfile } from "@/lib/db/schema"
import { calcPayoutWithPaymentSplit } from "@/lib/payout/calculator"
import { cardFeeWithheld, computeForProfile } from "@/lib/payout/engine"
import { completionState, explainPayoutStatus, lineItemOwnership, paymentMethodsSummary, workizJobUrl } from "@/lib/payout/presentation"
import { wholeJobSegment } from "@/lib/payout/segments"
import { parseWorkizDate } from "@/lib/workiz/time"

describe("parseWorkizDate", () => {
  it("pins naive Workiz wall-clock strings to the business timezone", () => {
    // 9:00 AM in New York on Sep 24 (EDT, UTC-4) is 13:00Z.
    expect(parseWorkizDate("2026-09-24 09:00:00", "America/New_York")?.toISOString()).toBe("2026-09-24T13:00:00.000Z")
    // Same wall clock in January (EST, UTC-5) is 14:00Z.
    expect(parseWorkizDate("2026-01-15 09:00:00", "America/New_York")?.toISOString()).toBe("2026-01-15T14:00:00.000Z")
    // Date-only strings are local midnight, not UTC midnight.
    expect(parseWorkizDate("2026-09-17", "America/New_York")?.toISOString()).toBe("2026-09-17T04:00:00.000Z")
  })

  it("leaves strings that carry their own offset alone and rejects junk", () => {
    expect(parseWorkizDate("2026-09-24T09:00:00Z", "America/New_York")?.toISOString()).toBe("2026-09-24T09:00:00.000Z")
    expect(parseWorkizDate("2026-09-24T09:00:00-04:00", "America/New_York")?.toISOString()).toBe("2026-09-24T13:00:00.000Z")
    expect(parseWorkizDate("0000-00-00 00:00:00", "America/New_York")).toBeNull()
    expect(parseWorkizDate("", "America/New_York")).toBeNull()
    expect(parseWorkizDate(null, "America/New_York")).toBeNull()
  })
})

describe("completionState", () => {
  const payable = ["Done", "Completed", "Paid"]
  it("never substitutes a scheduled or sync time for completion", () => {
    expect(completionState({ status: "Submitted", payableStatuses: payable, lastStatusUpdate: new Date("2026-09-18T15:02:17Z") })).toEqual({ state: "not-completed", status: "Submitted" })
  })
  it("uses the status-change time only once the job is in a finished status", () => {
    expect(completionState({ status: "Done", payableStatuses: payable, lastStatusUpdate: new Date("2026-09-18T15:02:17Z") })).toEqual({ state: "completed", at: "2026-09-18T15:02:17.000Z" })
    expect(completionState({ status: "done", payableStatuses: payable, lastStatusUpdate: null }).state).toBe("unknown")
    expect(completionState({ status: null, payableStatuses: payable, lastStatusUpdate: null }).state).toBe("unknown")
  })
})

describe("paymentMethodsSummary", () => {
  it("labels a card deposit plus check balance as mixed", () => {
    const summary = paymentMethodsSummary([
      { id: "1", amount: 500, method: "Credit Card", isCard: true, isTip: false, date: "2026-09-10" },
      { id: "2", amount: 962.02, method: "Check", isCard: false, isTip: false, date: "2026-09-24" },
    ])
    expect(summary).toEqual({ label: "Card + Check", mixed: true, count: 2 })
  })
  it("ignores tip payments when service payments exist and reports empty lists honestly", () => {
    expect(paymentMethodsSummary([{ id: "1", amount: 100, method: "Zelle", isCard: false, isTip: false, date: null }, { id: "2", amount: 20, method: "Cash", isCard: false, isTip: true, date: null }]).label).toBe("Zelle")
    expect(paymentMethodsSummary([])).toEqual({ label: "No payments recorded", mixed: false, count: 0 })
  })
})

describe("explainPayoutStatus", () => {
  it("turns engine hold reasons into a specific reason and action", () => {
    const pending = explainPayoutStatus({ status: "pending", holdReason: 'Job status "Submitted" is not payable', jobStatus: "Submitted", fullyPaid: false, totalPaid: 0, grandTotal: 1462.02, paidAt: null, paidBy: null })
    expect(pending.headline).toMatch(/not finished/)
    expect(pending.action).toMatch(/payable status/)

    const balance = explainPayoutStatus({ status: "hold", holdReason: "Job is not fully paid", jobStatus: "Done", fullyPaid: false, totalPaid: 500, grandTotal: 1462.02, paidAt: null, paidBy: null })
    expect(balance.headline).toMatch(/balance outstanding/)
    expect(balance.detail).toContain("$962.02")

    const unmapped = explainPayoutStatus({ status: "hold", holdReason: "Job has unmapped team members (433925)", jobStatus: "Done", fullyPaid: true, totalPaid: 0, grandTotal: 0, paidAt: null, paidBy: null })
    expect(unmapped.detail).toContain("433925")
    expect(unmapped.action).toMatch(/Team mapping/)
  })
})

describe("lineItemOwnership", () => {
  it("keeps marked (Tim) items distinct from crew work using saved indexes", () => {
    const crewSegment = { segmentKind: "crew", segmentItemIndexes: [0, 2], segmentItemNames: ["Floor", "Shower"] }
    expect(lineItemOwnership({ ...crewSegment, itemIndex: 0, itemName: "Floor" })).toBe("this-technician")
    expect(lineItemOwnership({ ...crewSegment, itemIndex: 1, itemName: "*T* Regrout" })).toBe("dedicated")
    const timSegment = { segmentKind: "dedicated", segmentItemIndexes: [1], segmentItemNames: ["*T* Regrout"] }
    expect(lineItemOwnership({ ...timSegment, itemIndex: 1, itemName: "*T* Regrout" })).toBe("this-technician")
    expect(lineItemOwnership({ ...timSegment, itemIndex: 0, itemName: "Floor" })).toBe("crew")
    expect(lineItemOwnership({ segmentKind: "job", segmentItemIndexes: null, segmentItemNames: null, itemIndex: 0, itemName: "Floor" })).toBe("whole-job")
  })
})

describe("cardFeeWithheld", () => {
  const profile = {
    id: 1,
    name: "Vadim",
    pinHash: "",
    nonColorRate: "0.200000",
    colorRate: "0.250000",
    tipShare: "0.500000",
    separateColorSeal: true,
    lineItemMarker: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as TechnicianProfile

  it("equals the difference between the fee-free and fee-applied calculator results", () => {
    const segment = {
      ...wholeJobSegment({ jobTotal: 1000, colorSealTotal: 400, discountAmount: 0, cardServiceAmount: 600, nonCardServiceAmount: 400, cardTipAmount: 100, nonCardTipAmount: 50, lineItems: [] }),
    }
    const withFee = computeForProfile(segment, profile)
    const feeFree = calcPayoutWithPaymentSplit(
      { jobTotal: 1000, colorSealTotal: 400, cardServiceAmount: 0, cardTip: 0, nonCardOwedTip: 150 },
      { nonColorRate: 0.2, colorRate: 0.25 },
      { separateColorSeal: true, tipShare: 0.5 },
    )
    expect(cardFeeWithheld(withFee, segment, profile)).toBeCloseTo(feeFree.totalPayout - withFee.totalPayout, 4)
  })

  it("is zero when nothing was paid by card", () => {
    const segment = wholeJobSegment({ jobTotal: 1000, colorSealTotal: 0, discountAmount: 0, cardServiceAmount: 0, nonCardServiceAmount: 1000, cardTipAmount: 0, nonCardTipAmount: 0, lineItems: [] })
    expect(cardFeeWithheld(computeForProfile(segment, profile), segment, profile)).toBe(0)
  })
})

describe("workizJobUrl", () => {
  it("builds the app link from the UUID only", () => {
    expect(workizJobUrl("DBOE3J")).toBe("https://app.workiz.com/job/DBOE3J/")
    expect(workizJobUrl("bad uuid/../x")).toBeNull()
    expect(workizJobUrl(null)).toBeNull()
  })
})
