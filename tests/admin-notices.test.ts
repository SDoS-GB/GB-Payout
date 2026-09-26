import { describe, expect, it } from "vitest"
import {
  OPENING_BALANCE_NOTICE_KEY,
  buildAdminNotices,
  holdIssueKey,
  holdIssueLabel,
  holdNoticeKey,
  isValidNoticeKey,
  keysOf,
  sourceChangeNoticeKey,
  withoutDismissed,
  type HeldPayoutInput,
  type NoticeInputs,
  type SourceChangeInput,
} from "@/lib/admin/notices"

const hold = (over: Partial<HeldPayoutInput> = {}): HeldPayoutInput => ({
  payoutId: 1,
  jobUuid: "JOB-A",
  serialId: "924884",
  clientName: "Ray Oblenes",
  profileName: "Arthur",
  holdReason: "Payment method unknown: payment details unavailable from Workiz; confirm how the customer paid",
  updatedAt: "2026-09-25T20:00:00.000Z",
  ...over,
})

const change = (over: Partial<SourceChangeInput> = {}): SourceChangeInput => ({
  jobUuid: "JOB-P",
  serialId: "924800",
  clientName: "Chris Labonte",
  profileName: "Vadim",
  newHash: "hashA",
  settledAmount: 219.52,
  recomputedAmount: 230,
  detectedAt: "2026-09-25T18:00:00.000Z",
  ...over,
})

const inputs = (over: Partial<NoticeInputs> = {}): NoticeInputs => ({ holds: [], sourceChanges: [], unmapped: [], openingMissing: false, ...over })

describe("hold issue identity", () => {
  it("keeps the category and drops amounts, quotes and free text", () => {
    expect(holdIssueKey("Payment method unknown: payment details unavailable from Workiz…")).toBe("payment-method-unknown")
    expect(holdIssueKey("Payment method unknown: card $172.50 + check $587.50 still to confirm")).toBe("payment-method-unknown")
    expect(holdIssueKey("Unrecorded tip likely: Workiz total exceeds the line items by $231.67")).toBe("unrecorded-tip-likely")
    expect(holdIssueKey("Job has unmapped team members (271865, 135135)")).toBe("job-has-unmapped-team-members")
    expect(holdIssueKey('Job status "Done" is not payable')).toBe("job-status-is-not-payable")
    expect(holdIssueKey("Completed before the previously-paid-through cutoff (2026-08-01T04:00:00.000Z) but first seen afterwards — confirm it was already paid. Also: Payment method unknown: …")).toBe(
      "completed-before-the-previously-paid-through-cutoff",
    )
    expect(holdIssueKey("Tim's Job work type: the whole job is credited to Tim. Nothing is owed on this row; void it if that is right.")).toBe("nothing-owed")
    expect(holdIssueKey(null)).toBe("on-hold")
  })

  it("is the same for the same issue whatever the wording details, and different for a different issue", () => {
    const a = holdNoticeKey("JOB-A", "Payment method unknown: payment details unavailable from Workiz")
    const b = holdNoticeKey("JOB-A", "Payment method unknown: still unknown after the sync on 2026-09-26 12:00")
    const c = holdNoticeKey("JOB-A", "Unitemized discount: JobTotalPrice 425.00 is below the 475.00 line items")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(holdNoticeKey("JOB-B", "Payment method unknown: x")).not.toBe(a)
  })

  it("labels read like the category", () => {
    expect(holdIssueLabel("Payment method unknown: details unavailable")).toBe("Payment method unknown")
    expect(holdIssueLabel("Tim's Job… Nothing is owed on this row; void it if that is right.")).toBe("Nothing is owed on this row")
  })
})

describe("buildAdminNotices", () => {
  it("groups two technicians held on one job for one reason into a single notice naming both", () => {
    const out = buildAdminNotices(inputs({ holds: [hold({ payoutId: 1, profileName: "Viktor" }), hold({ payoutId: 2, profileName: "Arthur" })] }))
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("hold:JOB-A:payment-method-unknown")
    expect(out[0].title).toBe("Ray Oblenes · Job #924884")
    expect(out[0].detail).toBe("Arthur, Viktor · Payment method unknown")
    expect(out[0].action).toEqual({ kind: "review-job", search: "924884" })
  })

  it("keeps payout-specific issues on the same job apart", () => {
    const out = buildAdminNotices(inputs({ holds: [hold({ payoutId: 1, profileName: "Arthur" }), hold({ payoutId: 2, profileName: "Tim", holdReason: "Tim's Job… Nothing is owed on this row; void it if that is right." })] }))
    expect(out.map((n) => n.id).sort()).toEqual(["hold:JOB-A:nothing-owed", "hold:JOB-A:payment-method-unknown"])
  })

  it("hides a cleared hold whatever the message now says, and shows a new issue on the same job", () => {
    const dismissed = new Set(["hold:JOB-A:payment-method-unknown"])
    expect(buildAdminNotices(inputs({ holds: [hold({ holdReason: "Payment method unknown: re-synced wording, $99.00" })] }), dismissed)).toEqual([])
    const out = buildAdminNotices(inputs({ holds: [hold({ holdReason: "Unrecorded tip likely: $50.00 not itemized" })] }), dismissed)
    expect(out.map((n) => n.id)).toEqual(["hold:JOB-A:unrecorded-tip-likely"])
  })

  it("groups paid-job changes per job with one key per recorded fingerprint", () => {
    const out = buildAdminNotices(inputs({ sourceChanges: [change({ profileName: "Vadim", newHash: "h1" }), change({ profileName: "Denis", newHash: "h2" })] }))
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("change:JOB-P")
    expect(out[0].keys.sort()).toEqual(["change:JOB-P:h1", "change:JOB-P:h2"])
    expect(out[0].detail).toBe("Denis, Vadim · the paid amounts may differ now")
    expect(out[0].action).toEqual({ kind: "navigate", loc: { view: "review" } })
  })

  it("a cleared change stays cleared; a later distinct change reappears on its own", () => {
    const first = buildAdminNotices(inputs({ sourceChanges: [change({ newHash: "h1" })] }))
    const dismissed = new Set(keysOf(first))
    expect(buildAdminNotices(inputs({ sourceChanges: [change({ newHash: "h1" })] }), dismissed)).toEqual([])
    const later = buildAdminNotices(inputs({ sourceChanges: [change({ newHash: "h1" }), change({ newHash: "h2", recomputedAmount: 240 })] }), dismissed)
    expect(later).toHaveLength(1)
    expect(later[0].keys).toEqual(["change:JOB-P:h2"])
    expect(later[0].detail).toBe("Vadim · paid $219.52, Workiz now computes $240.00")
  })

  it("tracks dismissals per unmapped person so a changed count does not resurrect cleared ones", () => {
    const dismissed = new Set(["unmapped:100"])
    const out = buildAdminNotices(
      inputs({
        unmapped: [
          { workizTeamId: "100", workizName: "Old Guy" },
          { workizTeamId: "200", workizName: "New Guy" },
        ],
      }),
      dismissed,
    )
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe("1 Workiz team member not mapped to a technician")
    expect(out[0].keys).toEqual(["unmapped:200"])
    expect(buildAdminNotices(inputs({ unmapped: [{ workizTeamId: "100", workizName: "Old Guy" }] }), dismissed)).toEqual([])
  })

  it("uses one constant key for the opening balance", () => {
    expect(buildAdminNotices(inputs({ openingMissing: true })).map((n) => n.keys)).toEqual([[OPENING_BALANCE_NOTICE_KEY]])
    expect(buildAdminNotices(inputs({ openingMissing: true }), new Set([OPENING_BALANCE_NOTICE_KEY]))).toEqual([])
  })

  it("orders changes and setup items before the long list of holds", () => {
    const out = buildAdminNotices(inputs({ holds: [hold()], sourceChanges: [change()], unmapped: [{ workizTeamId: "1", workizName: "X" }], openingMissing: true }))
    expect(out.map((n) => n.kind)).toEqual(["source-change", "unmapped", "opening-balance", "hold"])
  })
})

describe("clearing helpers", () => {
  it("withoutDismissed trims a notice to its uncleared keys and drops it once none remain", () => {
    const [n] = buildAdminNotices(inputs({ sourceChanges: [change({ newHash: "h1" }), change({ newHash: "h2" })] }))
    expect(withoutDismissed([n], new Set(["change:JOB-P:h1"]))[0].keys).toEqual(["change:JOB-P:h2"])
    expect(withoutDismissed([n], new Set(["change:JOB-P:h1", "change:JOB-P:h2"]))).toEqual([])
  })

  it("only accepts keys this module produces", () => {
    expect(isValidNoticeKey("hold:JOB-A:payment-method-unknown")).toBe(true)
    expect(isValidNoticeKey(sourceChangeNoticeKey("JOB-P", "abc123"))).toBe(true)
    expect(isValidNoticeKey("unmapped:271865")).toBe(true)
    expect(isValidNoticeKey(OPENING_BALANCE_NOTICE_KEY)).toBe(true)
    expect(isValidNoticeKey("paid:1")).toBe(false)
    expect(isValidNoticeKey("hold:JOB A:x")).toBe(false)
    expect(isValidNoticeKey("hold:")).toBe(false)
    expect(isValidNoticeKey(42)).toBe(false)
    expect(isValidNoticeKey(`hold:${"x".repeat(300)}`)).toBe(false)
  })
})
