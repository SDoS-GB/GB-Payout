import { describe, expect, it } from "vitest"
import { canonical, compareListing } from "@/lib/workiz/listing-diff"

// Shape of a stored job/get payload; the listing is a subset with the same field names.
const stored = {
  UUID: "CC6YKK",
  SerialId: 924886,
  Status: "Done",
  SubStatus: "",
  JobTotalPrice: 760,
  SubTotal: 760,
  JobAmountDue: 4.5e-13,
  LastStatusUpdate: "2026-09-21 14:45:10",
  JobDateTime: "2026-09-21 09:00:00",
  JobEndDateTime: "2026-09-21 11:00:00",
  PaymentDueDate: "2026-09-21 00:00:00",
  Tags: ["Work", "Payout Ready"],
  Team: [{ id: "12", name: "Arthur" }],
  LineItems: [{ Name: "Regrout", Price: 760 }],
}

const listed = {
  UUID: "CC6YKK",
  SerialId: "924886",
  Status: "Done",
  SubStatus: "",
  JobTotalPrice: "760.00",
  SubTotal: "760.00",
  JobAmountDue: 0,
  LastStatusUpdate: "2026-09-21 14:45:10",
  JobDateTime: "2026-09-21 09:00:00",
  JobEndDateTime: "2026-09-21 11:00:00",
  PaymentDueDate: "2026-09-21 00:00:00",
  Tags: ["Payout Ready", "Work"],
  Team: [{ name: "Arthur", id: 12 }],
}

describe("canonical", () => {
  it("treats numeric strings, float noise and key order as the same value", () => {
    expect(canonical("760.00")).toBe(760)
    expect(canonical(4.5e-13)).toBe(0)
    expect(canonical({ b: 1, a: "2" })).toEqual({ a: 2, b: 1 })
    expect(canonical(["b", "a"])).toEqual(["a", "b"])
  })
})

describe("compareListing", () => {
  it("is new when nothing is stored", () => {
    expect(compareListing(listed, null)).toEqual({ verdict: "new" })
  })

  it("is unchanged when every shared field matches after normalisation", () => {
    expect(compareListing(listed, stored)).toEqual({ verdict: "unchanged", comparedKeys: 11 })
  })

  it("names the fields that moved", () => {
    const paid = { ...listed, JobAmountDue: "0.00", JobTotalPrice: "810.00", LastStatusUpdate: "2026-09-22 08:00:00" }
    expect(compareListing(paid, stored)).toEqual({ verdict: "changed", changedKeys: ["JobTotalPrice", "LastStatusUpdate"] })
  })

  it("notices a status flip, a tag added in Workiz and a crew change", () => {
    expect(compareListing({ ...listed, Status: "Submitted" }, stored)).toMatchObject({ verdict: "changed", changedKeys: ["Status"] })
    expect(compareListing({ ...listed, Tags: ["Work"] }, stored)).toMatchObject({ verdict: "changed", changedKeys: ["Tags"] })
    expect(compareListing({ ...listed, Team: [{ id: 13, name: "Vadim" }] }, stored)).toMatchObject({ verdict: "changed", changedKeys: ["Team"] })
  })

  it("ignores fields one side omits, but refuses to call a near-empty listing unchanged", () => {
    const { Tags: _tags, Team: _team, ...withoutCrew } = listed
    expect(compareListing(withoutCrew, stored)).toEqual({ verdict: "unchanged", comparedKeys: 9 })
    expect(compareListing({ UUID: "CC6YKK", Status: "Done" }, stored)).toEqual({ verdict: "incomparable", comparedKeys: 1 })
  })
})
