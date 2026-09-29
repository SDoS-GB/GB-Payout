import { afterEach, describe, expect, it, vi } from "vitest"
import { deliverOwnerTrigger, verifyOwnerTrigger, type OwnerTransport } from "@/lib/notifications/workiz-owner-transport"
import { ownerAttemptDisposition, OWNER_MAX_ATTEMPTS, OWNER_STATUS_LABELS } from "@/lib/notifications/owner-status"
import { allPayoutsReady, buildOwnerMessage, ownerSnapshotHash, type OwnerPayout } from "@/lib/notifications/owner-message"
import { WorkizApiError, type WorkizRawJob } from "@/lib/workiz/client"
import { normalizeJob } from "@/lib/workiz/normalize"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"

const message = "GB payout ready\nJob #924878 - Test customer\nArthur: $159.97\nViktor: $159.97"
const tag = "Payout Ready"
const before: WorkizRawJob = { UUID: "TEST760", Tags: ["Existing office tag"], JobNotes: "Preserve these office instructions." }
const described = { ...before, JobNotes: `${message}\n\n${before.JobNotes}` }
const triggered = { ...described, Tags: [...before.Tags as string[], tag] }

function transport() {
  const getJob = vi.fn<OwnerTransport["getJob"]>()
  const updateJob = vi.fn<OwnerTransport["updateJob"]>().mockResolvedValue({ flag: true })
  const verifyBeforeTrigger = vi.fn().mockResolvedValue(undefined)
  return { client: { getJob, updateJob }, getJob, updateJob, verifyBeforeTrigger }
}
const run = (mock: ReturnType<typeof transport>, snapshot = before) => deliverOwnerTrigger({ ...mock, uuid: "TEST760", before: snapshot, tag, message })
afterEach(() => vi.restoreAllMocks())

describe("owner-only Workiz transport (mocked provider, no SMS)", () => {
  it("writes and verifies the calculated description before adding the trigger tag", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValueOnce(described).mockResolvedValueOnce(triggered)
    const outcome = await run(mock)
    expect(mock.updateJob.mock.calls).toEqual([["TEST760", { JobNotes: described.JobNotes }], ["TEST760", { Tags: [tag] }]])
    expect(mock.verifyBeforeTrigger).toHaveBeenCalledWith(described)
    expect(mock.verifyBeforeTrigger.mock.invocationCallOrder[0]).toBeLessThan(mock.updateJob.mock.invocationCallOrder[1])
    expect(outcome).toMatchObject({ accepted: true, ambiguous: false, evidence: { smsDelivery: "unconfirmed", providerMessageId: null } })
    expect(ownerAttemptDisposition(outcome, 1).status).toBe("provider_accepted")
    expect(OWNER_STATUS_LABELS.provider_accepted).toMatch(/unconfirmed/)
  })

  it("never re-adds an existing tag or treats an existing preview as a new send", async () => {
    const mock = transport()
    expect(await run(mock, triggered)).toMatchObject({ accepted: false, ambiguous: true, retryable: false })
    expect(mock.updateJob).not.toHaveBeenCalled()
  })

  it("does not trigger if Workiz drops the description", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValue(before)
    expect(await run(mock)).toMatchObject({ accepted: false, ambiguous: false, retryable: false })
    expect(mock.updateJob).toHaveBeenCalledTimes(1)
  })

  it("does not trigger if the current payout becomes ineligible", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValue(described)
    mock.verifyBeforeTrigger.mockRejectedValue(new Error("Payment details changed"))
    expect(await run(mock)).toMatchObject({ accepted: false, error: "Payment details changed" })
    expect(mock.updateJob).toHaveBeenCalledTimes(1)
  })

  it("does not claim SMS delivery when Workiz silently drops the tag", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValue(described)
    expect(await run(mock)).toMatchObject({ accepted: false, ambiguous: true, retryable: false })
  })

  it("does not retry a definite provider rejection automatically", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValue(described)
    mock.updateJob.mockResolvedValueOnce({ flag: true }).mockRejectedValueOnce(new WorkizApiError("Forbidden", 403, "job/update/", {}))
    const outcome = await run(mock)
    expect(outcome).toMatchObject({ accepted: false, ambiguous: false, retryable: false })
    expect(ownerAttemptDisposition(outcome, 1)).toMatchObject({ status: "failed", retry: false, requiresReview: false })
  })

  it("can retry an explicit quota rejection up to the bounded attempt limit", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValue(described)
    mock.updateJob.mockResolvedValueOnce({ flag: true }).mockRejectedValueOnce(new WorkizApiError("Quota", 429, "job/update/", {}))
    const outcome = await run(mock)
    expect(outcome).toMatchObject({ accepted: false, ambiguous: false, retryable: true })
    expect(ownerAttemptDisposition(outcome, 1)).toMatchObject({ status: "queued", retry: true })
    expect(ownerAttemptDisposition(outcome, OWNER_MAX_ATTEMPTS)).toMatchObject({ status: "failed", retry: false })
  })

  it("reconciles a trigger timeout with a read, not another POST", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValueOnce(described).mockResolvedValueOnce(triggered)
    mock.updateJob.mockResolvedValueOnce({ flag: true }).mockRejectedValueOnce(new TypeError("Network timeout"))
    expect(await run(mock)).toMatchObject({ accepted: true, evidence: { reconciledAfterError: true, smsDelivery: "unconfirmed" } })
    expect(mock.updateJob).toHaveBeenCalledTimes(2)
    expect(mock.getJob).toHaveBeenCalledTimes(2)
  })

  it("retains an ambiguous timeout for read-only reconciliation, never a blind retry", async () => {
    const mock = transport()
    mock.getJob.mockResolvedValueOnce(described).mockRejectedValueOnce(new TypeError("Read also timed out"))
    mock.updateJob.mockResolvedValueOnce({ flag: true }).mockRejectedValueOnce(new TypeError("Trigger timed out"))
    const outcome = await run(mock)
    expect(outcome).toMatchObject({ accepted: false, ambiguous: true, retryable: false })
    expect(ownerAttemptDisposition(outcome, 1)).toMatchObject({ status: "failed", retry: false, requiresReview: true, reconcile: true })
    expect(mock.updateJob).toHaveBeenCalledTimes(2)
  })

  it("allows a retry after a network failure before any tag trigger", async () => {
    const mock = transport()
    mock.updateJob.mockRejectedValueOnce(new TypeError("Description request timed out"))
    expect(await run(mock)).toMatchObject({ accepted: false, ambiguous: false, retryable: true })
    expect(mock.updateJob).toHaveBeenCalledTimes(1)
  })

  it("requires both the exact summary and tag for provider acceptance", () => {
    expect(verifyOwnerTrigger(described, message, tag)).toBe(false)
    expect(verifyOwnerTrigger({ ...triggered, JobNotes: "Unrelated preview" }, message, tag)).toBe(false)
    expect(verifyOwnerTrigger(triggered, message, tag)).toBe(true)
  })
})

describe("complete, current owner message snapshot", () => {
  const rows: OwnerPayout[] = [
    { id: 1, profileId: 3, name: "Arthur", status: "ready", totalPayout: "159.9690", inputHash: "a", holdReason: null },
    { id: 2, profileId: 4, name: "Viktor", status: "ready", totalPayout: "159.9690", inputHash: "b", holdReason: null },
  ]
  const job = normalizeJob({ UUID: "TEST760", SerialId: "924878", ClientName: "Test customer", Status: "Done", LastStatusUpdate: "2026-09-23 14:05:32", SubTotal: 760, JobTotalPrice: 760, JobAmountDue: 0, LineItems: [{ Name: "Cleaning", Price: 575, Quantity: 1 }, { Name: "Color sealing", Price: 185, Quantity: 1 }], Payments: [{ id: "DEPOSIT", amount: 172.5, type: "Credit" }, { id: "FINAL", amount: 587.5, type: "Check" }] }, DEFAULT_WORKIZ_SETTINGS, new Map())

  it("addresses the owner workflow and lists individual payouts without a combined crew total", () => {
    const text = buildOwnerMessage(job, rows, "America/New_York")
    expect(text).toContain("Completed Sep 23, 2026")
    expect(text).toContain("Client payments: Card $172.50; Check $587.50")
    expect(text).toContain("Arthur: $159.97")
    expect(text).toContain("Viktor: $159.97")
    expect(text).not.toMatch(/Hi Arthur|Hi Viktor|319\.94|crew total/i)
  })

  it("rejects a partially ready crew, missing calculations, or unmapped technicians", () => {
    expect(allPayoutsReady(rows, [1, 2], [])).toBeNull()
    expect(allPayoutsReady([rows[0]], [1, 2], [])).toMatch(/missing/)
    expect(allPayoutsReady([{ ...rows[0], status: "hold", holdReason: "Unknown payment" }, rows[1]], [1, 2], [])).toMatch(/Unknown payment/)
    expect(allPayoutsReady(rows, [1, 2], ["unmapped"])).toMatch(/Unmapped/)
  })

  it("hashes deterministically and detects changed values or eligibility", () => {
    const first = ownerSnapshotHash(message, rows)
    expect(ownerSnapshotHash(message, rows.slice().reverse())).toBe(first)
    expect(ownerSnapshotHash(message, [{ ...rows[0], status: "paid" }, rows[1]])).not.toBe(first)
    expect(ownerSnapshotHash(message, [{ ...rows[0], totalPayout: "160.00" }, rows[1]])).not.toBe(first)
  })
})
