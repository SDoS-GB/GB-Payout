import { describe, expect, it } from "vitest"
import { initialSelection, reconcileSelection, selectedJobs, selectedTotal, setAllTicked, setTicked, type DueSelectableJob } from "@/lib/payout/due-selection"

const money = (n: number) => `$${n.toFixed(2)}`
const job = (id: number, amount: number): DueSelectableJob => ({ id, amount, label: `#${id}` })

describe("Due selection", () => {
  it("starts with every eligible payout ticked and totals their stored amounts", () => {
    const jobs = [job(1, 100), job(2, 150)]
    const sel = initialSelection(jobs)
    expect(sel.ticked.size).toBe(2)
    expect(selectedTotal(sel, jobs)).toBe(250)
  })

  it("subtracts on untick and adds back on re-tick", () => {
    const jobs = [job(1, 100), job(2, 150)]
    let sel = initialSelection(jobs)
    sel = setTicked(sel, jobs[1], false)
    expect(selectedTotal(sel, jobs)).toBe(100)
    expect(sel.unticked.has(2)).toBe(true)
    sel = setTicked(sel, jobs[1], true)
    expect(selectedTotal(sel, jobs)).toBe(250)
    expect(sel.unticked.has(2)).toBe(false)
  })

  it("adds in whole cents so float drift cannot appear in the total", () => {
    const jobs = [job(1, 0.1), job(2, 0.2), job(3, 0.3)]
    expect(selectedTotal(initialSelection(jobs), jobs)).toBe(0.6)
  })

  it("clear all leaves nothing selected and select all restores everything", () => {
    const jobs = [job(1, 100), job(2, 150)]
    const none = setAllTicked(jobs, false)
    expect(selectedTotal(none, jobs)).toBe(0)
    expect(selectedJobs(none, jobs)).toEqual([])
    expect(selectedTotal(setAllTicked(jobs, true), jobs)).toBe(250)
  })

  describe("reconcile after a refresh", () => {
    it("keeps the previous object when nothing moved", () => {
      const jobs = [job(1, 100), job(2, 150)]
      const sel = initialSelection(jobs)
      const out = reconcileSelection(sel, [job(1, 100), job(2, 150)], money)
      expect(out.changed).toBe(false)
      expect(out.selection).toBe(sel)
      expect(out.notice).toBeNull()
    })

    it("preserves a deliberate untick", () => {
      const jobs = [job(1, 100), job(2, 150)]
      const sel = setTicked(initialSelection(jobs), jobs[1], false)
      const out = reconcileSelection(sel, [job(1, 100), job(2, 150)], money)
      expect(out.changed).toBe(false)
      expect(selectedTotal(out.selection, jobs)).toBe(100)
    })

    it("ticks a newly eligible job by default and says so", () => {
      const jobs = [job(1, 100)]
      const sel = initialSelection(jobs)
      const next = [job(1, 100), job(3, 75)]
      const out = reconcileSelection(sel, next, money)
      expect(out.changed).toBe(true)
      expect(selectedTotal(out.selection, next)).toBe(175)
      expect(out.notice).toContain("1 new job added and ticked (#3)")
    })

    it("does not re-tick a deliberately unticked job even when a new job appears", () => {
      const jobs = [job(1, 100), job(2, 150)]
      const sel = setTicked(initialSelection(jobs), jobs[0], false)
      const next = [job(1, 100), job(2, 150), job(3, 20)]
      const out = reconcileSelection(sel, next, money)
      expect(out.selection.unticked.has(1)).toBe(true)
      expect(selectedTotal(out.selection, next)).toBe(170)
    })

    it("drops jobs that are no longer due and reports the ticked ones", () => {
      const jobs = [job(1, 100), job(2, 150), job(3, 20)]
      const sel = setTicked(initialSelection(jobs), jobs[2], false)
      const next = [job(1, 100)]
      const out = reconcileSelection(sel, next, money)
      expect(out.changed).toBe(true)
      expect(selectedTotal(out.selection, next)).toBe(100)
      expect(out.selection.unticked.size).toBe(0)
      expect(out.notice).toBe("1 ticked job is no longer due and was removed")
    })

    it("unticks a job whose amount changed and shows both amounts", () => {
      const jobs = [job(1, 100), job(2, 150)]
      const sel = initialSelection(jobs)
      const next = [job(1, 100), job(2, 160)]
      const out = reconcileSelection(sel, next, money)
      expect(out.selection.ticked.has(2)).toBe(false)
      expect(out.selection.unticked.has(2)).toBe(true)
      expect(selectedTotal(out.selection, next)).toBe(100)
      expect(out.notice).toContain("#2: $150.00 → $160.00")
      // Re-ticking uses the latest stored amount.
      const reticked = setTicked(out.selection, next[1], true)
      expect(selectedTotal(reticked, next)).toBe(260)
    })

    it("ignores sub-cent noise in the stored amount", () => {
      const sel = initialSelection([job(1, 100)])
      const out = reconcileSelection(sel, [job(1, 100.004)], money)
      expect(out.changed).toBe(false)
    })
  })
})
