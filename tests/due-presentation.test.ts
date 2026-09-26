import { describe, expect, it } from "vitest"
import type { NormalizedPayment } from "@/lib/db/schema"
import { groupCustomerPayments, jobMoneySummary, jobTotalQualifier } from "@/lib/payout/due-presentation"

const pay = (over: Partial<NormalizedPayment>): NormalizedPayment => ({ id: null, amount: 0, method: "Cash", isCard: false, isTip: false, date: null, ...over })

describe("groupCustomerPayments", () => {
  it("folds a card payment and its tip back into one transaction and labels deposit / final", () => {
    // Live #924884: manual rows Card 712.82, then Card 1776.11 that included a 231.67 tip.
    const lines = groupCustomerPayments([
      pay({ id: "manual:2", amount: 1544.44, method: "Card", isCard: true, date: "2026-09-24T13:00:00.000Z", source: "manual" }),
      pay({ id: "manual:2:tip", amount: 231.67, method: "Card", isCard: true, isTip: true, date: "2026-09-24T13:00:00.000Z", source: "manual" }),
      pay({ id: "manual:1", amount: 712.82, method: "Card", isCard: true, date: "2026-09-20T19:10:00.000Z", source: "manual" }),
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ label: "Deposit", amount: 712.82, tipAmount: 0, date: "2026-09-20T19:10:00.000Z" })
    expect(lines[1]).toMatchObject({ label: "Final", amount: 1776.11, tipAmount: 231.67 })
  })

  it("labels a single payment plainly and numbers the middle ones", () => {
    expect(groupCustomerPayments([pay({ id: "a", amount: 50 })]).map((l) => l.label)).toEqual(["Payment"])
    const three = groupCustomerPayments([
      pay({ id: "a", amount: 10, date: "2026-01-01T00:00:00Z" }),
      pay({ id: "b", amount: 20, date: "2026-01-02T00:00:00Z" }),
      pay({ id: "c", amount: 30, date: "2026-01-03T00:00:00Z" }),
    ])
    expect(three.map((l) => l.label)).toEqual(["Deposit", "Payment 2", "Final"])
  })

  it("never invents dates or merges unrelated undated records", () => {
    const lines = groupCustomerPayments([pay({ amount: 10 }), pay({ amount: 20, isTip: true })])
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.date === null)).toBe(true)
    expect(lines[1].label).toBe("Final (tip only)")
    expect(groupCustomerPayments(null)).toEqual([])
  })

  it("keeps an unrecognised method flagged", () => {
    const [line] = groupCustomerPayments([pay({ id: "x", amount: 5, method: "Other", methodKnown: false })])
    expect(line.methodKnown).toBe(false)
  })
})

describe("jobMoneySummary", () => {
  const base = { jobTotal: "2257.26", taxAmount: "0", discountAmount: "118.80", colorSealTotal: "900.95", cardTipAmount: "231.67", nonCardTipAmount: "0" }

  it("prefers Workiz's own total and says what it includes", () => {
    const s = jobMoneySummary({ ...base, invoiceTotal: 2488.93 })
    expect(s).toMatchObject({ jobTotal: 2488.93, basis: "workiz-total", includesTip: true, includesTax: false, servicesAfterDiscount: 2257.26, colorSealAfterDiscount: 900.95, discount: 118.8, tip: 231.67 })
    expect(jobTotalQualifier(s)).toBe("Workiz total, incl. tip")
  })

  it("falls back to services plus tax when Workiz gave no total", () => {
    const s = jobMoneySummary({ ...base, taxAmount: "12.50", invoiceTotal: null })
    expect(s.jobTotal).toBe(2269.76)
    expect(s.basis).toBe("services-plus-tax")
    expect(jobTotalQualifier(s)).toBe("services after discount + tax")
    expect(jobTotalQualifier(jobMoneySummary({ ...base, invoiceTotal: null }))).toBe("services after discount")
  })

  it("treats missing numbers as zero, not as invented values", () => {
    const s = jobMoneySummary({ jobTotal: null, taxAmount: null, discountAmount: null, colorSealTotal: null, cardTipAmount: null, nonCardTipAmount: null, invoiceTotal: null })
    expect(s).toMatchObject({ jobTotal: 0, discount: 0, tip: 0, colorSealAfterDiscount: 0 })
  })
})
