import { describe, expect, it } from "vitest"
import type { JobPaymentRow, NormalizedPayment, TechnicianProfile } from "@/lib/db/schema"
import { cardShareOf, toCents } from "@/lib/payout/calculator"
import { dueTotals, initialSelection, setTicked } from "@/lib/payout/due-selection"
import { computeForProfile, gateReason, invoiceCardFee } from "@/lib/payout/engine"
import { confirmationSeedRows } from "@/lib/payout/payment-confirmation"
import { originalPaymentMethod, paymentConfirmationNeeded, paymentMethodLabel, paymentSourceLabel } from "@/lib/payout/presentation"
import { planSegments, type PlannableProfile, type SegmentPlan } from "@/lib/payout/segments"
import { DEFAULT_WORKIZ_SETTINGS } from "@/lib/settings"
import { PAYMENT_METHOD_UNKNOWN_PREFIX, PAYMENT_REVERSED_PREFIX, UNITEMIZED_SURPLUS_PREFIX, normalizeJob, normalizePayments, type NormalizedJob } from "@/lib/workiz/normalize"
import { CREDIT_CARD_LABEL, classifyPaymentMethod, normalizeMethodText, paymentOutcome, resolvePaymentMethod } from "@/lib/workiz/payment-method"
import { TIP_INCLUSION_RAW_KEY, inferTipInclusion, selectPaymentEvidence, validateManualPayments, type ExternalPaymentInput, type TipInclusion } from "@/lib/workiz/payments"
import { parseWebhookBody } from "@/lib/workiz/webhook"

/**
 * Workiz names a card payment three ways: `Credit`, `Charge` and `Credit Charge`. Everything
 * here runs the same code the sync uses (webhook payload -> stored row -> normalizeJob ->
 * planSegments -> computeForProfile); the payloads are sanitized copies of live events.
 */
const settings = DEFAULT_WORKIZ_SETTINGS
const keywords = settings.cardMethodKeywords
const noCatalog = new Map<string, boolean>()
const cents = toCents

type Tech = PlannableProfile & Pick<TechnicianProfile, "nonColorRate" | "colorRate" | "tipShare" | "separateColorSeal">
const tech = (id: number, name: string, nonColor: number, color: number): Tech => ({ id, name, lineItemMarker: null, ownedWorkType: null, nonColorRate: nonColor.toFixed(6), colorRate: color.toFixed(6), tipShare: "0.500000", separateColorSeal: true })
const ARTHUR = tech(3, "Arthur", 0.2, 0.25)
const VIKTOR = tech(4, "Viktor", 0.2, 0.25)
const VADIM = tech(1, "Vadim", 0.25, 0.25)
const ROSTER = [VADIM, ARTHUR, VIKTOR]
const TEAM = { arthur: { id: "9003", Name: "Arthur" }, viktor: { id: "9004", Name: "Viktor" }, vadim: { id: "9001", Name: "Vadim" } }

const payoutFor = (job: NormalizedJob, plan: SegmentPlan, t: Tech) => {
  const segment = plan.segmentFor.get(t.id)
  if (!segment) throw new Error(`${t.name} is not on the plan`)
  return computeForProfile(segment, t as unknown as TechnicianProfile, { tipShare: plan.tipShareFor.get(t.id) ?? 0, cardServiceShare: cardShareOf(job.cardServiceAmount, job.jobTotal) })
}

/** What `job/get` returns: totals and a balance, never the payments. */
const rawJob = (over: Record<string, unknown> = {}) => ({
  UUID: "REQ1K",
  SerialId: "1000",
  Status: "Done",
  JobType: "Work",
  Team: [TEAM.arthur],
  LastStatusUpdate: "2026-11-12 13:45:38",
  SubTotal: 1000,
  JobTotalPrice: 1000,
  JobAmountDue: 0,
  LineItems: [{ Name: "Restorative Tile & Grout Floor Cleaning", Price: 1000, Quantity: 1, Type: "service" }],
  ...over,
})

/** A webhook payment record in the shape Workiz sends today. */
const pay = (id: string, type: string, amount: number, over: Record<string, unknown> = {}) => ({ id, type, amount, tipAmount: 0, status: "succeeded", date: "2026-11-12 13:36:15", estimateId: null, confirmationCode: "", collectedById: "USR-1", ...over })

const event = (trigger: string, data: Record<string, unknown>) => ({ trigger: { type: trigger, timestamp: "2026-11-12T18:45:42.177Z" }, data, metadata: { ruleName: "Payout app" } })

/** Store webhook payments the way `recordExternalPayments` does (one row per Workiz id, latest event wins). */
function store(rows: Map<string, JobPaymentRow>, payments: ExternalPaymentInput[], tipInclusion: TipInclusion) {
  for (const p of payments) {
    if (!p.externalId) continue
    const previous = rows.get(p.externalId)
    rows.set(p.externalId, {
      id: previous?.id ?? rows.size + 1,
      jobUuid: "REQ1K",
      externalId: p.externalId,
      source: previous?.source ?? p.source,
      method: p.method,
      amount: p.amount.toFixed(2),
      tipAmount: p.tipAmount.toFixed(2),
      paidAt: p.paidAt ? new Date(`${p.paidAt.replace(" ", "T")}Z`) : null,
      paidAtFromPayload: p.paidAtFromPayload,
      invoiceId: p.invoiceId,
      reference: p.reference,
      recordedBy: null,
      raw: { ...(p.raw as object), [TIP_INCLUSION_RAW_KEY]: tipInclusion },
      createdAt: new Date("2026-11-12T18:45:43Z"),
      updatedAt: new Date("2026-11-12T18:45:43Z"),
    })
  }
  return rows
}

/** Apply stored events to a job exactly as a sync does, any number of times. */
function syncFromEvents(raw: Record<string, unknown>, events: unknown[], manual: JobPaymentRow[] = []) {
  const rows = new Map<string, JobPaymentRow>()
  for (const body of events) {
    const parsed = parseWebhookBody(body)
    if (parsed.invoice) store(rows, parsed.invoice.payments, parsed.invoice.tipInclusion)
  }
  const evidence = selectPaymentEvidence([...rows.values(), ...manual], keywords)
  return { job: normalizeJob(raw, settings, noCatalog, { externalPayments: evidence.payments, reversedPayments: evidence.reversed }), evidence, rows }
}

const manualRow = (id: number, method: string, amount: number, tip = 0): JobPaymentRow => ({
  id: 900 + id,
  jobUuid: "REQ1K",
  externalId: null,
  source: "manual",
  method,
  amount: amount.toFixed(2),
  tipAmount: tip.toFixed(2),
  paidAt: null,
  paidAtFromPayload: false,
  invoiceId: null,
  reference: null,
  recordedBy: "admin",
  raw: tip > 0 ? { [TIP_INCLUSION_RAW_KEY]: "included" } : null,
  createdAt: new Date("2026-11-12T19:00:00Z"),
  updatedAt: new Date("2026-11-12T19:00:00Z"),
})

describe("the three Workiz card labels are one method: Credit Card", () => {
  it.each(["Credit", "Charge", "Credit Charge", "credit", "charge", "CREDIT CHARGE", "Credit charge", "  charge  ", "credit    charge", " Credit\tCharge\n", "Credit-Charge", "credit_charge"])("%j is a credit card payment", (label) => {
    expect(classifyPaymentMethod(label, keywords)).toEqual({ label: CREDIT_CARD_LABEL, isCard: true, known: true })
    // Recognition does not depend on the admin's keyword list.
    expect(classifyPaymentMethod(label)).toEqual({ label: "Credit Card", isCard: true, known: true })
  })

  it("normalizes capitalization, surrounding spaces and repeated spaces before matching", () => {
    expect(normalizeMethodText("  Credit    CHARGE ")).toBe("credit charge")
    expect(normalizeMethodText("Credit (offline)")).toBe("credit offline")
    expect(normalizeMethodText(null)).toBe("")
  })

  it.each(["Card", "Credit Card", "Credit (offline)", "cc", "Visa", "Visa ****1234", "Mastercard", "Master Card", "Amex", "American Express", "Discover", "Stripe", "Debit card", "Workiz Pay", "Credit card payment"])(
    "keeps the card label %j that already worked",
    (label) => {
      expect(classifyPaymentMethod(label, keywords)).toMatchObject({ label: "Credit Card", isCard: true, known: true })
    },
  )

  it.each([
    ["Cash", "Cash"],
    ["Check", "Check"],
    ["check", "Check"],
    ["Check #1043", "Check"],
    ["Zelle", "Zelle"],
    ["Venmo", "Venmo"],
    ["Cash App", "Cash App"],
    ["Bank transfer (offline)", "Bank transfer"],
    ["ACH", "Bank transfer"],
  ])("%j stays %s with no card fee", (text, label) => {
    expect(classifyPaymentMethod(text, keywords)).toEqual({ label, isCard: false, known: true })
  })

  it.each(["Chargeback", "Charge back", "Charged back", "Charge refund", "Refund", "Refunded charge", "Credit memo", "Store credit", "Credit refund", "Discharge", "Recharge fee", "Accommodation", "Other", "Card declined", "Credit check", "Charge dispute"])(
    "%j is not read as a card payment",
    (text) => {
      const cls = classifyPaymentMethod(text, keywords)
      expect(cls.isCard).toBe(false)
      expect(cls.known).toBe(false)
    },
  )

  it("an admin keyword is matched as a whole word, never inside another word", () => {
    expect(classifyPaymentMethod("Square", ["square"])).toMatchObject({ label: "Credit Card", isCard: true })
    expect(classifyPaymentMethod("Squarespace invoice", ["square"]).known).toBe(false)
    // "cc" is a default keyword; it used to match inside "account" and turn a bank payment into a card one.
    expect(classifyPaymentMethod("Bank account", keywords)).toEqual({ label: "Bank transfer", isCard: false, known: true })
    expect(classifyPaymentMethod("Account credit transfer", keywords).isCard).toBe(false)
  })

  it("shows Credit Card and keeps what Workiz sent for troubleshooting", () => {
    expect(paymentMethodLabel("charge", true)).toBe("Credit Card")
    expect(paymentMethodLabel("Credit Charge")).toBe("Credit Card")
    expect(originalPaymentMethod({ method: "charge", isCard: true, source: "job-webhook" })).toBe("charge")
    expect(originalPaymentMethod({ method: "Credit Card", isCard: true, source: "invoice-webhook" })).toBeNull()
    expect(originalPaymentMethod({ method: "Card", isCard: true, source: "manual" })).toBeNull()
    expect(paymentSourceLabel({ source: "job-webhook", recordedBy: null })).toBe("From Workiz job webhook")
  })
})

describe("reading the method from the fields Workiz actually sends", () => {
  it("live record: the method is in `type`", () => {
    expect(resolvePaymentMethod(pay("PAY-1", "charge", 2024.95), keywords)).toEqual({ label: "Credit Card", isCard: true, known: true, original: "charge" })
    expect(resolvePaymentMethod({ id: "PAY-2", type: "Credit charge", amount: 754.86, tipAmount: 0 }, keywords)).toMatchObject({ label: "Credit Card", original: "Credit charge" })
    expect(resolvePaymentMethod(pay("PAY-3", "check", 1102.26), keywords)).toMatchObject({ label: "Check", isCard: false, known: true, original: "check" })
  })

  it("a method split across fields is read as one", () => {
    expect(resolvePaymentMethod({ type: "Credit", method: "Charge" }, keywords)).toEqual({ label: "Credit Card", isCard: true, known: true, original: "Credit Charge" })
    expect(resolvePaymentMethod({ type: "payment", paymentMethod: "credit" }, keywords)).toMatchObject({ label: "Credit Card", isCard: true })
    expect(resolvePaymentMethod({ type: "charge", paymentMethod: { type: "card", brand: "visa" } }, keywords)).toMatchObject({ label: "Credit Card", isCard: true, original: "charge card visa" })
    // The same value in two fields is one value.
    expect(resolvePaymentMethod({ type: "Charge", method: "charge" }, keywords).original).toBe("Charge")
  })

  it("fields that disagree, or that name something that is not a method, are not recognised", () => {
    expect(resolvePaymentMethod({ type: "charge", method: "check" }, keywords)).toMatchObject({ known: false, isCard: false, original: "charge check" })
    expect(resolvePaymentMethod({ type: "charge", method: "refund" }, keywords)).toMatchObject({ known: false, isCard: false })
    expect(resolvePaymentMethod({ amount: 50 }, keywords)).toMatchObject({ known: false, label: "Unknown method", original: "" })
  })

  it("a description or note never decides the method", () => {
    // `Note`/`description` are not method fields, so "paid by credit card" in a note cannot make cash a card payment.
    const [cash] = normalizePayments([{ id: "P1", type: "Cash", amount: 50, Note: "customer wanted to pay by credit card, paid cash" }], settings)
    expect(cash).toMatchObject({ method: "Cash", methodLabel: "Cash", isCard: false, methodKnown: true })
  })

  it("only an explicit failure or reversal disqualifies a record", () => {
    expect(paymentOutcome(pay("P", "charge", 10))).toBe("received")
    expect(paymentOutcome({ type: "Check #1043", status: "pending" })).toBe("received")
    expect(paymentOutcome({ type: "Cash" })).toBe("received")
    expect(paymentOutcome(pay("P", "charge", 10, { status: "failed" }))).toBe("failed")
    expect(paymentOutcome(pay("P", "charge", 10, { status: "Declined" }))).toBe("failed")
    expect(paymentOutcome(pay("P", "charge", 10, { status: "refunded" }))).toBe("reversed")
    expect(paymentOutcome(pay("P", "charge", 10, { status: "partially refunded" }))).toBe("reversed")
    expect(paymentOutcome(pay("P", "chargeback", 10))).toBe("reversed")
    expect(paymentOutcome({ type: "refund", amount: 10 })).toBe("reversed")
  })
})

describe("required example: $300 card deposit labelled `Charge` + $700 check on a $1,000 job", () => {
  const depositEvent = event("estimate_deposit_paid", { id: "ES-77", jobId: "JOB-1", total: 1000, amountDue: 700, payments: [pay("PAY-DEP", "Charge", 300, { date: "2026-10-26 10:37:53", estimateId: "ES-77" })] })
  const doneEvent = event("job_status_done", {
    id: "JOB-1",
    uuid: "REQ1K",
    serialId: "1000",
    status: "Done",
    subTotal: 1000,
    discountAmount: 0,
    taxAmount: 0,
    tipAmount: 0,
    totalPrice: 1000,
    amountDue: 0,
    payments: [pay("PAY-DEP", "Charge", 300, { date: "2026-10-26 10:37:53", estimateId: "ES-77" }), pay("PAY-FIN", "check", 700)],
  })
  const { job } = syncFromEvents(rawJob(), [depositEvent, doneEvent])

  it("recognises the deposit as a credit card payment and the balance as a check", () => {
    expect(job.payments.map((p) => [p.method, p.methodLabel, p.isCard, p.methodKnown, p.amount])).toEqual([
      ["Charge", "Credit Card", true, true, 300],
      ["check", "Check", false, true, 700],
    ])
    expect(job.cardServiceAmount).toBe(300)
    expect(job.nonCardServiceAmount).toBe(700)
    expect(job.fullyPaid).toBe(true)
    expect(job.warnings).toEqual([])
    expect(gateReason(job, settings)).toBeNull()
  })

  it("card fee $10.50; net commissionable services $989.50", () => {
    const fee = invoiceCardFee(job)
    expect(cents(fee.fee)).toBe(10.5)
    expect(cents(fee.adjustedServiceSubtotal)).toBe(989.5)
    expect(fee.cardShare).toBeCloseTo(0.3, 12)
  })

  it("standard technician at 20%: $197.90", () => {
    const plan = planSegments(job, [ARTHUR], ROSTER)
    expect(cents(payoutFor(job, plan, ARTHUR).totalPayout)).toBe(197.9)
  })

  it("Vadim at 25%: $247.38", () => {
    const { job: vadimJob } = syncFromEvents(rawJob({ Team: [TEAM.vadim] }), [depositEvent, doneEvent])
    const plan = planSegments(vadimJob, [VADIM], ROSTER)
    expect(cents(payoutFor(vadimJob, plan, VADIM).totalPayout)).toBe(247.38)
  })

  it.each(["Credit", "Charge", "Credit Charge", "credit charge", " CHARGE "])("gives the same result when Workiz labels the deposit %j", (label) => {
    const done = event("job_status_done", { ...doneEvent.data, payments: [pay("PAY-DEP", label, 300), pay("PAY-FIN", "Check", 700)] })
    const { job: j } = syncFromEvents(rawJob(), [done])
    expect(cents(invoiceCardFee(j).fee)).toBe(10.5)
    expect(cents(payoutFor(j, planSegments(j, [ARTHUR], ROSTER), ARTHUR).totalPayout)).toBe(197.9)
    expect(gateReason(j, settings)).toBeNull()
  })

  it("cash, check and Zelle carry no deduction: $200.00", () => {
    for (const method of ["Cash", "Check", "Zelle"]) {
      const done = event("job_status_done", { ...doneEvent.data, payments: [pay("PAY-A", method, 300), pay("PAY-B", method, 700)] })
      const { job: j } = syncFromEvents(rawJob(), [done])
      expect(cents(invoiceCardFee(j).fee)).toBe(0)
      expect(cents(payoutFor(j, planSegments(j, [ARTHUR], ROSTER), ARTHUR).totalPayout)).toBe(200)
    }
  })
})

describe("card-funded tips", () => {
  /** $1,000 of services paid by check, then a $100 tip charged to a card. Workiz's total includes the tip. */
  const tipEvent = event("job_status_done", {
    uuid: "REQ1K",
    subTotal: 1000,
    discountAmount: 0,
    taxAmount: 0,
    tipAmount: 100,
    totalPrice: 1100,
    amountDue: 0,
    payments: [pay("PAY-SVC", "check", 1000), pay("PAY-TIP", "Charge", 100, { tipAmount: 100 })],
  })

  it("a $100 tip paid by card becomes $96.50 before the tip-sharing rules", () => {
    const { job } = syncFromEvents(rawJob({ JobTotalPrice: 1100 }), [tipEvent])
    expect(job.cardTipAmount).toBe(100)
    expect(job.nonCardTipAmount).toBe(0)
    expect(job.cardServiceAmount).toBe(0)
    expect(job.warnings).toEqual([])
    // One regular technician keeps the whole tip after the fee.
    const solo = payoutFor(job, planSegments(job, [ARTHUR], ROSTER), ARTHUR)
    expect(cents(solo.tipPayout)).toBe(96.5)
    expect(cents(solo.basePayout)).toBe(200)
  })

  it("two regular technicians split the $96.50 equally: $48.25 each", () => {
    const { job } = syncFromEvents(rawJob({ JobTotalPrice: 1100, Team: [TEAM.arthur, TEAM.viktor] }), [tipEvent])
    const plan = planSegments(job, [ARTHUR, VIKTOR], ROSTER)
    const a = payoutFor(job, plan, ARTHUR)
    const v = payoutFor(job, plan, VIKTOR)
    expect(cents(a.tipPayout)).toBe(48.25)
    expect(cents(v.tipPayout)).toBe(48.25)
    expect(cents(a.tipPayout + v.tipPayout)).toBe(96.5)
  })

  it("the same tip paid by check is not reduced", () => {
    const check = event("job_status_done", { ...tipEvent.data, payments: [pay("PAY-SVC", "Charge", 1000), pay("PAY-TIP", "check", 100, { tipAmount: 100 })] })
    const { job } = syncFromEvents(rawJob({ JobTotalPrice: 1100 }), [check])
    expect(job.nonCardTipAmount).toBe(100)
    expect(cents(payoutFor(job, planSegments(job, [ARTHUR], ROSTER), ARTHUR).tipPayout)).toBe(100)
  })

  it("live #924916: the tip rides inside the final card payment and inside Workiz's total", () => {
    const live = event("job_status_done", {
      uuid: "REQ1K",
      subTotal: 1464.49,
      discountAmount: 0,
      taxAmount: 0,
      tipAmount: 153.77,
      serviceFeeAmount: 0,
      totalPrice: 1618.26,
      amountDue: -0.00000000000022737367544323,
      payments: [pay("PAY-DEP", "charge", 439.35, { date: "2026-10-08 11:17:03", estimateId: "ES-1" }), pay("PAY-FIN", "charge", 1178.91, { tipAmount: 153.77, date: "2026-11-09 13:40:58" })],
    })
    expect(parseWebhookBody(live).invoice?.tipInclusion).toBe("included")
    const raw = rawJob({ SubTotal: 1464.49, JobTotalPrice: 1618.26, JobAmountDue: -2.2737367544323e-13, LineItems: [{ Name: "Tile & Grout Cleaning", Price: 1464.49, Quantity: 1, Type: "service" }] })
    const { job } = syncFromEvents(raw, [live])
    expect(job.jobTotal).toBe(1464.49)
    expect(job.cardServiceAmount).toBe(1464.49)
    expect(job.cardTipAmount).toBe(153.77)
    expect(job.fullyPaid).toBe(true)
    expect(job.warnings).toEqual([])
    // The fee is taken once from services and once from the tip, never twice from either.
    expect(cents(invoiceCardFee(job).fee)).toBe(cents(1464.49 * 0.035))
    expect(cents(payoutFor(job, planSegments(job, [ARTHUR], ROSTER), ARTHUR).tipPayout)).toBe(cents(153.77 * 0.965))
  })

  it("a card deposit and a check balance that carried the tip: the fee base is the card deposit only", () => {
    const mixed = event("job_status_done", {
      uuid: "REQ1K",
      subTotal: 1000,
      tipAmount: 100,
      taxAmount: 0,
      totalPrice: 1100,
      amountDue: 0,
      payments: [pay("PAY-DEP", "Charge", 300), pay("PAY-FIN", "check", 800, { tipAmount: 100 })],
    })
    const { job } = syncFromEvents(rawJob({ JobTotalPrice: 1100 }), [mixed])
    expect(job.cardServiceAmount).toBe(300)
    expect(job.nonCardServiceAmount).toBe(700)
    expect(job.nonCardTipAmount).toBe(100)
    expect(cents(invoiceCardFee(job).fee)).toBe(10.5)
  })

  it("decides tip inclusion from the event's own arithmetic", () => {
    const payments = [{ amount: 1178.91, tipAmount: 153.77 }, { amount: 439.35, tipAmount: 0 }]
    // Total contains the tip and the payments add up to it: the tip is inside the payment.
    expect(inferTipInclusion(payments, 1618.26, 0, { subTotal: 1464.49, tipAmount: 153.77, taxAmount: 0 })).toBe("included")
    // Total contains the tip but the payments only add up to the services: tips are on top.
    expect(inferTipInclusion([{ amount: 1025.14, tipAmount: 153.77 }, { amount: 439.35, tipAmount: 0 }], 1618.26, 0, { subTotal: 1464.49, tipAmount: 153.77 })).toBe("separate")
    // Total does not contain the tip.
    expect(inferTipInclusion([{ amount: 1000, tipAmount: 100 }], 1000, 0, { subTotal: 1000, tipAmount: 100 })).toBe("separate")
    expect(inferTipInclusion([{ amount: 1100, tipAmount: 100 }], 1000, 0, { subTotal: 1000, tipAmount: 100 })).toBe("included")
    // Numbers that do not reconcile are never guessed.
    expect(inferTipInclusion([{ amount: 1050, tipAmount: 100 }], 1100, 0, { subTotal: 1000, tipAmount: 100 })).toBe("unknown")
  })
})

describe("one payment is counted once, however many Workiz records repeat it", () => {
  const payments = [pay("PAY-DEP", "charge", 867.84, { date: "2026-10-26 10:37:53", estimateId: "ES-1" }), pay("PAY-FIN", "charge", 2024.95)]
  const money = { subTotal: 2892.79, discountAmount: 0, taxAmount: 0, tipAmount: 0, totalPrice: 2892.79, amountDue: 0 }
  // Live #924950: the estimate, the invoice (twice) and the job event all list the same payments.
  const estimate = event("estimate_deposit_paid", { id: "ES-1", jobId: "JOB-1", total: 2892.79, amountDue: 2024.95, payments: [payments[0]] })
  const invoice = event("invoice_paid_in_full", { id: "IV-1", uuid: "REQ1K", jobId: "JOB-1", ...money, payments })
  const jobDone = event("job_status_done", { id: "JOB-1", uuid: "REQ1K", ...money, payments })
  const raw = rawJob({ SubTotal: 2892.79, JobTotalPrice: 2892.79, Team: [TEAM.vadim], LineItems: [{ Name: "Shower restoration", Price: 2892.79, Quantity: 1, Type: "service" }] })

  it("job events carry the payments and are read like invoice events", () => {
    const parsed = parseWebhookBody(jobDone)
    expect(parsed.kind).toBe("job")
    expect(parsed.invoice?.payments.map((p) => [p.externalId, p.source, p.method, p.amount])).toEqual([
      ["PAY-DEP", "job-webhook", "charge", 867.84],
      ["PAY-FIN", "job-webhook", "charge", 2024.95],
    ])
  })

  it("estimate + invoice + invoice again + job event = two payments, one fee", () => {
    const { job, rows } = syncFromEvents(raw, [estimate, invoice, invoice, jobDone])
    expect(rows.size).toBe(2)
    expect(job.payments).toHaveLength(2)
    expect(job.totalPaid).toBe(2892.79)
    expect(job.cardServiceAmount).toBe(2892.79)
    expect(cents(invoiceCardFee(job).fee)).toBe(cents(2892.79 * 0.035))
    expect(cents(payoutFor(job, planSegments(job, [VADIM], ROSTER), VADIM).totalPayout)).toBe(cents(2892.79 * 0.965 * 0.25))
  })

  it("a repeated sync or a reprocess leaves every figure unchanged", () => {
    const first = syncFromEvents(raw, [estimate, invoice, jobDone])
    const again = syncFromEvents(raw, [estimate, invoice, jobDone, invoice, jobDone, estimate])
    expect(again.job.cardServiceAmount).toBe(first.job.cardServiceAmount)
    expect(again.job.totalPaid).toBe(first.job.totalPaid)
    expect(invoiceCardFee(again.job)).toEqual(invoiceCardFee(first.job))
    expect(again.job.payments).toEqual(first.job.payments)
    const total = (j: NormalizedJob) => payoutFor(j, planSegments(j, [VADIM], ROSTER), VADIM).totalPayout
    expect(total(again.job)).toBe(total(first.job))
  })

  it("the same transaction under two Workiz ids (same amount, tip and timestamp) is one payment", () => {
    const twice = event("job_status_done", { id: "JOB-1", uuid: "REQ1K", ...money, payments: [payments[0], payments[1], { ...payments[1], id: "PAY-FIN-COPY" }] })
    const { job, rows } = syncFromEvents(raw, [twice])
    expect(rows.size).toBe(3)
    expect(job.payments).toHaveLength(2)
    expect(job.totalPaid).toBe(2892.79)
  })

  it("two genuinely separate payments of the same amount both count", () => {
    const two = event("job_status_done", { uuid: "REQ1K", subTotal: 1000, tipAmount: 0, totalPrice: 1000, amountDue: 0, payments: [pay("PAY-A", "charge", 500, { date: "2026-11-01 09:00:00" }), pay("PAY-B", "charge", 500, { date: "2026-11-12 13:36:15" })] })
    const { job } = syncFromEvents(rawJob(), [two])
    expect(job.payments).toHaveLength(2)
    expect(job.totalPaid).toBe(1000)
  })

  it("a record without a Workiz id is still one record when it states its date", () => {
    const noId = event("job_status_done", { uuid: "REQ1K", subTotal: 1000, tipAmount: 0, totalPrice: 1000, amountDue: 0, payments: [{ type: "Charge", amount: 1000, tipAmount: 0, status: "succeeded", date: "2026-11-12 13:36:15" }] })
    const { job, rows } = syncFromEvents(rawJob(), [noId, noId, noId])
    expect(rows.size).toBe(1)
    expect(job.cardServiceAmount).toBe(1000)
  })

  it("an admin confirmation and the Workiz records for the same money are not added together", () => {
    const { job, evidence } = syncFromEvents(raw, [invoice, jobDone], [manualRow(1, "Card", 867.84), manualRow(2, "Card", 2024.95)])
    expect(evidence.supersededByConfirmation).toBe(2)
    expect(job.payments).toHaveLength(2)
    expect(job.payments.every((p) => p.source === "manual")).toBe(true)
    expect(job.totalPaid).toBe(2892.79)
    expect(job.cardServiceAmount).toBe(2892.79)
    // Same when the admin typed it as one payment.
    const combined = syncFromEvents(raw, [invoice, jobDone], [manualRow(1, "Credit Card", 2892.79)])
    expect(combined.job.payments).toHaveLength(1)
    expect(combined.job.totalPaid).toBe(2892.79)
  })

  it("a payment Workiz reports after the admin confirmed the earlier ones is added, not ignored", () => {
    const grown = rawJob({ SubTotal: 1200, JobTotalPrice: 1200, LineItems: [{ Name: "Cleaning", Price: 1200, Quantity: 1, Type: "service" }] })
    const later = event("job_status_done", { uuid: "REQ1K", subTotal: 1200, tipAmount: 0, totalPrice: 1200, amountDue: 0, payments: [pay("PAY-A", "charge", 1000, { date: "2026-11-01 09:00:00" }), pay("PAY-B", "check", 200)] })
    const { job } = syncFromEvents(grown, [later], [manualRow(1, "Card", 1000)])
    expect(job.payments.map((p) => [p.source, p.amount, p.isCard])).toEqual([
      ["job-webhook", 200, false],
      ["manual", 1000, true],
    ])
    expect(job.totalPaid).toBe(1200)
    expect(job.fullyPaid).toBe(true)
  })
})

describe("refunds, chargebacks and failed charges are never successful card payments", () => {
  const money = { uuid: "REQ1K", subTotal: 1000, tipAmount: 0, totalPrice: 1000, amountDue: 0 }

  it("a declined attempt followed by a successful charge is one card payment and no hold", () => {
    const done = event("job_status_done", { ...money, payments: [pay("PAY-X", "charge", 1000, { status: "failed", date: "2026-11-12 13:30:00" }), pay("PAY-Y", "charge", 1000)] })
    const { job } = syncFromEvents(rawJob(), [done])
    expect(job.payments).toHaveLength(1)
    expect(job.totalPaid).toBe(1000)
    expect(gateReason(job, settings)).toBeNull()
  })

  it("a refunded card charge re-paid by check carries no card fee and is held for a look", () => {
    const done = event("job_status_done", { ...money, payments: [pay("PAY-X", "charge", 1000, { status: "refunded", date: "2026-11-10 10:00:00" }), pay("PAY-Y", "check", 1000)] })
    const { job, evidence } = syncFromEvents(rawJob(), [done])
    expect(evidence.reversed).toEqual([{ amount: 1000, method: "charge", status: "refunded" }])
    expect(job.cardServiceAmount).toBe(0)
    expect(job.nonCardServiceAmount).toBe(1000)
    expect(cents(invoiceCardFee(job).fee)).toBe(0)
    expect(gateReason(job, settings)).toMatch(new RegExp(`^${PAYMENT_REVERSED_PREFIX}`))
  })

  it("a chargeback record is not a payment", () => {
    const done = event("job_status_done", { ...money, amountDue: 1000, payments: [pay("PAY-X", "charge", 1000, { date: "2026-11-01 10:00:00" }), pay("PAY-CB", "chargeback", 1000)] })
    const { job, evidence } = syncFromEvents(rawJob({ JobAmountDue: 1000 }), [done])
    expect(evidence.reversed).toHaveLength(1)
    expect(job.payments).toHaveLength(1)
    // Workiz's balance says the customer owes the money again.
    expect(job.fullyPaid).toBe(false)
    expect(gateReason(job, settings)).toBe("Job is not fully paid")
  })
})

describe("reprocessing an affected unpaid payout", () => {
  /** Live #924950 as it was stored before the fix: two "charge" rows the old matcher did not know. */
  const storedBeforeFix = (over: Partial<JobPaymentRow> = {}): JobPaymentRow[] =>
    [
      { id: 1, externalId: "PAY-DEP", amount: "867.84", paidAt: new Date("2026-10-26T10:37:53Z") },
      { id: 2, externalId: "PAY-FIN", amount: "2024.95", paidAt: new Date("2026-11-12T13:36:15Z") },
    ].map((r) => ({
      jobUuid: "REQ1K",
      source: "invoice-webhook",
      method: "charge",
      tipAmount: "0.00",
      paidAtFromPayload: true,
      invoiceId: "IV-1",
      reference: null,
      recordedBy: null,
      raw: { type: "charge", status: "succeeded", [TIP_INCLUSION_RAW_KEY]: "separate" },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...r,
      ...over,
    }))
  const raw = rawJob({ SubTotal: 2892.79, JobTotalPrice: 2892.79, Team: [TEAM.vadim], LineItems: [{ Name: "Shower restoration", Price: 2892.79, Quantity: 1, Type: "service" }] })
  const normalize = (rows: JobPaymentRow[], job = raw) => {
    const evidence = selectPaymentEvidence(rows, keywords)
    return normalizeJob(job, settings, noCatalog, { externalPayments: evidence.payments, reversedPayments: evidence.reversed })
  }

  it("the stored rows are read as card payments; the payment-method hold clears and the fee applies", () => {
    const job = normalize(storedBeforeFix())
    expect(job.warnings.filter((w) => w.startsWith(PAYMENT_METHOD_UNKNOWN_PREFIX))).toEqual([])
    expect(gateReason(job, settings)).toBeNull()
    expect(job.cardServiceAmount).toBe(2892.79)
    const payout = payoutFor(job, planSegments(job, [VADIM], ROSTER), VADIM)
    // Was provisional $723.20 with no fee; is $697.89 with the 3.5% deduction.
    expect(cents(payout.totalPayout)).toBe(697.89)
  })

  it("the hold stays when a different payment on the job is still not recognised", () => {
    const rows = storedBeforeFix()
    rows[1] = { ...rows[1], method: "Other", raw: { type: "Other", status: "succeeded" } }
    const reason = gateReason(normalize(rows), settings)
    expect(reason).toMatch(new RegExp(`^${PAYMENT_METHOD_UNKNOWN_PREFIX}`))
    expect(reason).toContain("Other")
    expect(reason).not.toContain("charge")
  })

  it("the hold stays when another blocking issue remains (an unexplained amount above the services)", () => {
    const surplus = rawJob({ SubTotal: 2892.79, JobTotalPrice: 2992.79, Team: [TEAM.vadim], LineItems: [{ Name: "Shower restoration", Price: 2892.79, Quantity: 1, Type: "service" }] })
    const rows = storedBeforeFix()
    rows[1] = { ...rows[1], amount: "2124.95" }
    expect(gateReason(normalize(rows, surplus), settings)).toMatch(new RegExp(`^${UNITEMIZED_SURPLUS_PREFIX}`))
  })

  it("an unfinished or unpaid job stays where it is", () => {
    expect(gateReason(normalize(storedBeforeFix(), { ...raw, Status: "Submitted" }), settings)).toBe('Job status "Submitted" is not payable')
    expect(gateReason(normalize([storedBeforeFix()[0]], { ...raw, JobAmountDue: 2024.95 }), settings)).toBe("Job is not fully paid")
  })
})

describe("the confirmation form is filled in from what Workiz reported", () => {
  const reported = (method: string, amount: number, over: Partial<NormalizedPayment> = {}): NormalizedPayment => {
    const cls = classifyPaymentMethod(method, keywords)
    return { id: `PAY-${method}-${amount}`, amount, method, methodLabel: cls.label, isCard: cls.isCard, methodKnown: cls.known, isTip: false, date: "2026-11-12T18:36:15.000Z", source: "job-webhook", ...over }
  }

  it.each(["Credit", "Charge", "Credit Charge"])("prefills %j as Credit Card", (label) => {
    const [row] = confirmationSeedRows([], [reported(label, 300)])
    expect(row).toMatchObject({ method: "Credit Card", amount: 300, tip: 0, paidAt: "2026-11-12T18:36:15.000Z" })
  })

  it("keeps Workiz's own word beside the option and leaves an unknown method unselected", () => {
    const rows = confirmationSeedRows([], [reported("charge", 300, { date: "2026-10-26T14:37:53.000Z" }), reported("Other", 700)])
    expect(rows).toEqual([
      { method: "Credit Card", amount: 300, tip: 0, paidAt: "2026-10-26T14:37:53.000Z", workizMethod: "charge" },
      { method: "", amount: 700, tip: 0, paidAt: "2026-11-12T18:36:15.000Z", workizMethod: "Other" },
    ])
  })

  it("shows a tip inside the payment it rode on", () => {
    const rows = confirmationSeedRows([], [reported("charge", 1025.14, { id: "PAY-FIN" }), reported("charge", 153.77, { id: "PAY-FIN:tip", isTip: true })])
    expect(rows).toEqual([{ method: "Credit Card", amount: 1178.91, tip: 153.77, paidAt: "2026-11-12T18:36:15.000Z", workizMethod: "charge" }])
  })

  it("an existing confirmation is shown as saved, including the older `Card` option", () => {
    const saved: NormalizedPayment[] = [{ id: "manual:1", amount: 300, method: "Card", isCard: true, methodKnown: true, isTip: false, date: null, source: "manual", recordedBy: "admin" }]
    expect(confirmationSeedRows(saved, [reported("check", 1000)])).toEqual([{ method: "Credit Card", amount: 300, tip: 0, paidAt: null, workizMethod: null }])
  })

  it("nothing reported and nothing confirmed: no rows, so the form starts blank", () => {
    expect(confirmationSeedRows([], [])).toEqual([])
  })

  it("saving stores Credit Card whichever card word was used, and still rejects a blank or unknown method", () => {
    for (const method of ["Credit Card", "Card", "Charge", "credit charge"]) {
      const checked = validateManualPayments([{ method, amount: 1000, paidAt: null }], 1000)
      expect(checked.ok && checked.entries[0].method).toBe("Credit Card")
    }
    expect(validateManualPayments([{ method: "", amount: 1000, paidAt: null }], 1000).ok).toBe(false)
    expect(validateManualPayments([{ method: "Chargeback", amount: 1000, paidAt: null }], 1000).ok).toBe(false)
  })

  it("is offered only where a person is needed", () => {
    const base = { status: "hold", holdReason: null, hasJob: true }
    // Workiz reported everything and it is all recognised: nothing to confirm.
    expect(paymentConfirmationNeeded({ ...base, holdReason: "Job has unmapped team members (9009)", payments: [reported("charge", 1000)] })).toBe(false)
    expect(paymentConfirmationNeeded({ ...base, status: "ready", payments: [reported("charge", 1000)] })).toBe(false)
    // No records, an unknown method, or a payment-related hold.
    expect(paymentConfirmationNeeded({ ...base, payments: [] })).toBe(true)
    expect(paymentConfirmationNeeded({ ...base, payments: [reported("charge", 300), reported("Other", 700)] })).toBe(true)
    expect(paymentConfirmationNeeded({ ...base, holdReason: `${UNITEMIZED_SURPLUS_PREFIX}: …`, payments: [reported("charge", 1000)] })).toBe(true)
    // An existing confirmation can always be corrected or cleared while the technician is unpaid.
    const confirmed: NormalizedPayment = { id: "manual:1", amount: 1000, method: "Credit Card", isCard: true, methodKnown: true, isTip: false, date: null, source: "manual" }
    expect(paymentConfirmationNeeded({ ...base, status: "ready", payments: [confirmed] })).toBe(true)
    expect(paymentConfirmationNeeded({ ...base, status: "paid", payments: [confirmed] })).toBe(false)
  })
})

describe("Due totals", () => {
  const arthur = [
    { id: 1, amount: 197.9, label: "#1" },
    { id: 2, amount: 100.1, label: "#2" },
  ]
  const vadim = [{ id: 3, amount: 247.38, label: "#3" }]

  it("the page total is the sum of each technician's selected total, in whole cents", () => {
    const all = dueTotals([
      { jobs: arthur, selection: initialSelection(arthur) },
      { jobs: vadim, selection: initialSelection(vadim) },
    ])
    expect(all).toEqual({ selectedTotal: 545.38, selectedCount: 3, dueTotal: 545.38, jobCount: 3 })
  })

  it("unticking a job lowers the selected total at once and leaves the amount due alone; ticking restores it", () => {
    const unticked = setTicked(initialSelection(arthur), arthur[1], false)
    const after = dueTotals([
      { jobs: arthur, selection: unticked },
      { jobs: vadim, selection: initialSelection(vadim) },
    ])
    expect(after).toEqual({ selectedTotal: 445.28, selectedCount: 2, dueTotal: 545.38, jobCount: 3 })
    const back = dueTotals([
      { jobs: arthur, selection: setTicked(unticked, arthur[1], true) },
      { jobs: vadim, selection: initialSelection(vadim) },
    ])
    expect(back.selectedTotal).toBe(545.38)
  })

  it("a paid technician leaves the total; an undone payment brings the jobs back", () => {
    const paid = dueTotals([{ jobs: vadim, selection: initialSelection(vadim) }])
    expect(paid).toEqual({ selectedTotal: 247.38, selectedCount: 1, dueTotal: 247.38, jobCount: 1 })
    const undone = dueTotals([
      { jobs: arthur, selection: initialSelection(arthur) },
      { jobs: vadim, selection: initialSelection(vadim) },
    ])
    expect(undone.selectedTotal).toBe(545.38)
    expect(dueTotals([])).toEqual({ selectedTotal: 0, selectedCount: 0, dueTotal: 0, jobCount: 0 })
  })
})
