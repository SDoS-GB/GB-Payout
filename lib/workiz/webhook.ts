import { safeEqual, sha256 } from "@/lib/security/crypto"
import { extractDocumentPayments, type DocumentKind, type InvoiceWebhookPayments } from "./payments"

/**
 * Parsing for the Workiz Automation "post webhook" action.
 *
 * Verified against Workiz's published payload examples (help center article
 * "Creating webhooks in Workiz") and live events received 2026-09-22/23: every event is
 *   { trigger: { type, timestamp }, data: { id, uuid, serialId, status, ... }, metadata: { automationId, ruleName } }
 * `data.uuid` is the same 6-character code the REST API uses for job/get. Workiz has a
 * second, internal job id ("JOB-…"): job events carry it as `data.id`, invoice events as
 * `data.jobId` next to the job's `uuid`, and estimate events carry ONLY `data.jobId`. The
 * REST API cannot resolve a "JOB-…" id, so it is never used for lookups directly; instead
 * every event that shows both ids teaches the mapping (workiz_job_ids) and estimate events
 * are resolved through it. The optional "Auth key" Workiz asks for is sent verbatim as
 * `Authorization: Bearer <key>`.
 *
 * Invoice and estimate events are the only payloads that name the payment type
 * (`data.payments: [{ id, type: "Cash", amount, tipAmount }]`, live: type "Credit charge");
 * the job payload and the REST API never do, so those records are kept, not just used as a hint.
 */

export type WebhookEventKind = "job" | "invoice" | "estimate" | "self_test" | "ignored" | "unknown"

export type ParsedWebhook = {
  triggerType: string | null
  triggerTimestamp: string | null
  ruleName: string | null
  kind: WebhookEventKind
  /** Candidate Workiz job UUIDs, most likely first, already de-duplicated. */
  uuidCandidates: string[]
  /** Workiz internal job id ("JOB-…") when the payload carried one. */
  jobInternalId: string | null
  /** Invoice / estimate id ("IV-…" / "ES-…") for document events; the job's internal id for job events. */
  documentId: string | null
  serialId: string | null
  status: string | null
  /** Payment records from an invoice/estimate event; null when the payload had no `payments` array. */
  invoice: InvoiceWebhookPayments | null
  /** Stable key for de-duplicating Workiz retries of the same event. */
  eventKey: string
}

const SHORT_UUID = /^[A-Za-z0-9]{4,12}$/
const INTERNAL_JOB_ID = /^JOB-[A-Za-z0-9]+$/

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim()
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  return null
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function classifyTrigger(type: string | null): WebhookEventKind {
  if (!type) return "unknown"
  const t = type.toLowerCase()
  if (t === "self_test") return "self_test"
  if (t.startsWith("job")) return "job"
  if (t.startsWith("invoice") || t.startsWith("payment")) return "invoice"
  if (t.startsWith("estimate")) return "estimate"
  if (t.startsWith("lead")) return "ignored"
  return "unknown"
}

/** Accepts the JSON body Workiz posts, the legacy `{UUID}` shape, or a form-encoded fallback. */
export function parseWebhookBody(body: unknown, query?: URLSearchParams): ParsedWebhook {
  const root = record(body) ?? {}
  const trigger = record(root.trigger)
  const data = record(root.data) ?? record(root.job) ?? record(root.Job) ?? record(root.payload)
  const metadata = record(root.metadata)

  const triggerType = str(trigger?.type) ?? str(root.event) ?? str(root.trigger_type) ?? null
  const triggerTimestamp = str(trigger?.timestamp)
  const kind = classifyTrigger(triggerType)

  const candidates = [
    data?.uuid,
    data?.UUID,
    data?.jobUuid,
    data?.job_uuid,
    root.UUID,
    root.uuid,
    root.Uuid,
    root.job_uuid,
    root.jobUuid,
    root.JobUUID,
    query?.get("uuid"),
  ]
    .map(str)
    .filter((v): v is string => v !== null && SHORT_UUID.test(v) && !INTERNAL_JOB_ID.test(v))

  const dataId = str(data?.id)
  const jobIdField = str(data?.jobId) ?? str(data?.job_id) ?? str(data?.jobID)
  const jobInternalId = kind === "job" ? (dataId && INTERNAL_JOB_ID.test(dataId) ? dataId : null) : jobIdField && INTERNAL_JOB_ID.test(jobIdField) ? jobIdField : null
  const documentId = dataId
  const documentKind: DocumentKind | null = kind === "invoice" ? "invoice" : kind === "estimate" ? "estimate" : null

  const parsed: Omit<ParsedWebhook, "eventKey"> = {
    triggerType,
    triggerTimestamp,
    ruleName: str(metadata?.ruleName),
    kind,
    uuidCandidates: Array.from(new Set(candidates)),
    jobInternalId,
    documentId,
    serialId: str(data?.serialId) ?? str(root.SerialId) ?? null,
    status: str(data?.status) ?? str(root.Status) ?? null,
    invoice: documentKind ? extractDocumentPayments(data, triggerTimestamp, documentKind) : null,
  }
  return { ...parsed, eventKey: eventKeyFor(parsed, body) }
}

/**
 * Workiz retries a webhook when the receiver is slow, and two automations can fire on the same
 * change. The key is the trigger type + Workiz's own timestamp + the record id when present;
 * otherwise a hash of the whole body, so a genuinely different payload is never dropped.
 */
export function eventKeyFor(parsed: Pick<ParsedWebhook, "triggerType" | "triggerTimestamp" | "documentId" | "uuidCandidates">, body: unknown): string {
  const recordId = parsed.documentId ?? parsed.uuidCandidates[0] ?? null
  if (parsed.triggerType && parsed.triggerTimestamp && recordId) {
    return sha256(`${parsed.triggerType}|${parsed.triggerTimestamp}|${recordId}`)
  }
  return sha256(`body|${stableStringify(body)}`)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`
}

/**
 * Workiz sends `Authorization: Bearer <auth key>`. If someone pasted "Bearer x"
 * into Workiz's Auth key field the header arrives as "Bearer Bearer x", so the
 * prefix is stripped repeatedly. The header, `x-webhook-secret` and `?secret=`
 * are all accepted; comparison is constant-time.
 */
export function webhookAuthorized(
  headers: { get(name: string): string | null },
  query: URLSearchParams,
  secret: string,
): boolean {
  if (!secret) return false
  let bearer = headers.get("authorization")?.trim() ?? ""
  while (/^bearer\s+/i.test(bearer)) bearer = bearer.replace(/^bearer\s+/i, "").trim()
  return safeEqual(bearer || null, secret) || safeEqual(headers.get("x-webhook-secret"), secret) || safeEqual(query.get("secret"), secret)
}

export function parseRawBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    // Some automation tools post form-encoded bodies.
    return Object.fromEntries(new URLSearchParams(text))
  }
}
