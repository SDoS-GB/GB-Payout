import { safeEqual } from "@/lib/security/crypto"

/**
 * Parsing for the Workiz Automation "post webhook" action.
 *
 * Verified against Workiz's published payload examples (help center article
 * "Creating webhooks in Workiz", updated 2026-02): every event is
 *   { trigger: { type, timestamp }, data: { id, uuid, serialId, status, ... }, metadata: { automationId, ruleName } }
 * `data.uuid` is the same 6-character code the REST API uses for job/get, and
 * Workiz's invoice example carries the job's uuid. `data.id` ("JOB-…") and
 * `data.jobId` are internal ids the REST API cannot resolve, so they are never
 * used for lookups. The optional "Auth key" Workiz asks for is sent verbatim as
 * `Authorization: Bearer <key>`.
 */

export type WebhookEventKind = "job" | "invoice" | "self_test" | "ignored" | "unknown"

export type ParsedWebhook = {
  triggerType: string | null
  ruleName: string | null
  kind: WebhookEventKind
  /** Candidate Workiz job UUIDs, most likely first, already de-duplicated. */
  uuidCandidates: string[]
  serialId: string | null
  status: string | null
}

const SHORT_UUID = /^[A-Za-z0-9]{4,12}$/

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
  if (t.startsWith("lead") || t.startsWith("estimate")) return "ignored"
  return "unknown"
}

/** Accepts the JSON body Workiz posts, the legacy `{UUID}` shape, or a form-encoded fallback. */
export function parseWebhookBody(body: unknown, query?: URLSearchParams): ParsedWebhook {
  const root = record(body) ?? {}
  const trigger = record(root.trigger)
  const data = record(root.data) ?? record(root.job) ?? record(root.Job) ?? record(root.payload)
  const metadata = record(root.metadata)

  const triggerType = str(trigger?.type) ?? str(root.event) ?? str(root.trigger_type) ?? null
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
    .filter((v): v is string => v !== null && SHORT_UUID.test(v))

  return {
    triggerType,
    ruleName: str(metadata?.ruleName),
    kind,
    uuidCandidates: Array.from(new Set(candidates)),
    serialId: str(data?.serialId) ?? str(root.SerialId) ?? null,
    status: str(data?.status) ?? str(root.Status) ?? null,
  }
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
