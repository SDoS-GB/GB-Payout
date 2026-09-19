import { describe, expect, it } from "vitest"
import { CARD_FEE_MULTIPLIER, calcPayoutWithPaymentSplit } from "@/lib/payout/calculator"
import { findMarker, markerLabel, normalizeMarkerTokens, parseMarkerTokens, planSegments, segmentJob, type JobSegment } from "@/lib/payout/segments"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { normalizeJob } from "@/lib/workiz/normalize"

const settings = DEFAULT_WORKIZ_SETTINGS
const noCatalog = new Map<string, boolean>()

const TIM = { id: 5, name: "Tim", lineItemMarker: "T, Tim", nonColorRate: "0.8", colorRate: "0.8", tipShare: "1", separateColorSeal: false }
const VADIM = { id: 1, name: "Vadim", lineItemMarker: null, nonColorRate: "0.25", colorRate: "0.25", tipShare: "0.5", separateColorSeal: true }
const DENIS = { id: 2, name: "Denis", lineItemMarker: null, nonColorRate: "0.2", colorRate: "0.25", tipShare: "0.5", separateColorSeal: true }

const rates = (p: typeof TIM | typeof VADIM) => ({ nonColorRate: Number(p.nonColorRate), colorRate: Number(p.colorRate) })
const options = (p: typeof TIM | typeof VADIM) => ({ separateColorSeal: p.separateColorSeal, tipShare: Number(p.tipShare) })
const payFor = (seg: JobSegment, p: typeof TIM | typeof VADIM) =>
  calcPayoutWithPaymentSplit(
    { jobTotal: seg.jobTotal, colorSealTotal: seg.colorSealTotal, cardServiceAmount: seg.cardServiceAmount, cardTip: seg.cardTipAmount, nonCardOwedTip: seg.nonCardTipAmount },
    rates(p),
    options(p),
  )

/**
 * One invoice, one customer payment, two kinds of work:
 *   crew:  door 800 + color seal 200          = 1000 gross
 *   Tim:   *T* grout 400 + (Tim) color seal 100 = 500 gross
 *   whole-job discount 100 -> SubTotal 1400; paid 1000 card + 400 Zelle; tips 60 card + 40 cash (recorded).
 */
const mixedJob = () =>
  normalizeJob(
    {
      UUID: "mixed-1",
      SerialId: "2001",
      Status: "Done",
      Team: [
        { id: 11, Name: "Vadim" },
        { id: 12, Name: "Denis" },
        { id: 15, Name: "Tim" },
      ],
      SubTotal: 1400,
      JobTotal: 1400,
      Discount: 100,
      Items: [
        { Name: "Frameless shower door", Price: 800, Quantity: 1 },
        { Name: "Color Seal upgrade", Price: 200, Quantity: 1 },
        { Name: "*T* Grout repair in bathroom", Price: 400, Quantity: 1 },
        { Name: "(Tim) Color Seal shower floor", Price: 100, Quantity: 1 },
      ],
      Payments: [
        { Amount: 1000, Method: "Visa" },
        { Amount: 400, Method: "Zelle" },
        { Amount: 60, Method: "Visa", IsTip: true },
        { Amount: 40, Method: "Cash", IsTip: true },
      ],
    },
    settings,
    noCatalog,
  )

describe("marker matching", () => {
  const name = (n: string) => ({ name: n, description: null })

  it("accepts every way dispatch writes the marker at the start of the item", () => {
    for (const n of ["*T* Grout repair in bathroom", "*T Grout repair", "T Grout repair", "(T) Grout repair", "(Tim) Grout repair", "T: regrout", "T - caulk", "[Tim] shower floor", "  *T*Regrout", "t grout"]) {
      expect(findMarker(name(n), "T, Tim"), n).toBe("name")
    }
  })

  it("does not fire on words that merely begin with the token", () => {
    for (const n of ["Tile work", "Tim's shower door", "Timer install", "Trim and caulk", "Bracket *TT*", "Toilet reset T-bolt"]) {
      expect(findMarker(name(n), "T, Tim"), n).toBeNull()
    }
  })

  it("only accepts a bare token at the start, but a wrapped one anywhere", () => {
    expect(findMarker(name("Grout repair T"), "T")).toBeNull()
    expect(findMarker(name("Grout repair Tim"), "T, Tim")).toBeNull()
    expect(findMarker(name("Grout repair *T*"), "T")).toBe("name")
    expect(findMarker(name("Regrout shower (Tim)"), "T, Tim")).toBe("name")
  })

  it("ignores decoration typed into the profile field and normalizes tokens", () => {
    expect(parseMarkerTokens("*T*")).toEqual(["T"])
    expect(parseMarkerTokens(" (T) , Tim ; tim")).toEqual(["T", "Tim"])
    expect(parseMarkerTokens("***")).toEqual([])
    expect(normalizeMarkerTokens("*T*, (Tim)")).toBe("T, Tim")
    expect(normalizeMarkerTokens("  ")).toBeNull()
    expect(markerLabel("T, Tim")).toBe("*T*")
    expect(markerLabel(null)).toBeNull()
    expect(findMarker(name("*T* Grout"), "*T*")).toBe("name")
  })

  it("finds the marker in the Description field and records where it was found", () => {
    const job = normalizeJob(
      {
        UUID: "desc-1",
        Status: "Done",
        Team: [{ id: 11, Name: "Vadim" }, { id: 15, Name: "Tim" }],
        SubTotal: 300,
        Items: [
          { Name: "Door", Price: 200 },
          { Name: "Grout repair", Description: "*T* upstairs bath", Price: 100 },
        ],
        Payments: [{ Amount: 300, Method: "Check" }],
      },
      settings,
      noCatalog,
    )
    expect(job.lineItems[1].description).toBe("*T* upstairs bath")
    const { segments } = segmentJob(job, [TIM.lineItemMarker])
    const tim = segments.find((s) => s.kind === "dedicated")!
    expect(tim.itemNames).toEqual(["Grout repair"])
    expect(tim.markerFields).toEqual(["description"])
    expect(tim.jobTotal).toBe(100)
  })
})

describe("segmentJob – Tim + crew on one invoice", () => {
  it("assigns every item to exactly one segment and the segments sum to the job total", () => {
    const job = mixedJob()
    const { segments, verification, warnings } = segmentJob(job, [TIM.lineItemMarker])
    expect(warnings).toEqual([])
    expect(verification.balanced).toBe(true)
    expect(verification.doubleCountedItems).toBe(0)
    expect(verification.assignedItemCount).toBe(4)

    const tim = segments.find((s) => s.kind === "dedicated")!
    const crew = segments.find((s) => s.kind === "crew")!
    expect(tim.itemIndexes).toEqual([2, 3])
    expect(crew.itemIndexes).toEqual([0, 1])
    expect(tim.itemIndexes.some((i) => crew.itemIndexes.includes(i))).toBe(false)
    expect(Math.round((tim.jobTotal + crew.jobTotal) * 100) / 100).toBe(job.jobTotal)
  })

  it("allocates the whole-job discount proportionally", () => {
    const { segments } = segmentJob(mixedJob(), [TIM.lineItemMarker])
    const tim = segments.find((s) => s.kind === "dedicated")!
    const crew = segments.find((s) => s.kind === "crew")!
    // 100 discount over 1500 gross: Tim 500 -> 466.67, crew 1000 -> 933.33
    expect(tim.jobTotal).toBe(466.67)
    expect(crew.jobTotal).toBe(933.33)
    expect(tim.allocatedDiscountAmount).toBe(33.33)
    expect(crew.allocatedDiscountAmount).toBe(66.67)
  })

  it("keeps Tim's marked color seal out of the crew's color seal total", () => {
    const job = mixedJob()
    // Whole-job color seal counts both color items (300 gross scaled to 280).
    expect(job.colorSealTotal).toBe(280)
    const { segments } = segmentJob(job, [TIM.lineItemMarker])
    const tim = segments.find((s) => s.kind === "dedicated")!
    const crew = segments.find((s) => s.kind === "crew")!
    // Crew color seal is only its own 200 item after the discount ratio.
    expect(crew.colorSealTotal).toBe(186.67)
    expect(tim.colorSealTotal).toBe(93.33)
    expect(Math.round((crew.colorSealTotal + tim.colorSealTotal) * 100) / 100).toBe(job.colorSealTotal)
  })

  it("allocates the card-paid portion proportionally and gives tips to the crew only", () => {
    const { segments } = segmentJob(mixedJob(), [TIM.lineItemMarker])
    const tim = segments.find((s) => s.kind === "dedicated")!
    const crew = segments.find((s) => s.kind === "crew")!
    expect(tim.cardServiceAmount + crew.cardServiceAmount).toBeCloseTo(1000, 2)
    expect(tim.cardServiceAmount).toBe(333.34)
    expect(tim.nonCardServiceAmount).toBe(133.33)
    expect(crew.cardServiceAmount).toBe(666.66)
    expect(crew.nonCardServiceAmount).toBe(266.67)
    expect(tim.cardTipAmount).toBe(0)
    expect(tim.nonCardTipAmount).toBe(0)
    expect(crew.cardTipAmount).toBe(60)
    expect(crew.nonCardTipAmount).toBe(40)
  })

  it("pays Tim 80% of his marked work with the card fee only on his card share, and no tip", () => {
    const { segments } = segmentJob(mixedJob(), [TIM.lineItemMarker])
    const tim = segments.find((s) => s.kind === "dedicated")!
    const result = payFor(tim, TIM)
    const expected = 333.34 * CARD_FEE_MULTIPLIER * 0.8 + 133.33 * 0.8
    expect(result.basePayout).toBeCloseTo(expected, 8)
    expect(result.tipPayout).toBe(0)
    expect(result.totalPayout).toBeCloseTo(expected, 8)
    // Tim's color-seal item is paid at his flat 80%, not through the crew's color calculation.
    expect(result.colorPayout).toBe(0)
  })

  it("pays each crew member their own rates on crew work only, splitting the tip two ways", () => {
    const { segments } = segmentJob(mixedJob(), [TIM.lineItemMarker])
    const crew = segments.find((s) => s.kind === "crew")!

    const vadim = payFor(crew, VADIM)
    const denis = payFor(crew, DENIS)
    // Tip: 60 card * 0.965 * 0.5 + 40 cash * 0.5 — identical for both, Tim excluded from the divisor.
    const expectedTip = 60 * CARD_FEE_MULTIPLIER * 0.5 + 40 * 0.5
    expect(vadim.tipPayout).toBeCloseTo(expectedTip, 8)
    expect(denis.tipPayout).toBeCloseTo(expectedTip, 8)

    // Denis: non-color 746.66 (933.33 - 186.67) at 20%, color 186.67 at 25%, card share 666.66/933.33.
    const share = 666.66 / 933.33
    const nonColor = 933.33 - 186.67
    const expectedDenisBase =
      nonColor * share * CARD_FEE_MULTIPLIER * 0.2 + nonColor * (1 - share) * 0.2 + 186.67 * share * CARD_FEE_MULTIPLIER * 0.25 + 186.67 * (1 - share) * 0.25
    expect(denis.basePayout).toBeCloseTo(expectedDenisBase, 6)
    expect(vadim.basePayout).toBeGreaterThan(denis.basePayout)
  })

  it("keeps a marked negative line with Tim and treats an unmarked one as a whole-job discount", () => {
    const job = normalizeJob(
      {
        UUID: "neg-1",
        Status: "Done",
        Team: [{ id: 11, Name: "Vadim" }, { id: 15, Name: "Tim" }],
        Items: [
          { Name: "Door", Price: 1000 },
          { Name: "Grout *T*", Price: 500 },
          { Name: "Grout promo *T*", Price: -100 },
          { Name: "Spring promo", Price: -140 },
        ],
        Payments: [{ Amount: 1260, Method: "Check" }],
      },
      settings,
      noCatalog,
    )
    expect(job.jobTotal).toBe(1260)
    const { segments, verification } = segmentJob(job, [TIM.lineItemMarker])
    const tim = segments.find((s) => s.kind === "dedicated")!
    const crew = segments.find((s) => s.kind === "crew")!
    // Tim's base is 500 - 100 = 400; pool 1400; the unmarked 140 is spread 400:1000.
    expect(tim.itemDiscountAmount).toBe(100)
    expect(tim.jobTotal).toBe(360)
    expect(tim.allocatedDiscountAmount).toBe(40)
    expect(crew.jobTotal).toBe(900)
    expect(crew.allocatedDiscountAmount).toBe(100)
    expect(verification.balanced).toBe(true)
  })

  it("is a no-op for jobs without any marker", () => {
    const job = mixedJob()
    const { segments, verification } = segmentJob(job, [])
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe("job")
    expect(segments[0].jobTotal).toBe(job.jobTotal)
    expect(segments[0].colorSealTotal).toBe(job.colorSealTotal)
    expect(segments[0].cardServiceAmount).toBe(job.cardServiceAmount)
    expect(segments[0].cardTipAmount).toBe(job.cardTipAmount)
    expect(verification.balanced).toBe(true)
  })
})

describe("planSegments – who is paid on what", () => {
  it("splits when Tim and the crew are on the same job", () => {
    const plan = planSegments(mixedJob(), [VADIM, DENIS, TIM], [TIM])
    expect(plan.warnings).toEqual([])
    expect(plan.segmentFor.get(TIM.id)?.kind).toBe("dedicated")
    expect(plan.segmentFor.get(VADIM.id)?.kind).toBe("crew")
    expect(plan.segmentFor.get(DENIS.id)?.kind).toBe("crew")
    expect(plan.splitCountFor.get(VADIM.id)).toBe(2)
    expect(plan.splitCountFor.get(TIM.id)).toBe(1)
  })

  it("pays Tim on the whole job when he works alone (legacy behaviour)", () => {
    const job = normalizeJob(
      {
        UUID: "solo-1",
        Status: "Done",
        Team: [{ id: 15, Name: "Tim" }],
        SubTotal: 600,
        Items: [{ Name: "Regrout *T*", Price: 400 }, { Name: "Caulk", Price: 200 }],
        Payments: [{ Amount: 600, Method: "Visa" }, { Amount: 50, Method: "Visa", IsTip: true }],
      },
      settings,
      noCatalog,
    )
    const plan = planSegments(job, [TIM], [TIM])
    const seg = plan.segmentFor.get(TIM.id)!
    expect(seg.kind).toBe("job")
    expect(seg.jobTotal).toBe(600)
    expect(seg.cardTipAmount).toBe(50)
    expect(plan.warnings).toEqual([])
    const result = payFor(seg, TIM)
    expect(result.totalPayout).toBeCloseTo(600 * CARD_FEE_MULTIPLIER * 0.8 + 50 * CARD_FEE_MULTIPLIER * 1, 8)
  })

  it("flags marked items when Tim is not assigned to the job", () => {
    const plan = planSegments(mixedJob(), [VADIM, DENIS], [TIM])
    expect(plan.warnings.some((w) => w.includes("*T*") && w.includes("Tim is not assigned"))).toBe(true)
    // Nobody is segmented; the hold protects against paying the crew on Tim's work.
    expect(plan.segmentFor.get(VADIM.id)?.kind).toBe("job")
  })

  it("flags Tim on a job that has no *T* items", () => {
    const job = normalizeJob(
      {
        UUID: "nomark-1",
        Status: "Done",
        Team: [{ id: 11, Name: "Vadim" }, { id: 15, Name: "Tim" }],
        SubTotal: 500,
        Items: [{ Name: "Door", Price: 500 }],
        Payments: [{ Amount: 500, Method: "Check" }],
      },
      settings,
      noCatalog,
    )
    const plan = planSegments(job, [VADIM, TIM], [TIM])
    expect(plan.warnings.some((w) => w.startsWith("Tim is assigned") && w.includes("*T*"))).toBe(true)
    expect(plan.segmentFor.get(TIM.id)?.jobTotal).toBe(0)
    expect(plan.segmentFor.get(VADIM.id)?.jobTotal).toBe(500)
  })
})
