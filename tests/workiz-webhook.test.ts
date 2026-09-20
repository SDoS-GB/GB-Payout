import { describe, expect, it } from "vitest"
import { classifyTrigger, parseRawBody, parseWebhookBody, webhookAuthorized } from "@/lib/workiz/webhook"

const SECRET = "k3y_abcDEF123456"
const headersOf = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })

/** Trimmed copy of the job payload in Workiz's "Creating webhooks in Workiz" article. */
const workizJobEvent = {
  trigger: { type: "job_status_changed", timestamp: "2026-09-19T10:30:00Z" },
  data: {
    id: "JOB-BA5r7o4bqzR9MONa",
    uuid: "3YBIBO",
    serialId: 12345,
    status: "Done",
    subStatus: "",
    subTotal: 946,
    totalPrice: 956.51,
    amountDue: 0,
    team: [{ id: "USR-38c1ee5c4efa38a4", name: "John Doe" }],
    lineItems: [{ id: "JLI-1", name: "Deadbolt", price: 100, quantity: 1, total: 100 }],
  },
  metadata: { automationId: "auto_789", ruleName: "Payout sync" },
}

const workizInvoiceEvent = {
  trigger: { type: "invoice_paid", timestamp: "2026-09-19T10:30:00Z" },
  data: { id: "IV-bK9r2XyZL54aWDR0", uuid: "3YBIBO", serialId: "56", jobId: "JOB-BA5r7o4bqzR9MONa", amountDue: 0 },
  metadata: { automationId: "auto_790", ruleName: "Invoice paid" },
}

describe("Workiz webhook payload parsing", () => {
  it("reads the job uuid, serial, status and rule from a documented job event", () => {
    const p = parseWebhookBody(workizJobEvent)
    expect(p.kind).toBe("job")
    expect(p.triggerType).toBe("job_status_changed")
    expect(p.ruleName).toBe("Payout sync")
    expect(p.uuidCandidates).toEqual(["3YBIBO"])
    expect(p.serialId).toBe("12345")
    expect(p.status).toBe("Done")
  })

  it("treats invoice/payment events as job lookups by data.uuid and never uses JOB-… ids", () => {
    const p = parseWebhookBody(workizInvoiceEvent)
    expect(p.kind).toBe("invoice")
    expect(p.uuidCandidates).toEqual(["3YBIBO"])
    expect(p.uuidCandidates.some((c) => c.startsWith("JOB-") || c.startsWith("IV-"))).toBe(false)
  })

  it("ignores lead and estimate events", () => {
    expect(parseWebhookBody({ trigger: { type: "lead_created" }, data: { uuid: "GD87TS" } }).kind).toBe("ignored")
    expect(parseWebhookBody({ trigger: { type: "estimate_created" }, data: { id: "ES-1" } }).kind).toBe("ignored")
    expect(classifyTrigger("payment_received")).toBe("invoice")
    expect(classifyTrigger(null)).toBe("unknown")
  })

  it("still accepts the legacy flat body and a ?uuid= query", () => {
    expect(parseWebhookBody({ UUID: "DBOE3J" }).uuidCandidates).toEqual(["DBOE3J"])
    expect(parseWebhookBody(null, new URLSearchParams("uuid=XJNP6U")).uuidCandidates).toEqual(["XJNP6U"])
    expect(parseWebhookBody({ data: { uuid: "AAAAAA" }, UUID: "AAAAAA" }).uuidCandidates).toEqual(["AAAAAA"])
  })

  it("rejects values that cannot be a Workiz short uuid", () => {
    const p = parseWebhookBody({ data: { uuid: "JOB-BA5r7o4bqzR9MONa" }, UUID: "<script>" })
    expect(p.uuidCandidates).toEqual([])
  })

  it("falls back to form-encoded bodies", () => {
    expect(parseRawBody("UUID=U07NG3&Status=Done")).toEqual({ UUID: "U07NG3", Status: "Done" })
    expect(parseRawBody("")).toBeNull()
  })
})

describe("Workiz webhook authorization", () => {
  const q = new URLSearchParams()

  it("accepts the Bearer header exactly as Workiz sends it", () => {
    expect(webhookAuthorized(headersOf({ authorization: `Bearer ${SECRET}` }), q, SECRET)).toBe(true)
  })

  it("tolerates a pasted 'Bearer <key>' that Workiz prefixed again", () => {
    expect(webhookAuthorized(headersOf({ authorization: `Bearer Bearer ${SECRET}` }), q, SECRET)).toBe(true)
  })

  it("accepts the header and query fallbacks", () => {
    expect(webhookAuthorized(headersOf({ "x-webhook-secret": SECRET }), q, SECRET)).toBe(true)
    expect(webhookAuthorized(headersOf({}), new URLSearchParams({ secret: SECRET }), SECRET)).toBe(true)
  })

  it("rejects wrong, empty or missing keys and never matches an empty configured secret", () => {
    expect(webhookAuthorized(headersOf({ authorization: "Bearer nope" }), q, SECRET)).toBe(false)
    expect(webhookAuthorized(headersOf({ authorization: "Bearer " }), q, SECRET)).toBe(false)
    expect(webhookAuthorized(headersOf({}), q, SECRET)).toBe(false)
    expect(webhookAuthorized(headersOf({ authorization: "Bearer " }), q, "")).toBe(false)
  })
})
