import { NextResponse } from "next/server"
import { getWorkizSettings } from "@/lib/settings"
import { markWebhookEvent, rememberJobIds, storeWebhookEvent } from "@/lib/workiz/events"
import { getWorkizClient, logSyncEvent, replayUnresolvedEvents, syncDocumentWebhook, syncJobByUuid } from "@/lib/workiz/sync"
import { parseRawBody, parseWebhookBody, webhookAuthorized } from "@/lib/workiz/webhook"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * Receiver for the Workiz Automation "post webhook" action.
 *
 * Every authenticated event is written to `webhook_events` FIRST (de-duplicated by Workiz's own
 * trigger type + timestamp + record id), then applied:
 *   - job events        → learn JOB-… ↔ UUID, re-fetch the job through the REST API, replay any
 *                         parked estimate/invoice events for it, run the payout pipeline;
 *   - invoice/estimate  → store `payments[]` (the only Workiz surface with the payment TYPE), then
 *                         the same pipeline; an estimate that names only the JOB-… id is parked
 *                         as `unresolved` until a job/invoice event teaches the mapping;
 *   - lead events       → acknowledged and ignored.
 * The payload is never trusted for amounts: the job is always re-fetched before calculating.
 * Nothing here sends a message: the app records payouts only.
 */
export async function POST(req: Request) {
  const settings = await getWorkizSettings()
  if (!settings.webhookSecret) {
    return NextResponse.json({ ok: false, error: "Webhook secret not configured. Generate one in Admin → Workiz." }, { status: 503, headers: NO_STORE })
  }

  const url = new URL(req.url)
  if (!webhookAuthorized(req.headers, url.searchParams, settings.webhookSecret)) {
    await logSyncEvent("webhook", { ok: false, summary: "Rejected webhook: auth key does not match. Re-copy the key from Admin → Workiz into the automation." })
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: NO_STORE })
  }

  const body = parseRawBody(await req.text())
  const parsed = parseWebhookBody(body, url.searchParams)
  const via = [parsed.triggerType ?? "unknown trigger", parsed.ruleName ? `rule "${parsed.ruleName}"` : null].filter(Boolean).join(" · ")

  const { row: event, duplicate } = await storeWebhookEvent(parsed, body, parsed.uuidCandidates[0] ?? null)
  if (duplicate && event.status !== "unresolved" && event.status !== "failed") {
    // Workiz retried an event we already applied; acknowledge without touching anything.
    return NextResponse.json({ ok: true, duplicate: true, eventId: event.id, status: event.status }, { headers: NO_STORE })
  }

  if (parsed.kind === "ignored") {
    await markWebhookEvent(event.id, "ignored")
    await logSyncEvent("webhook", { ok: true, summary: `Ignored ${via} (lead event)`, details: { trigger: parsed.triggerType, serialId: parsed.serialId, eventId: event.id } })
    return NextResponse.json({ ok: true, ignored: true, trigger: parsed.triggerType }, { headers: NO_STORE })
  }

  if (parsed.kind === "self_test") {
    // Sent by the admin "Test endpoint" button: prove reachability, auth and Workiz API
    // access without touching payouts or pretending Workiz called us.
    try {
      const { client } = await getWorkizClient(settings)
      const job = parsed.uuidCandidates[0] ? await client.getJob(parsed.uuidCandidates[0]) : null
      const summary = job
        ? `Self-test OK: endpoint reachable, auth key accepted, Workiz job #${job.SerialId ?? parsed.uuidCandidates[0]} fetched`
        : `Self-test: endpoint reachable and auth key accepted, but Workiz returned no job for ${parsed.uuidCandidates[0] ?? "(no uuid)"}`
      await markWebhookEvent(event.id, "processed")
      await logSyncEvent("webhook", { jobUuid: parsed.uuidCandidates[0] ?? null, ok: Boolean(job), summary, details: { selfTest: true } })
      return NextResponse.json({ ok: Boolean(job), selfTest: true, summary }, { headers: NO_STORE })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await markWebhookEvent(event.id, "failed", { error })
      await logSyncEvent("webhook", { ok: false, summary: `Self-test failed: ${error}`, details: { selfTest: true } })
      return NextResponse.json({ ok: false, selfTest: true, error }, { status: 502, headers: NO_STORE })
    }
  }

  if (parsed.kind === "invoice" || parsed.kind === "estimate") {
    try {
      const outcome = await syncDocumentWebhook({ parsed, via })
      if (!outcome.resolved) {
        await markWebhookEvent(event.id, "unresolved", { error: outcome.reason })
        await logSyncEvent("webhook", { ok: true, summary: `${parsed.kind === "estimate" ? "Estimate" : "Invoice"} webhook (${via}) parked: ${outcome.reason}`, details: { eventId: event.id, jobInternalId: parsed.jobInternalId, documentId: parsed.documentId, payments: parsed.invoice?.payments.length ?? null } })
        // 202: stored and will be applied later; Workiz must not treat this as a failure to retry.
        return NextResponse.json({ ok: true, parked: true, reason: outcome.reason, eventId: event.id }, { status: 202, headers: NO_STORE })
      }
      await markWebhookEvent(event.id, "processed", { jobUuid: outcome.result.uuid })
      return NextResponse.json(
        {
          ok: true,
          trigger: parsed.triggerType,
          uuid: outcome.result.uuid,
          status: outcome.result.normalized.status,
          payments: { stored: outcome.stored, skipped: outcome.skipped, onJob: outcome.result.normalized.payments.length },
          payouts: outcome.result.engine,
        },
        { headers: NO_STORE },
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await markWebhookEvent(event.id, "failed", { error })
      await logSyncEvent("webhook", {
        jobUuid: parsed.uuidCandidates[0] ?? null,
        ok: false,
        summary: `${parsed.kind === "estimate" ? "Estimate" : "Invoice"} webhook (${via}) failed: ${error}`,
        details: { eventId: event.id, trigger: parsed.triggerType, candidates: parsed.uuidCandidates, jobInternalId: parsed.jobInternalId, documentId: parsed.documentId },
      })
      return NextResponse.json({ ok: false, error }, { status: 502, headers: NO_STORE })
    }
  }

  if (parsed.uuidCandidates.length === 0) {
    await markWebhookEvent(event.id, "failed", { error: "No job UUID in payload" })
    await logSyncEvent("webhook", { ok: false, summary: `Webhook (${via}) had no job UUID`, details: { trigger: parsed.triggerType, serialId: parsed.serialId, eventId: event.id } })
    return NextResponse.json({ ok: false, error: "Missing job UUID" }, { status: 400, headers: NO_STORE })
  }

  // Job events. The uuid is normally data.uuid; later candidates (legacy body keys, ?uuid=) get a turn.
  let lastError: string | null = null
  for (const uuid of parsed.uuidCandidates) {
    try {
      await rememberJobIds({ internalId: parsed.jobInternalId, uuid, serialId: parsed.serialId })
      const replay = parsed.jobInternalId ? await replayUnresolvedEvents({ internalId: parsed.jobInternalId, via: `job event ${via}` }) : null
      const result = await syncJobByUuid(uuid, "webhook", { via })
      await markWebhookEvent(event.id, "processed", { jobUuid: result.uuid })
      return NextResponse.json(
        {
          ok: true,
          trigger: parsed.triggerType,
          uuid: result.uuid,
          status: result.normalized.status,
          payouts: result.engine,
          replayedEvents: replay,
        },
        { headers: NO_STORE },
      )
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (!/not found/i.test(lastError)) break
    }
  }

  await markWebhookEvent(event.id, "failed", { error: lastError })
  await logSyncEvent("webhook", {
    jobUuid: parsed.uuidCandidates[0],
    ok: false,
    summary: `Webhook (${via}) for ${parsed.serialId ? `#${parsed.serialId}` : parsed.uuidCandidates[0]} failed: ${lastError}`,
    details: { eventId: event.id, trigger: parsed.triggerType, candidates: parsed.uuidCandidates, serialId: parsed.serialId, status: parsed.status },
  })
  return NextResponse.json({ ok: false, error: lastError }, { status: 502, headers: NO_STORE })
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Workiz webhook endpoint. Configure Workiz Automations (job, invoice and estimate triggers) to POST here with your Auth key." }, { headers: NO_STORE })
}
