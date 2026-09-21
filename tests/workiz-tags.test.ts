import { describe, expect, it } from "vitest"
import { explainNotApplied, hasTag, normalizeTagName, planPayoutReadyTag, verifyTagApplied } from "@/lib/workiz/tags"

const base = { enabled: true, tag: "Payout Ready", existingTags: ["2 Year Reminder", "Work", "A"], hasReadyPayout: true }

describe("planPayoutReadyTag", () => {
  it("adds the tag on top of the existing ones (Workiz merges, so the full list is sent)", () => {
    const plan = planPayoutReadyTag(base)
    expect(plan).toEqual({ action: "add", tag: "Payout Ready", tags: ["2 Year Reminder", "Work", "A", "Payout Ready"] })
  })

  it("is a no-op when the job already carries the tag, regardless of case or spacing", () => {
    expect(planPayoutReadyTag({ ...base, existingTags: ["Work", "payout  ready"] })).toEqual({ action: "skip", reason: "already-tagged" })
  })

  it("skips when the feature is off, the tag is blank, or the job has no ready payout", () => {
    expect(planPayoutReadyTag({ ...base, enabled: false })).toEqual({ action: "skip", reason: "disabled" })
    expect(planPayoutReadyTag({ ...base, tag: "   " })).toEqual({ action: "skip", reason: "empty-tag" })
    expect(planPayoutReadyTag({ ...base, hasReadyPayout: false })).toEqual({ action: "skip", reason: "no-ready-payout" })
  })

  it("normalizes the configured tag name before sending it", () => {
    const plan = planPayoutReadyTag({ ...base, tag: "  Payout   Ready " })
    expect(plan.action).toBe("add")
    if (plan.action === "add") expect(plan.tags.at(-1)).toBe("Payout Ready")
  })
})

describe("verifyTagApplied", () => {
  it("detects the silent-drop failure mode where Workiz says ok but the tag is missing", () => {
    expect(verifyTagApplied(["2 Year Reminder", "Work", "A"], "Payout Ready")).toBe("not-applied")
    expect(verifyTagApplied(["2 Year Reminder", "Payout Ready", "Work", "A"], "Payout Ready")).toBe("applied")
  })

  it("explains that the tag has to be created in Workiz first", () => {
    expect(explainNotApplied("Payout Ready")).toMatch(/must already exist/)
    expect(explainNotApplied("Payout Ready")).toContain('"Payout Ready"')
  })
})

describe("tag name helpers", () => {
  it("compares case-insensitively and ignores extra whitespace", () => {
    expect(normalizeTagName("  a   b ")).toBe("a b")
    expect(hasTag(["Portable", "WORK"], "work")).toBe(true)
    expect(hasTag(["Portable"], "Port")).toBe(false)
  })
})
