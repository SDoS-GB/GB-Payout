import { describe, expect, it } from "vitest"
import type { NormalizedPayment } from "@/lib/db/schema"
import { buildPayoutNote, hasPayoutNote, mergePayoutNote, PAYOUT_NOTE_HEADER, type PayoutNoteInput } from "@/lib/workiz/payout-note"

const TZ = "America/New_York"

const countHeaders = (text: string) => text.split(PAYOUT_NOTE_HEADER).length - 1

function payment(over: Partial<NormalizedPayment>): NormalizedPayment {
  return { id: null, amount: 0, method: "Cash", isCard: false, isTip: false, date: null, ...over }
}

function input(over: Partial<PayoutNoteInput> = {}): PayoutNoteInput {
  return {
    serialId: "924886",
    uuid: "CC6YKK",
    jobType: "Grout Cleaning",
    clientName: "Jane Doe",
    jobTotal: 50,
    tipTotal: 0,
    payments: [payment({ amount: 50, method: "Credit Card", isCard: true, date: "2026-09-21T18:45:00.000Z" })],
    techs: [{ name: "Arthur", total: 9.65, tip: 0, segmentKind: "job", segmentMarker: null }],
    timeZone: TZ,
    ...over,
  }
}

describe("buildPayoutNote", () => {
  it("leads with who to pay and how much, then the job, then how and when the client paid", () => {
    const note = buildPayoutNote(input())
    expect(note.split("\n")).toEqual([
      PAYOUT_NOTE_HEADER,
      "Pay Arthur $9.65",
      "Job #924886 - Grout Cleaning - Jane Doe",
      "Paid $50.00 by Card on Sep 21, 2:45 PM",
    ])
  })

  it("renders the payment time in the business timezone, not UTC", () => {
    // 18:45Z is 14:45 in New York (EDT) and 20:45 in Berlin.
    expect(buildPayoutNote(input({ timeZone: "Europe/Berlin" }))).toContain("on Sep 21, 8:45 PM")
  })

  it("lists every technician on a split job with the segment each is paid for", () => {
    const note = buildPayoutNote(
      input({
        jobTotal: 400,
        payments: [payment({ amount: 400, method: "Zelle", date: "2026-09-21 10:00:00" })],
        techs: [
          { name: "Tim", total: 160, tip: 0, segmentKind: "dedicated", segmentMarker: "T" },
          { name: "Denis", total: 40, tip: 0, segmentKind: "crew", segmentMarker: "T" },
        ],
      }),
    )
    expect(note).toContain("Pay Tim $160.00 (*T* items)")
    expect(note).toContain("Pay Denis $40.00 (crew, excl. *T*)")
    expect(note).toContain("Paid $400.00 by Zelle on Sep 21, 10:00 AM")
  })

  it("breaks a mixed payment down per method and dates it by the latest payment", () => {
    const note = buildPayoutNote(
      input({
        jobTotal: 100,
        payments: [
          payment({ amount: 60, method: "Credit Card", isCard: true, date: "2026-09-20T15:00:00.000Z" }),
          payment({ amount: 40, method: "Cash", date: "2026-09-21T15:00:00.000Z" }),
        ],
      }),
    )
    expect(note).toContain("Paid $100.00: $60.00 Card + $40.00 Cash on Sep 21, 11:00 AM")
  })

  it("adds a tip line with each technician's share and omits it when there is no tip", () => {
    const withTip = buildPayoutNote(
      input({
        tipTotal: 20,
        techs: [
          { name: "Arthur", total: 19.65, tip: 10, segmentKind: "job", segmentMarker: null },
          { name: "Denis", total: 9.65, tip: 0, segmentKind: "job", segmentMarker: null },
        ],
      }),
    )
    expect(withTip).toContain("Tip $20.00 (Arthur gets $10.00)")
    expect(buildPayoutNote(input())).not.toContain("Tip")
  })

  it("says so plainly when no payment record reached the app", () => {
    const note = buildPayoutNote(input({ payments: [] }))
    expect(note).toContain("Paid $50.00 - payment method not on file")
    expect(note).not.toMatch(/ on [A-Z][a-z]{2} \d/)
  })

  it("marks an admin test tag that has no ready payout behind it", () => {
    expect(buildPayoutNote(input({ techs: [] }))).toContain("Pay: no ready payout on this job (test tag)")
  })

  it("falls back to the UUID and drops missing job facts instead of printing null", () => {
    const note = buildPayoutNote(input({ serialId: null, jobType: null, clientName: null }))
    expect(note).toContain("Job #CC6YKK")
    expect(note).not.toMatch(/null|undefined| - $/)
  })

  it("stays inside the GSM-7 SMS alphabet so the text is not billed as unicode", () => {
    const note = buildPayoutNote(
      input({
        clientName: "José “Pepe” Núñez — Café",
        techs: [{ name: "Tim", total: 160, tip: 0, segmentKind: "dedicated", segmentMarker: "T" }],
      }),
    )
    for (const ch of note) {
      expect(ch === "\n" || (ch >= " " && ch <= "~")).toBe(true)
    }
    expect(note).toContain('Jos "Pepe" Nez - Caf')
  })
})

describe("mergePayoutNote", () => {
  const note = buildPayoutNote(input())

  it("puts the block first and keeps what the office typed underneath", () => {
    const merged = mergePayoutNote("Start in laundry room", note)
    expect(merged.startsWith(PAYOUT_NOTE_HEADER)).toBe(true)
    expect(merged.endsWith("\n\nStart in laundry room")).toBe(true)
  })

  it("returns just the block when the description was empty", () => {
    expect(mergePayoutNote(null, note)).toBe(note)
    expect(mergePayoutNote("   ", note)).toBe(note)
  })

  it("replaces an earlier block instead of stacking a second one", () => {
    const first = mergePayoutNote("Milano Neighborhood", note)
    const updated = buildPayoutNote(input({ techs: [{ name: "Arthur", total: 12, tip: 0, segmentKind: "job", segmentMarker: null }] }))
    const merged = mergePayoutNote(first, updated)
    expect(countHeaders(merged)).toBe(1)
    expect(merged).toContain("Pay Arthur $12.00")
    expect(merged).not.toContain("Pay Arthur $9.65")
    expect(merged.endsWith("Milano Neighborhood")).toBe(true)
  })

  it("survives Windows line endings and multi-paragraph descriptions from Workiz", () => {
    const office = "We have 2 bathrooms.\r\n\r\nThanks\r\nChris"
    const merged = mergePayoutNote(mergePayoutNote(office, note), note)
    expect(countHeaders(merged)).toBe(1)
    expect(merged).toContain("We have 2 bathrooms.")
    expect(merged).toContain("Thanks\r\nChris")
  })
})

describe("hasPayoutNote", () => {
  it("detects the block anywhere in the description", () => {
    expect(hasPayoutNote(`Old text\n\n${PAYOUT_NOTE_HEADER}\nPay Tim $1.00`)).toBe(true)
    expect(hasPayoutNote("Milano Neighborhood")).toBe(false)
    expect(hasPayoutNote(null)).toBe(false)
  })
})
