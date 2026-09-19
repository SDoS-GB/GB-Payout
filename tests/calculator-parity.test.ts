import { describe, expect, it } from "vitest"
import { CONTRACTORS, CONTRACTOR_NAMES, legacyProfileOptions } from "@/lib/payout/contractors"
import { calcLegacyJobPayout, calcPayoutWithPaymentSplit, formatCurrency } from "@/lib/payout/calculator"

/**
 * FROZEN copy of `calcJobPayout` exactly as it existed in app/page.tsx before
 * the Workiz work started (commit 91b2b65). Do not edit. It is the oracle every
 * extracted function is compared against.
 */
const LEGACY_CONTRACTORS = {
  Vadim: { pin: "4826", nonColorRate: 0.25, colorRate: 0.25 },
  Denis: { pin: "7155", nonColorRate: 0.2, colorRate: 0.25 },
  Arthur: { pin: "5183", nonColorRate: 0.2, colorRate: 0.25 },
  Viktor: { pin: "3515", nonColorRate: 0.2, colorRate: 0.25 },
  Tim: { pin: "4496", nonColorRate: 0.8, colorRate: 0.8 },
  Alex: { pin: "8254", nonColorRate: 0.2, colorRate: 0.25 },
  Rodion: { pin: "8585", nonColorRate: 0.2, colorRate: 0.25 },
} as const

interface LegacyJob {
  jobTotal: string
  colorSealTotal: string
  tip: string
  isCreditCard: boolean
}

function legacyCalcJobPayout(job: LegacyJob, contractorName: string, selectedContractor: string) {
  const rates = LEGACY_CONTRACTORS[contractorName as keyof typeof LEGACY_CONTRACTORS]
  const showColorSeal = selectedContractor !== "Tim"
  const parseNumber = (value: string): number => {
    const num = Number.parseFloat(value) || 0
    return num < 0 ? 0 : num
  }
  const jobTotalNum = parseNumber(job.jobTotal)
  const colorSealTotalNum = parseNumber(job.colorSealTotal)
  const tipNum = parseNumber(job.tip)
  const nonColorAmount = showColorSeal ? jobTotalNum - colorSealTotalNum : jobTotalNum
  const colorAmount = showColorSeal ? colorSealTotalNum : 0

  const fee = job.isCreditCard ? 0.965 : 1
  const nonColorPayout = nonColorAmount * fee * rates.nonColorRate
  const colorPayout = colorAmount * fee * rates.colorRate

  let tipPayout = 0
  if (tipNum > 0) {
    const tipDivisor = contractorName === "Tim" ? 1 : 0.5
    tipPayout = tipNum * fee * tipDivisor
  }

  const basePayout = nonColorPayout + colorPayout
  const totalPayout = basePayout + tipPayout
  return { nonColorPayout, colorPayout, tipPayout, basePayout, totalPayout, nonColorAmount, colorAmount, jobTotalNum, colorSealTotalNum, tipNum }
}

const AMOUNTS = ["0", "1", "0.01", "99.99", "100", "123.45", "500", "900", "1000", "1487.16", "2333.33", "4999.97", "10000"]
const TIPS = ["0", "1", "0.01", "20", "50", "100", "156.15", "333.33"]

describe("contractor constants are unchanged", () => {
  it("matches the frozen table exactly", () => {
    expect(CONTRACTORS).toEqual(LEGACY_CONTRACTORS)
  })
})

describe("calcLegacyJobPayout is bit-identical to the original calcJobPayout", () => {
  for (const name of CONTRACTOR_NAMES) {
    it(`parity for ${name} across the input grid (all-card and all-non-card)`, () => {
      let checked = 0
      for (const jobTotal of AMOUNTS) {
        for (const colorSeal of AMOUNTS) {
          if (Number(colorSeal) > Number(jobTotal)) continue
          for (const tip of TIPS) {
            for (const isCreditCard of [true, false]) {
              const job = { jobTotal, colorSealTotal: colorSeal, tip, isCreditCard }
              // The page derives showColorSeal from the logged-in contractor; for every
              // real login that is the technician being calculated (or Vadim viewing Denis,
              // where both are non-Tim). Use the technician's own flag.
              const expected = legacyCalcJobPayout(job, name, name)
              const actual = calcLegacyJobPayout(job, CONTRACTORS[name], legacyProfileOptions(name))
              expect(actual).toStrictEqual(expected)
              // Display strings must also match (toFixed(2) as the UI shows them).
              expect(formatCurrency(actual.totalPayout)).toBe(formatCurrency(expected.totalPayout))
              checked++
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(1000)
    })
  }

  it("Vadim viewing Denis's summary matches the legacy cross-contractor path", () => {
    const job = { jobTotal: "1487.16", colorSealTotal: "600", tip: "156.15", isCreditCard: true }
    const expected = legacyCalcJobPayout(job, "Denis", "Vadim")
    const actual = calcLegacyJobPayout(job, CONTRACTORS.Denis, legacyProfileOptions("Denis"))
    expect(actual).toStrictEqual(expected)
  })

  it("negative and garbage inputs behave like the original parseNumber", () => {
    const job = { jobTotal: "-50", colorSealTotal: "abc", tip: "", isCreditCard: false }
    const expected = legacyCalcJobPayout(job, "Denis", "Denis")
    const actual = calcLegacyJobPayout(job, CONTRACTORS.Denis, legacyProfileOptions("Denis"))
    expect(actual).toStrictEqual(expected)
    expect(actual.totalPayout).toBe(0)
  })
})

describe("known screenshot fixture (20% regular / 25% color profile, two-tech split)", () => {
  const rates = { nonColorRate: 0.2, colorRate: 0.25 }
  const options = { separateColorSeal: true, tipShare: 0.5 }

  it("Job $1,000 / Color $500 / Tip $100 non-card = $275.00", () => {
    const r = calcLegacyJobPayout({ jobTotal: "1000", colorSealTotal: "500", tip: "100", isCreditCard: false }, rates, options)
    expect(formatCurrency(r.totalPayout)).toBe("$275.00")
  })

  it("Job $1,000 / Color $500 / Tip $100 all-card = $265.38", () => {
    const r = calcLegacyJobPayout({ jobTotal: "1000", colorSealTotal: "500", tip: "100", isCreditCard: true }, rates, options)
    expect(formatCurrency(r.totalPayout)).toBe("$265.38")
  })

  it("screenshot job: service $1,487.16 is the service input, tip $156.15 separate (not $1,643.31)", () => {
    const r = calcLegacyJobPayout({ jobTotal: "1487.16", colorSealTotal: "0", tip: "156.15", isCreditCard: false }, rates, options)
    expect(r.jobTotalNum).toBe(1487.16)
    expect(r.tipNum).toBe(156.15)
    expect(formatCurrency(r.totalPayout)).toBe(formatCurrency(1487.16 * 0.2 + 156.15 * 0.5))
  })
})

describe("calcPayoutWithPaymentSplit", () => {
  const rates = { nonColorRate: 0.2, colorRate: 0.25 }
  const options = { separateColorSeal: true, tipShare: 0.5 }

  it("mixed fixture: $1,000 service, $400 color, $400 card + $600 check = $216.92", () => {
    const r = calcPayoutWithPaymentSplit(
      { jobTotal: 1000, colorSealTotal: 400, cardServiceAmount: 400, cardTip: 0, nonCardOwedTip: 0 },
      rates,
      options,
    )
    expect(r.mode).toBe("split")
    expect(formatCurrency(r.totalPayout)).toBe("$216.92")
    expect(r.cardNonColorAmount + r.nonCardNonColorAmount).toBeCloseTo(600, 10)
    expect(r.cardColorAmount + r.nonCardColorAmount).toBeCloseTo(400, 10)
  })

  it("$200 card + $800 check on $1,000 (no color) reflects a $7 fee effect through the rate", () => {
    const r = calcPayoutWithPaymentSplit(
      { jobTotal: 1000, colorSealTotal: 0, cardServiceAmount: 200, cardTip: 0, nonCardOwedTip: 0 },
      rates,
      options,
    )
    // 200*0.965*0.2 + 800*0.2 = 38.6 + 160 = 198.6 ; the $7 fee costs the tech 7*0.2 = $1.40
    expect(formatCurrency(r.totalPayout)).toBe("$198.60")
    expect(formatCurrency(1000 * 0.2 - r.totalPayout)).toBe("$1.40")
  })

  for (const name of CONTRACTOR_NAMES) {
    it(`all-card and all-non-card route to the legacy function for ${name}`, () => {
      const rates = CONTRACTORS[name]
      const opts = legacyProfileOptions(name)
      for (const jobTotal of AMOUNTS) {
        for (const colorSeal of AMOUNTS) {
          if (Number(colorSeal) > Number(jobTotal)) continue
          for (const tip of TIPS) {
            const jt = Number(jobTotal)
            const card = calcPayoutWithPaymentSplit(
              { jobTotal: jt, colorSealTotal: Number(colorSeal), cardServiceAmount: jt, cardTip: Number(tip), nonCardOwedTip: 0 },
              rates,
              opts,
            )
            const legacyCard = calcLegacyJobPayout({ jobTotal, colorSealTotal: colorSeal, tip, isCreditCard: true }, rates, opts)
            expect(card.totalPayout).toBe(legacyCard.totalPayout)
            const hasMoney = jt > 0 || Number(tip) > 0
            if (hasMoney) expect(card.mode).toBe("legacy-card")

            const nonCard = calcPayoutWithPaymentSplit(
              { jobTotal: jt, colorSealTotal: Number(colorSeal), cardServiceAmount: 0, cardTip: 0, nonCardOwedTip: Number(tip) },
              rates,
              opts,
            )
            const legacyNonCard = calcLegacyJobPayout({ jobTotal, colorSealTotal: colorSeal, tip, isCreditCard: false }, rates, opts)
            expect(nonCard.totalPayout).toBe(legacyNonCard.totalPayout)
            if (hasMoney) expect(nonCard.mode).toBe("legacy-non-card")
          }
        }
      }
    })
  }

  it("card tips carry the fee, non-card owed tips do not, and they are never mixed into service", () => {
    const r = calcPayoutWithPaymentSplit(
      { jobTotal: 1000, colorSealTotal: 0, cardServiceAmount: 0, cardTip: 100, nonCardOwedTip: 50 },
      rates,
      options,
    )
    expect(r.mode).toBe("split")
    expect(r.cardTipPayout).toBeCloseTo(100 * 0.965 * 0.5, 10)
    expect(r.nonCardTipPayout).toBeCloseTo(25, 10)
    expect(r.nonColorPayout).toBeCloseTo(200, 10)
  })

  it("solo profile (Tim-style) keeps the whole job as non-color and full tip", () => {
    const r = calcPayoutWithPaymentSplit(
      { jobTotal: 1000, colorSealTotal: 400, cardServiceAmount: 500, cardTip: 40, nonCardOwedTip: 0 },
      CONTRACTORS.Tim,
      legacyProfileOptions("Tim"),
    )
    expect(r.colorAmount).toBe(0)
    expect(r.nonColorAmount).toBe(1000)
    expect(r.cardTipPayout).toBeCloseTo(40 * 0.965, 10)
  })
})
