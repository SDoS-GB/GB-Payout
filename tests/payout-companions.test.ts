import { describe, expect, it } from "vitest"
import { calcPayoutWithPaymentSplit } from "@/lib/payout/calculator"
import { addCompanions, describeCompanion } from "@/lib/payout/companions"
import { COMPANIONS, CONTRACTORS } from "@/lib/payout/contractors"
import { planSegments } from "@/lib/payout/segments"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { normalizeJob } from "@/lib/workiz/normalize"
import { buildPayoutNote } from "@/lib/workiz/payout-note"

const VADIM = { id: 1, name: "Vadim", active: true, worksWithProfileId: null, lineItemMarker: null }
const DENIS = { id: 2, name: "Denis", active: true, worksWithProfileId: 1, lineItemMarker: null }
const ARTHUR = { id: 3, name: "Arthur", active: true, worksWithProfileId: null, lineItemMarker: null }
const TIM = { id: 5, name: "Tim", active: true, worksWithProfileId: null, lineItemMarker: "T, Tim" }
const ROSTER = [VADIM, DENIS, ARTHUR, TIM]

describe("addCompanions", () => {
  it("adds Denis to a job Workiz assigned to Vadim alone", () => {
    const { profiles, added } = addCompanions([VADIM], ROSTER)
    expect(profiles.map((p) => p.name)).toEqual(["Vadim", "Denis"])
    expect(added).toHaveLength(1)
    expect(describeCompanion(added[0])).toBe("Denis always works with Vadim")
  })

  it("does nothing when the technician Denis works with is not on the job", () => {
    const { profiles, added } = addCompanions([ARTHUR], ROSTER)
    expect(profiles.map((p) => p.name)).toEqual(["Arthur"])
    expect(added).toEqual([])
  })

  it("does not duplicate Denis when Workiz already lists him", () => {
    const { profiles, added } = addCompanions([VADIM, DENIS], ROSTER)
    expect(profiles.map((p) => p.name)).toEqual(["Vadim", "Denis"])
    expect(added).toEqual([])
  })

  it("keeps the Workiz order and appends companions after everyone assigned", () => {
    const { profiles } = addCompanions([TIM, VADIM], ROSTER)
    expect(profiles.map((p) => p.name)).toEqual(["Tim", "Vadim", "Denis"])
  })

  it("skips inactive companions", () => {
    const { profiles } = addCompanions([VADIM], [VADIM, { ...DENIS, active: false }])
    expect(profiles.map((p) => p.name)).toEqual(["Vadim"])
  })

  it("does not chain: a companion of a companion is not pulled in", () => {
    const rodion = { id: 7, name: "Rodion", active: true, worksWithProfileId: DENIS.id, lineItemMarker: null }
    const { profiles } = addCompanions([VADIM], [...ROSTER, rodion])
    expect(profiles.map((p) => p.name)).toEqual(["Vadim", "Denis"])
  })

  it("does not introduce Denis onto a job whose Vadim payout was already paid before the pairing existed", () => {
    const { profiles, added } = addCompanions([VADIM], ROSTER, { settledPrimaryIds: new Set([VADIM.id]), existingPayoutProfileIds: new Set([VADIM.id]) })
    expect(profiles.map((p) => p.name)).toEqual(["Vadim"])
    expect(added).toEqual([])
  })

  it("keeps maintaining Denis's payout once it exists, even after Vadim's is paid", () => {
    const { profiles } = addCompanions([VADIM], ROSTER, { settledPrimaryIds: new Set([VADIM.id]), existingPayoutProfileIds: new Set([VADIM.id, DENIS.id]) })
    expect(profiles.map((p) => p.name)).toEqual(["Vadim", "Denis"])
  })

  it("works both ways when two technicians point at each other", () => {
    const a = { id: 10, name: "A", active: true, worksWithProfileId: 11, lineItemMarker: null }
    const b = { id: 11, name: "B", active: true, worksWithProfileId: 10, lineItemMarker: null }
    expect(addCompanions([a], [a, b]).profiles.map((p) => p.name)).toEqual(["A", "B"])
    expect(addCompanions([b], [a, b]).profiles.map((p) => p.name)).toEqual(["B", "A"])
  })
})

describe("Vadim + Denis on one job", () => {
  const rates = (name: keyof typeof CONTRACTORS) => ({ nonColorRate: CONTRACTORS[name].nonColorRate, colorRate: CONTRACTORS[name].colorRate })
  const options = { separateColorSeal: true, tipShare: 0.5 }

  /** $867.40 job: $385.80 regular work + $481.60 color seal, paid by Zelle, $40 cash tip. */
  const job = normalizeJob(
    {
      UUID: "VD1",
      SerialId: "924900",
      Status: "Done",
      JobType: "Grout Cleaning and Color Seal",
      FirstName: "Jane",
      LastName: "Doe",
      Team: [{ id: 135134, Name: "Vadim" }],
      SubTotal: 867.4,
      JobTotalPrice: 867.4,
      JobAmountDue: 0,
      LineItems: [
        { Name: "Grout cleaning", Price: 385.8, Quantity: 1, Type: "service" },
        { Name: "Color Seal", Price: 481.6, Quantity: 1, Type: "service" },
      ],
      Payments: [
        { Amount: 867.4, Method: "Zelle", Date: "2026-09-22 14:10:00" },
        { Amount: 40, Method: "Cash", IsTip: true, Date: "2026-09-22 14:10:00" },
      ],
    },
    DEFAULT_WORKIZ_SETTINGS,
    new Map<string, boolean>(),
  )

  it("pays both on the whole job at their own rates, exactly like the calculator", () => {
    const { profiles } = addCompanions([VADIM], ROSTER)
    const plan = planSegments(job, profiles, [TIM])
    expect(plan.warnings).toEqual([])

    const segFor = (id: number) => plan.segmentFor.get(id) ?? plan.segmentation.segments[0]
    const pay = (id: number, name: keyof typeof CONTRACTORS) => {
      const s = segFor(id)
      return calcPayoutWithPaymentSplit(
        { jobTotal: s.jobTotal, colorSealTotal: s.colorSealTotal, cardServiceAmount: s.cardServiceAmount, cardTip: s.cardTipAmount, nonCardOwedTip: s.nonCardTipAmount },
        rates(name),
        options,
      )
    }

    const vadim = pay(VADIM.id, "Vadim")
    const denis = pay(DENIS.id, "Denis")
    // Vadim: 25% of 867.40 = 216.85, plus half the $40 tip.
    expect(vadim.basePayout).toBeCloseTo(216.85, 2)
    expect(vadim.totalPayout).toBeCloseTo(236.85, 2)
    // Denis: 20% of 385.80 + 25% of 481.60 = 77.16 + 120.40 = 197.56, plus half the tip.
    expect(denis.basePayout).toBeCloseTo(197.56, 2)
    expect(denis.totalPayout).toBeCloseTo(217.56, 2)

    const note = buildPayoutNote({
      serialId: job.serialId,
      uuid: job.uuid,
      jobType: job.jobType,
      clientName: job.clientName,
      jobTotal: job.jobTotal,
      tipTotal: job.cardTipAmount + job.nonCardTipAmount,
      payments: job.payments,
      techs: [
        { name: "Vadim", total: vadim.totalPayout, tip: vadim.tipPayout, segmentKind: "job", segmentMarker: null },
        { name: "Denis", total: denis.totalPayout, tip: denis.tipPayout, segmentKind: "job", segmentMarker: null },
      ],
      timeZone: "America/New_York",
    })
    expect(note.split("\n").slice(0, 3)).toEqual(["PAYOUT READY (GB app)", "Pay Vadim $236.85 (total and tip included)", "Pay Denis $217.56 (total and tip included)"])
  })

  it("seeds Denis as Vadim's companion", () => {
    expect(COMPANIONS.Denis).toBe("Vadim")
  })
})
