import { describe, expect, it } from "vitest"
import { payoutMath, percent } from "@/lib/payout/due-presentation"

/** The saved row for the owner's $1,000 / $300 card / $700 check example, standard technician. */
const row = {
  jobTotal: "1000.00",
  colorSealTotal: "0.00",
  nonColorRate: "0.200000",
  colorRate: "0.250000",
  tipShare: "0.500000",
  nonColorPayout: "197.9000",
  colorPayout: "0.0000",
  tipPayout: "0.0000",
  totalPayout: "197.9000",
  cardTipAmount: "0.00",
  nonCardTipAmount: "0.00",
  breakdown: { cardFeeAdjustment: 2.1, invoiceFee: { cardShare: 0.3, cardPaid: 300 } },
  job: { cardServiceAmount: "300.00", nonCardServiceAmount: "700.00", jobTotal: "1000.00" },
}

describe("payoutMath reads the saved calculation back for the Due breakdown", () => {
  it("shows the card share, the effective 1.05% deduction and the $2.10 withheld from a $200 commission", () => {
    const m = payoutMath(row)
    expect(m.serviceBase).toBe(1000)
    expect(m.cardShare).toBeCloseTo(0.3, 12)
    expect(m.cardPaid).toBe(300)
    expect(m.effectiveFeePercent).toBe(1.05)
    expect(m.feeWithheld).toBe(2.1) // 200 - 197.90
    expect(m.regularRate).toBe(0.2)
    expect(m.regularPayout).toBe(197.9)
    expect(m.totalPayout).toBe(197.9)
    expect(m.hasCard).toBe(true)
    expect(m.hasColor).toBe(false)
    expect(m.hasTip).toBe(false)
  })

  it("falls back to the job snapshot when the breakdown has no invoice fee block", () => {
    const m = payoutMath({ ...row, breakdown: {} })
    expect(m.cardShare).toBeCloseTo(0.3, 12)
    expect(m.cardPaid).toBe(300)
    expect(m.feeWithheld).toBe(0)
  })

  it("reports no card fee for an all-check job", () => {
    const m = payoutMath({ ...row, nonColorPayout: "200.0000", totalPayout: "200.0000", breakdown: { cardFeeAdjustment: 0, invoiceFee: { cardShare: 0, cardPaid: 0 } }, job: { cardServiceAmount: "0.00", nonCardServiceAmount: "1000.00", jobTotal: "1000.00" } })
    expect(m.hasCard).toBe(false)
    expect(m.feeWithheld).toBe(0)
    expect(m.effectiveFeePercent).toBe(0)
  })

  it("carries color sealing and tip parts separately", () => {
    const m = payoutMath({ ...row, colorSealTotal: "400.00", nonColorPayout: "118.7400", colorPayout: "98.9500", tipPayout: "48.2500", totalPayout: "265.9400", cardTipAmount: "100.00" })
    expect(m.regularBase).toBe(600)
    expect(m.colorBase).toBe(400)
    expect(m.hasColor).toBe(true)
    expect(m.hasTip).toBe(true)
    expect(m.colorPayout).toBe(98.95)
    expect(m.tipPayout).toBe(48.25)
  })

  it("formats percentages without trailing zeros", () => {
    expect(percent(0.2)).toBe("20%")
    expect(percent(0.25)).toBe("25%")
    expect(percent(0.3, 1)).toBe("30%")
    expect(percent(0.226973684, 1)).toBe("22.7%")
    expect(percent(0.5)).toBe("50%")
  })
})
