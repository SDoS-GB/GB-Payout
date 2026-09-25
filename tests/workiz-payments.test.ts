import { afterEach, describe, expect, it, vi } from "vitest"
import type { NormalizedPayment } from "@/lib/db/schema"
import { calcPayoutWithPaymentSplit, toCents } from "@/lib/payout/calculator"
import { gateReason } from "@/lib/payout/engine"
import { PAYMENT_DETAILS_UNAVAILABLE, explainPayoutStatus, paymentMethodsSummary, paymentSourceLabel } from "@/lib/payout/presentation"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { WorkizClient } from "@/lib/workiz/client"
import { PAYMENT_METHOD_UNKNOWN_PREFIX, isBlockingWarning, normalizeJob, normalizePayments } from "@/lib/workiz/normalize"
import { TIP_INCLUSION_RAW_KEY, classifyPaymentMethod, extractInvoiceWebhookPayments, externalRowsToPayments, inferTipInclusion, mergePayments, paymentEvidenceState, validateManualPayments } from "@/lib/workiz/payments"
import { parseWebhookBody } from "@/lib/workiz/webhook"

const settings = DEFAULT_WORKIZ_SETTINGS
const noCatalog = new Map<string, boolean>()

/**
 * Sanitized copy of the live `job/get/CC6YKK/` response fetched 2026-09-21 for Workiz job
 * #924886 (customer fields removed). Workiz's own UI shows this job paid $50.00 in cash at
 * 1:55 PM, yet the API payload carries no payment records and no method: only the balance.
 */
const LIVE_924886 = {
  UUID: "CC6YKK",
  SerialId: "924886",
  Status: "Done",
  SubStatus: "",
  JobDateTime: "2026-09-21 13:00:00",
  LastStatusUpdate: "2026-09-21 13:56:13",
  PaymentDueDate: "2026-09-21 00:00:00",
  SubTotal: 50,
  JobTotalPrice: 50,
  JobAmountDue: 0,
  item_cost: 0,
  tech_cost: 0,
  Tags: ["Work"],
  Team: [{ id: 271865, Name: "Daniel" }],
  LineItems: [{ Id: 39999653, Quantity: 1, Price: 50, Cost: 0, Taxable: 0, Name: "Restorative Tile & Grout Floor Cleaning", Description: "Our multi-step process goes beyond surface cleaning.", Type: "service" }],
}

/** Test-only 20% technician, no color-seal work, no tips. Real rates are never read here. */
const TWENTY = { rates: { nonColorRate: 0.2, colorRate: 0.25 }, options: { separateColorSeal: true, tipShare: 0.5 } }
const payoutFor = (job: ReturnType<typeof normalizeJob>) =>
  calcPayoutWithPaymentSplit(
    { jobTotal: job.jobTotal, colorSealTotal: job.colorSealTotal, cardServiceAmount: job.cardServiceAmount, cardTip: job.cardTipAmount, nonCardOwedTip: job.nonCardTipAmount },
    TWENTY.rates,
    TWENTY.options,
  )

/** A stored job_payments row as the admin confirmation action writes it. */
const manualRow = (method: string, amount: number, id = 1, paidAt: string | null = "2026-09-21T17:55:00.000Z") => ({
  id,
  externalId: null,
  source: "manual",
  method,
  amount: amount.toFixed(2),
  tipAmount: "0.00",
  paidAt: paidAt ? new Date(paidAt) : null,
  recordedBy: "admin",
})

describe("job #924886: what Workiz's job API actually returns", () => {
  it("is paid per the balance, but the payment method is unavailable, so the payout is held — not reported as unpaid", () => {
    const job = normalizeJob(LIVE_924886, settings, noCatalog)
    expect(job.jobTotal).toBe(50)
    expect(job.fullyPaid).toBe(true)
    expect(job.paidEvidence).toBe("balance")
    expect(job.payments).toEqual([])
    expect(job.totalPaid).toBe(50)
    // Provisionally non-card (no fee), but blocked until the method is known.
    expect(job.cardServiceAmount).toBe(0)
    expect(job.nonCardServiceAmount).toBe(50)
    const hold = job.warnings.find((w) => w.startsWith(PAYMENT_METHOD_UNKNOWN_PREFIX))
    expect(hold).toBeDefined()
    expect(hold).toMatch(/payment details unavailable/i)
    expect(hold).toMatch(/\$0\.00 due of \$50\.00/)
    expect(hold).not.toMatch(/has not paid|unpaid/i)
    expect(isBlockingWarning(hold!)).toBe(true)
    expect(gateReason(job, settings)).toBe(hold)
    expect(paymentEvidenceState(job.payments, job.amountDue)).toBe("unavailable")
  })

  it("the dashboard says 'Payment details unavailable' and explains the two remedies", () => {
    expect(paymentMethodsSummary([])).toEqual({ label: PAYMENT_DETAILS_UNAVAILABLE, mixed: false, count: 0 })
    const job = normalizeJob(LIVE_924886, settings, noCatalog)
    const explanation = explainPayoutStatus({ status: "hold", holdReason: job.warnings[0], jobStatus: "Done", fullyPaid: true, totalPaid: 50, grandTotal: 50, paidAt: null, paidBy: null })
    expect(explanation.headline).toBe("On hold: payment details unavailable from Workiz")
    expect(explanation.action).toMatch(/Payments tab/)
    expect(explanation.action).toMatch(/invoice/i)
  })

  it("after the admin confirms $50 cash from the Workiz Payments tab, the hold clears and Daniel's 20% is $10.00 with no card fee", () => {
    const external = externalRowsToPayments([manualRow("Cash", 50)], settings.cardMethodKeywords)
    expect(external).toEqual([
      { id: "manual:1", amount: 50, method: "Cash", isCard: false, methodKnown: true, isTip: false, source: "manual", date: "2026-09-21T17:55:00.000Z", recordedBy: "admin" },
    ])
    const job = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: external })
    expect(job.paidEvidence).toBe("payments")
    expect(job.fullyPaid).toBe(true)
    expect(job.cardServiceAmount).toBe(0)
    expect(job.nonCardServiceAmount).toBe(50)
    expect(job.warnings.filter(isBlockingWarning)).toEqual([])
    expect(gateReason(job, settings)).toBeNull()
    expect(paymentMethodsSummary(job.payments).label).toBe("Cash")
    expect(paymentSourceLabel(job.payments[0])).toMatch(/Confirmed by admin/)

    const payout = payoutFor(job)
    expect(toCents(payout.totalPayout)).toBe(10.0)
    expect(payout.cardNonColorAmount).toBe(0)
  })

  it("does not default a missing method to cash, infer it from the zero balance, or accept a blank method", () => {
    const blank = externalRowsToPayments([manualRow("", 50)], settings.cardMethodKeywords)
    expect(blank[0].methodKnown).toBe(false)
    const job = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: blank })
    expect(gateReason(job, settings)).toMatch(/not recognised/)
    expect(validateManualPayments([{ method: "", amount: 50, paidAt: null }], 50)).toMatchObject({ ok: false })
  })
})

describe("payment classification: manual cash/check/Zelle need no card fields", () => {
  it("recognises the methods Workiz can log and places them on the right side of the card fee", () => {
    expect(classifyPaymentMethod("Cash")).toEqual({ label: "Cash", isCard: false, known: true })
    expect(classifyPaymentMethod("check")).toEqual({ label: "Check", isCard: false, known: true })
    expect(classifyPaymentMethod("Zelle")).toEqual({ label: "Zelle", isCard: false, known: true })
    expect(classifyPaymentMethod("Cash App")).toEqual({ label: "Cash App", isCard: false, known: true })
    expect(classifyPaymentMethod("Venmo")).toEqual({ label: "Venmo", isCard: false, known: true })
    expect(classifyPaymentMethod("Bank transfer (offline)")).toEqual({ label: "Bank transfer", isCard: false, known: true })
    expect(classifyPaymentMethod("credit")).toEqual({ label: "Card", isCard: true, known: true })
    expect(classifyPaymentMethod("Credit Card")).toEqual({ label: "Card", isCard: true, known: true })
    expect(classifyPaymentMethod("Credit (offline)")).toEqual({ label: "Card", isCard: true, known: true })
    expect(classifyPaymentMethod("Wisetack")).toEqual({ label: "Wisetack", isCard: false, known: false })
    expect(classifyPaymentMethod("")).toEqual({ label: "Unknown method", isCard: false, known: false })
  })

  it("accepts a Workiz payment record that has only id, type and amount", () => {
    const payments = normalizePayments([{ id: "PAY-1", type: "Cash", amount: 50 }], settings)
    expect(payments).toEqual([{ id: "PAY-1", amount: 50, method: "Cash", isCard: false, methodKnown: true, isTip: false, source: "workiz-job", date: null }])
  })

  it("keeps an unknown method visible and holds the payout instead of treating it as cash", () => {
    const external = externalRowsToPayments([manualRow("Wisetack", 50)], settings.cardMethodKeywords)
    const job = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: external })
    expect(job.payments[0]).toMatchObject({ method: "Wisetack", isCard: false, methodKnown: false })
    expect(paymentMethodsSummary(job.payments).label).toBe("Wisetack")
    const reason = gateReason(job, settings)
    expect(reason).toMatch(/^Payment method unknown: \$50\.00 was recorded with a method that is not recognised \(Wisetack\)/)
    expect(explainPayoutStatus({ status: "hold", holdReason: reason, jobStatus: "Done", fullyPaid: true, totalPaid: 50, grandTotal: 50, paidAt: null, paidBy: null }).headline).toBe("On hold: payment method not recognised")
  })
})

describe("card fee follows the payment split ($50 regular work, 20% technician)", () => {
  it("all cash: $10.00", () => {
    const job = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: externalRowsToPayments([manualRow("Cash", 50)], settings.cardMethodKeywords) })
    expect(toCents(payoutFor(job).totalPayout)).toBe(10.0)
  })

  it("all card: $9.65", () => {
    const job = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: externalRowsToPayments([manualRow("Card", 50)], settings.cardMethodKeywords) })
    expect(job.cardServiceAmount).toBe(50)
    expect(gateReason(job, settings)).toBeNull()
    expect(toCents(payoutFor(job).totalPayout)).toBe(9.65)
  })

  it("$20 card deposit + $30 check balance: fee only on the card portion, $9.86", () => {
    const rows = [manualRow("Card", 20, 1, "2026-09-15T14:00:00.000Z"), manualRow("Check", 30, 2, "2026-09-21T17:55:00.000Z")]
    const job = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: externalRowsToPayments(rows, settings.cardMethodKeywords) })
    expect(job.cardServiceAmount).toBe(20)
    expect(job.nonCardServiceAmount).toBe(30)
    expect(job.fullyPaid).toBe(true)
    expect(gateReason(job, settings)).toBeNull()
    expect(paymentMethodsSummary(job.payments)).toEqual({ label: "Card + Check", mixed: true, count: 2 })
    expect(toCents(payoutFor(job).totalPayout)).toBe(9.86)
  })
})

describe("evidence states stay distinct", () => {
  it("payload without a payments array (not included) is null; an empty array (fetched, empty) is []", () => {
    expect(extractInvoiceWebhookPayments({ id: "IV-1", uuid: "3YBIBO" })).toBeNull()
    expect(extractInvoiceWebhookPayments({ id: "IV-1", uuid: "3YBIBO", payments: [] })).toMatchObject({ invoiceId: "IV-1", payments: [] })
  })

  it("no records and no balance is 'none', not paid", () => {
    const { JobAmountDue: _due, ...noBalance } = LIVE_924886
    const job = normalizeJob(noBalance, settings, noCatalog)
    expect(job.paidEvidence).toBe("none")
    expect(job.fullyPaid).toBe(false)
    expect(paymentEvidenceState(job.payments, job.amountDue)).toBe("none")
    expect(job.warnings.find((w) => w.startsWith(PAYMENT_METHOD_UNKNOWN_PREFIX))).toMatch(/neither payment records nor a balance/)
  })

  it("a failed or unauthorised fetch throws instead of becoming an empty payment list", async () => {
    const client = new WorkizClient({ apiToken: "api_test", apiSecret: "" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Forbidden", message: "Invalid API path or malformed API key." }), { status: 403 }))
    await expect(client.getJob("CC6YKK")).rejects.toThrow(/403/)

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ flag: false, msg: "job Not Found" }), { status: 200 }))
    await expect(client.getJob("NOPE01")).rejects.toThrow(/not found/i)
  })

  it("Workiz's balance decides paid status even when records claim otherwise", () => {
    const partiallyPaidInWorkiz = { ...LIVE_924886, JobAmountDue: 30 }
    const job = normalizeJob(partiallyPaidInWorkiz, settings, noCatalog, { externalPayments: externalRowsToPayments([manualRow("Cash", 50)], settings.cardMethodKeywords) })
    expect(job.fullyPaid).toBe(false)
    expect(gateReason(job, settings)).toBe("Job is not fully paid")
    expect(job.warnings).toContainEqual(expect.stringMatching(/Workiz still shows \$30\.00 due/))
  })

  it("a $0 balance that the records only partly cover is paid but held for the untyped remainder", () => {
    const depositOnly = externalRowsToPayments([manualRow("Card", 20)], settings.cardMethodKeywords)
    const job = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: depositOnly })
    expect(job.fullyPaid).toBe(true)
    expect(job.cardServiceAmount).toBe(20)
    expect(job.nonCardServiceAmount).toBe(30)
    const reason = gateReason(job, settings)
    expect(reason).toMatch(/cover only \$20\.00; the remaining \$30\.00 has no payment type/)
    expect(explainPayoutStatus({ status: "hold", holdReason: reason, jobStatus: "Done", fullyPaid: true, totalPaid: 50, grandTotal: 50, paidAt: null, paidBy: null }).headline).toBe("On hold: part of the payment has no type")
  })
})

describe("duplicates and repeat syncs", () => {
  it("the same Workiz payment id from two channels counts once", () => {
    const fromJob: NormalizedPayment[] = normalizePayments([{ id: "PAY-1", type: "Cash", amount: 50 }], settings)
    const fromWebhook: NormalizedPayment[] = normalizePayments([{ id: "PAY-1", type: "Cash", amount: 50 }], settings, "invoice-webhook")
    expect(mergePayments(fromJob, fromWebhook)).toHaveLength(1)
    const job = normalizeJob({ ...LIVE_924886, Payments: [{ id: "PAY-1", type: "Cash", amount: 50 }] }, settings, noCatalog, { externalPayments: fromWebhook })
    expect(job.payments).toHaveLength(1)
    expect(job.totalPaid).toBe(50)
    expect(gateReason(job, settings)).toBeNull()
  })

  it("duplicate stored rows with the same external id collapse to one", () => {
    const rows = [
      { ...manualRow("Cash", 50, 1), externalId: "PAY-9", source: "invoice-webhook" },
      { ...manualRow("Cash", 50, 2), externalId: "PAY-9", source: "invoice-webhook" },
    ]
    expect(externalRowsToPayments(rows, settings.cardMethodKeywords)).toHaveLength(1)
  })

  it("re-processing the same inputs is deterministic, so a repeat sync leaves the payout fingerprint unchanged", () => {
    const external = externalRowsToPayments([manualRow("Cash", 50)], settings.cardMethodKeywords)
    const a = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: external })
    const b = normalizeJob(LIVE_924886, settings, noCatalog, { externalPayments: externalRowsToPayments([manualRow("Cash", 50)], settings.cardMethodKeywords) })
    expect(b).toEqual(a)
  })

  it("re-submitting the confirmation form validates to the same entries", () => {
    const entries = [{ method: "Cash", amount: 50, paidAt: "2026-09-21T17:55:00.000Z" }]
    expect(validateManualPayments(entries, 50)).toEqual(validateManualPayments([...entries], 50))
  })
})

describe("invoice webhooks carry the payment type", () => {
  /** Payment shape from Workiz's published invoice webhook example (article 39192462158993). */
  const invoiceEvent = {
    trigger: { type: "invoice_paid", timestamp: "2026-09-21T17:56:00Z" },
    data: {
      id: "IV-bK9r2XyZL54aWDR0",
      uuid: "CC6YKK",
      serialId: "56",
      jobId: "JOB-BA5r7o4bqzR9MONa",
      subTotal: 50,
      totalPrice: 50,
      amountDue: 0,
      payments: [{ id: "PAY-BA5r7o4bqzR9MONa", type: "Cash", amount: 50, tipAmount: 0 }],
    },
    metadata: { automationId: "auto_790", ruleName: "Invoice paid" },
  }

  it("extracts id, type, amount and tip from a documented invoice event and keeps the job uuid", () => {
    const parsed = parseWebhookBody(invoiceEvent)
    expect(parsed.kind).toBe("invoice")
    expect(parsed.uuidCandidates).toEqual(["CC6YKK"])
    expect(parsed.invoice).toMatchObject({ invoiceId: "IV-bK9r2XyZL54aWDR0", jobId: "JOB-BA5r7o4bqzR9MONa", invoiceTotal: 50, amountDue: 0 })
    expect(parsed.invoice?.payments).toEqual([
      expect.objectContaining({ externalId: "PAY-BA5r7o4bqzR9MONa", source: "invoice-webhook", method: "Cash", amount: 50, tipAmount: 0, paidAt: "2026-09-21T17:56:00Z", invoiceId: "IV-bK9r2XyZL54aWDR0" }),
    ])
  })

  it("splits a payment with an attached tip into service and tip records, keeping the tip's own id", () => {
    const included = [{ id: 7, externalId: "PAY-2", source: "invoice-webhook", method: "Cash", amount: "110.00", tipAmount: "10.00", paidAt: null, recordedBy: null, raw: { [TIP_INCLUSION_RAW_KEY]: "included" } }]
    expect(externalRowsToPayments(included, settings.cardMethodKeywords)).toEqual([
      expect.objectContaining({ id: "PAY-2", amount: 100, isTip: false, source: "invoice-webhook", tipAmbiguous: undefined }),
      expect.objectContaining({ id: "PAY-2:tip", amount: 10, isTip: true }),
    ])

    // Default verdict is "separate": the amount is the service payment and the tip sits on top.
    const separate = [{ id: 8, externalId: "PAY-3", source: "invoice-webhook", method: "Cash", amount: "100.00", tipAmount: "10.00", paidAt: null, recordedBy: null, raw: null }]
    expect(externalRowsToPayments(separate, settings.cardMethodKeywords)).toEqual([
      expect.objectContaining({ id: "PAY-3", amount: 100, isTip: false }),
      expect.objectContaining({ id: "PAY-3:tip", amount: 10, isTip: true }),
    ])

    // "unknown" keeps the smaller card-fee base but flags both records so the payout is held.
    const unknown = [{ id: 9, externalId: "PAY-4", source: "invoice-webhook", method: "Credit Card", amount: "100.00", tipAmount: "10.00", paidAt: null, recordedBy: null, raw: { [TIP_INCLUSION_RAW_KEY]: "unknown" } }]
    expect(externalRowsToPayments(unknown, settings.cardMethodKeywords).every((p) => p.tipAmbiguous === true)).toBe(true)
  })

  it("decides whether webhook amounts include their tips from the document totals", () => {
    const pays = [{ amount: 100, tipAmount: 10 }]
    expect(inferTipInclusion(pays, 100, 0)).toBe("separate")
    expect(inferTipInclusion(pays, 90, 0)).toBe("included")
    expect(inferTipInclusion(pays, 95, 0)).toBe("unknown")
    expect(inferTipInclusion(pays, null, 0)).toBe("unknown")
    expect(inferTipInclusion([{ amount: 100, tipAmount: 0 }], null, null)).toBe("separate")
  })

  it("job events never carry payments", () => {
    expect(parseWebhookBody({ trigger: { type: "job_status_changed" }, data: { uuid: "CC6YKK", amountDue: 0 } }).invoice).toBeNull()
  })
})

describe("admin confirmation validation", () => {
  it("requires every payment on the Workiz Payments tab to be entered", () => {
    expect(validateManualPayments([{ method: "Cash", amount: 20, paidAt: null }], 50)).toMatchObject({ ok: false, error: expect.stringMatching(/\$20\.00 but the Workiz invoice total is \$50\.00/) })
    expect(validateManualPayments([{ method: "Card", amount: 20, paidAt: null }, { method: "Check", amount: 30, paidAt: null }], 50)).toMatchObject({ ok: true })
  })

  it("rejects methods Workiz cannot record, non-positive amounts, bad dates and empty sets", () => {
    expect(validateManualPayments([{ method: "Gift card", amount: 50, paidAt: null }], 50)).toMatchObject({ ok: false })
    expect(validateManualPayments([{ method: "Cash", amount: 0, paidAt: null }], 50)).toMatchObject({ ok: false })
    expect(validateManualPayments([{ method: "Cash", amount: 50, paidAt: "yesterday" }], 50)).toMatchObject({ ok: false })
    expect(validateManualPayments([], 50)).toMatchObject({ ok: false })
  })

  it("accepts a tip inside a payment (Workiz's Payments tab shows the charge tip-included) and defaults a missing tip to zero", () => {
    const checked = validateManualPayments([{ method: "Card", amount: 712.82, paidAt: null }, { method: "Card", amount: 1776.11, tipAmount: 231.67, paidAt: null }], 2488.93)
    expect(checked).toMatchObject({ ok: true })
    if (checked.ok) expect(checked.entries.map((e) => e.tipAmount)).toEqual([0, 231.67])
  })

  it("rejects a tip larger than its payment or below zero", () => {
    expect(validateManualPayments([{ method: "Card", amount: 100, tipAmount: 120, paidAt: null }], 100)).toMatchObject({ ok: false, error: expect.stringMatching(/\$120\.00 tip is larger than the \$100\.00 payment/) })
    expect(validateManualPayments([{ method: "Card", amount: 100, tipAmount: -5, paidAt: null }], 100)).toMatchObject({ ok: false })
    // A payment that was entirely tip is allowed.
    expect(validateManualPayments([{ method: "Cash", amount: 20, tipAmount: 20, paidAt: null }], 20)).toMatchObject({ ok: true })
  })

  it("stored manual rows with an included tip split into service and tip records; an all-tip row has no service record", () => {
    const rows = externalRowsToPayments(
      [
        { ...manualRow("Card", 1776.11, 7), tipAmount: "231.67", raw: { [TIP_INCLUSION_RAW_KEY]: "included" } },
        { ...manualRow("Cash", 20, 8), tipAmount: "20.00", raw: { [TIP_INCLUSION_RAW_KEY]: "included" } },
      ],
      settings.cardMethodKeywords,
    )
    expect(rows.map((p) => [p.id, p.isTip, p.amount, p.isCard])).toEqual([
      ["manual:7", false, 1544.44, true],
      ["manual:7:tip", true, 231.67, true],
      ["manual:8:tip", true, 20, false],
    ])
    expect(rows.every((p) => !p.tipAmbiguous)).toBe(true)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
