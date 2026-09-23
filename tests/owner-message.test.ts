import { describe, expect, it } from "vitest"
import type { NormalizedPayment } from "@/lib/db/schema"
import {
  MAX_ATTEMPTS,
  OWNER_MESSAGE_HEADER,
  RETRY_DELAYS_MS,
  buildOwnerMessage,
  describeOwnerState,
  evaluateOwnerNotification,
  nextRetryAt,
  snapshotKeyOf,
  type OwnerMessageTech,
  type OwnerNotificationInput,
} from "@/lib/notifications/owner-message"

const card = (amount: number, isTip = false): NormalizedPayment => ({ id: `c${amount}${isTip ? "t" : ""}`, amount, method: "Credit Card", isCard: true, isTip, date: "2026-09-21 14:45:00", source: "invoice-webhook" })
const cash = (amount: number, isTip = false): NormalizedPayment => ({ id: `z${amount}${isTip ? "t" : ""}`, amount, method: "Zelle", isCard: false, isTip, date: "2026-09-21 14:45:00", source: "invoice-webhook" })

const tech = (over: Partial<OwnerMessageTech> & Pick<OwnerMessageTech, "id" | "name">): OwnerMessageTech => ({ status: "ready", total: 100, tip: 0, holdReason: null, segmentKind: "crew", ...over })

function input(over: Partial<OwnerNotificationInput> = {}): OwnerNotificationInput {
  return {
    job: {
      uuid: "CC6YKK",
      serialId: "924878",
      clientName: "Milano",
      jobType: "Grout Cleaning",
      status: "Done",
      fullyPaid: true,
      jobTotal: 475,
      tipTotal: 0,
      payments: [card(475)],
      lastStatusUpdate: "2026-09-21 14:45:00",
    },
    techs: [tech({ id: 1, name: "Arthur", total: 105 })],
    unmappedTeamIds: [],
    sender: { enabled: true, tag: "Payout Ready", hasCredentials: true },
    recipient: { configured: true, label: "Owner", masked: "***-***-1234" },
    timeZone: "America/New_York",
    ...over,
  }
}

describe("owner payout text", () => {
  it("lists each technician's own amount on its own line, never a crew total", () => {
    const msg = buildOwnerMessage(
      input({
        job: { ...input().job, tipTotal: 20, payments: [card(475), card(20, true)] },
        techs: [tech({ id: 2, name: "Vadim", total: 98.5, tip: 10 }), tech({ id: 1, name: "Arthur", total: 105, tip: 10 })],
      }),
    )
    const lines = msg.split("\n")
    expect(lines[0]).toBe(OWNER_MESSAGE_HEADER)
    expect(lines).toContain("Job #924878 - Milano")
    expect(lines).toContain("Completed Sep 21, 2026")
    expect(lines).toContain("Client payments: Card $475.00")
    expect(lines).toContain("Card fee applied proportionally.")
    expect(lines).toContain("Tip $20.00 (Vadim $10.00, Arthur $10.00)")
    expect(lines).toContain("Arthur: $105.00 (crew work)")
    expect(lines).toContain("Vadim: $98.50 (crew work)")
    expect(msg).not.toMatch(/203\.5/)
    // Alphabetical, so the owner reads the same order every time.
    expect(lines.indexOf("Arthur: $105.00 (crew work)")).toBeLessThan(lines.indexOf("Vadim: $98.50 (crew work)"))
  })

  it("stays GSM-7 safe and names the payment method, or says it is unavailable", () => {
    const mixed = buildOwnerMessage(input({ job: { ...input().job, payments: [card(200), cash(275)] } }))
    expect(mixed).toContain("Client payments: Card $200.00; Zelle $275.00")
    // eslint-disable-next-line no-control-regex
    expect(mixed).toMatch(/^[\x20-\x7e\n]*$/)

    const none = buildOwnerMessage(input({ job: { ...input().job, payments: [] } }))
    expect(none).toContain("Client payments: unavailable (Workiz did not report the method for $475.00)")
    expect(none).toContain("No card fee.")
  })

  it("explains whole-job ownership and already-paid technicians", () => {
    const msg = buildOwnerMessage(
      input({
        techs: [
          tech({ id: 1, name: "Arthur", total: 105, ownership: { reason: "work-type", workType: "Grout Cleaning" }, segmentKind: "job" }),
          tech({ id: 2, name: "Vadim", total: 40, status: "paid", segmentKind: "dedicated", segmentMarker: "V" }),
          tech({ id: 3, name: "Sam", total: 12, status: "pending" }),
        ],
      }),
    )
    expect(msg).toContain("Arthur: $105.00 (whole job, Grout Cleaning)")
    expect(msg).toContain("Vadim: $40.00 (*V* items) - already paid")
    expect(msg).not.toContain("Sam")
  })
})

describe("owner text eligibility", () => {
  it("is ready only when every payout is settled, the job is fully paid and the payment method is known", () => {
    const d = evaluateOwnerNotification(input())
    expect(d.state).toBe("ready")
    expect(d.message).toContain("Arthur: $105.00")
  })

  it("blocks while any payout is pending or on hold, naming the technician and reason", () => {
    const d = evaluateOwnerNotification(input({ techs: [tech({ id: 1, name: "Arthur" }), tech({ id: 2, name: "Vadim", status: "hold", holdReason: "Unmapped team member" })] }))
    expect(d.state).toBe("blocked")
    expect(d.state === "blocked" && d.reason).toBe("Waiting: Vadim's payout is on hold - Unmapped team member")
    expect(d.message).toBeNull()
  })

  it("blocks unmapped team members, unpaid jobs and unknown payment methods", () => {
    expect(evaluateOwnerNotification(input({ unmappedTeamIds: ["USR-1"] }))).toMatchObject({ state: "blocked", reason: expect.stringContaining("Unmapped Workiz team member") })
    expect(evaluateOwnerNotification(input({ job: { ...input().job, fullyPaid: false } }))).toMatchObject({ state: "blocked", reason: "Workiz does not show this job as fully paid" })
    expect(evaluateOwnerNotification(input({ job: { ...input().job, payments: [] } }))).toMatchObject({ state: "blocked", reason: expect.stringContaining("Payment method unavailable") })
    expect(evaluateOwnerNotification(input({ techs: [] }))).toMatchObject({ state: "blocked", reason: "No payout has been calculated for this job yet" })
    expect(evaluateOwnerNotification(input({ techs: [tech({ id: 1, name: "Arthur", status: "paid" })] }))).toMatchObject({ state: "blocked", reason: "Every payout on this job is already marked paid" })
  })

  it("keeps the message but blocks when the sender or recipient is not configured", () => {
    const noCreds = evaluateOwnerNotification(input({ sender: { enabled: true, tag: "Payout Ready", hasCredentials: false } }))
    expect(noCreds.state).toBe("blocked")
    expect(noCreds.message).toContain("Arthur")
    const noRecipient = evaluateOwnerNotification(input({ recipient: { configured: false, label: null, masked: null } }))
    expect(noRecipient).toMatchObject({ state: "blocked", reason: expect.stringContaining("Owner recipient not configured") })
    expect(noRecipient.message).toContain("Arthur")
  })

  it("is preview-only, with the full message, while owner texts are switched off", () => {
    const d = evaluateOwnerNotification(input({ sender: { enabled: false, tag: "Payout Ready", hasCredentials: true } }))
    expect(d.state).toBe("preview_only")
    expect(d.message).toContain("Arthur: $105.00")
    expect(d.snapshotKey).toBeTruthy()
  })

  it("does not treat 'zero payouts updated' as a blocker: an unchanged ready job stays ready", () => {
    const first = evaluateOwnerNotification(input())
    const again = evaluateOwnerNotification(input())
    expect(first.state).toBe("ready")
    expect(again.state).toBe("ready")
    expect(again.snapshotKey).toBe(first.snapshotKey)
  })
})

describe("owner text snapshot key and retries", () => {
  it("changes when a technician's amount, status or the payments change, and ignores tech order", () => {
    const base = snapshotKeyOf(input())
    expect(snapshotKeyOf(input({ techs: [tech({ id: 1, name: "Arthur", total: 106 })] }))).not.toBe(base)
    expect(snapshotKeyOf(input({ techs: [tech({ id: 1, name: "Arthur", status: "paid" })] }))).not.toBe(base)
    expect(snapshotKeyOf(input({ job: { ...input().job, payments: [cash(475)] } }))).not.toBe(base)
    const two = input({ techs: [tech({ id: 1, name: "Arthur" }), tech({ id: 2, name: "Vadim" })] })
    const reversed = input({ techs: [...two.techs].reverse() })
    expect(snapshotKeyOf(two)).toBe(snapshotKeyOf(reversed))
  })

  it("backs off 1m, 5m, 15m, 1h, 6h and then gives up", () => {
    const now = new Date("2026-09-21T12:00:00Z")
    expect(MAX_ATTEMPTS).toBe(5)
    for (let attempts = 1; attempts <= MAX_ATTEMPTS - 1; attempts++) {
      expect(nextRetryAt(attempts, now)?.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[attempts - 1])
    }
    expect(nextRetryAt(MAX_ATTEMPTS, now)).toBeNull()
  })

  it("describes every state for the admin", () => {
    for (const s of ["blocked", "preview_only", "queued", "sending", "provider_accepted", "delivered", "failed"]) {
      expect(describeOwnerState(s).label).not.toBe(s)
    }
    expect(describeOwnerState("provider_accepted").explanation).toContain("unconfirmed")
  })
})
