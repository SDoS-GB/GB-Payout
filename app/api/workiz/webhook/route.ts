import { NextResponse } from "next/server"
import { getWorkizSettings } from "@/lib/settings"
import { getWorkizClient, logSyncEvent, syncJobByUuid } from "@/lib/workiz/sync"
import { parseRawBody, parseWebhookBody, webhookAuthorized } from "@/lib/workiz/webhook"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * Receiver for the Workiz Automation "post webhook" action.
 *
 * In Workiz: Automations → Add automation → "this happens": a job trigger (status
 * changed to Done) and, separately, an invoice/payment trigger → "do this": post
 * webhook → URL = this route, Auth key = the secret from Admin → Workiz.
 *
 * The payload is only a hint: the job is always re-fetched through the REST API
 * before anything is calculated, so a spoofed body cannot inject amounts.
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

  const parsed = parseWebhookBody(parseRawBody(await req.text()), url.searchParams)
  const via = [parsed.triggerType ?? "unknown trigger", parsed.ruleName ? `rule "${parsed.ruleName}"` : null].filter(Boolean).join(" · ")

  if (parsed.kind === "ignored") {
    // Lead and estimate events never affect a payout; acknowledge so Workiz does not retry.
    await logSyncEvent("webhook", { ok: true, summary: `Ignored ${via} (not a job or invoice event)`, details: { trigger: parsed.triggerType, serialId: parsed.serialId } })
    return NextResponse.json({ ok: true, ignored: true, trigger: parsed.triggerType }, { headers: NO_STORE })
  }

  if (parsed.uuidCandidates.length === 0) {
    await logSyncEvent("webhook", { ok: false, summary: `Webhook (${via}) had no job UUID`, details: { trigger: parsed.triggerType, serialId: parsed.serialId } })
    return NextResponse.json({ ok: false, error: "Missing job UUID" }, { status: 400, headers: NO_STORE })
  }

  if (parsed.kind === "self_test") {
    // Sent by the admin "Test endpoint" button: prove reachability, auth and Workiz API
    // access without touching payouts or pretending Workiz called us.
    try {
      const { client } = await getWorkizClient(settings)
      const job = await client.getJob(parsed.uuidCandidates[0])
      const summary = job
        ? `Self-test OK: endpoint reachable, auth key accepted, Workiz job #${job.SerialId ?? parsed.uuidCandidates[0]} fetched`
        : `Self-test: endpoint reachable and auth key accepted, but Workiz returned no job for ${parsed.uuidCandidates[0]}`
      await logSyncEvent("webhook", { jobUuid: parsed.uuidCandidates[0], ok: Boolean(job), summary, details: { selfTest: true } })
      return NextResponse.json({ ok: Boolean(job), selfTest: true, summary }, { headers: NO_STORE })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await logSyncEvent("webhook", { ok: false, summary: `Self-test failed: ${error}`, details: { selfTest: true } })
      return NextResponse.json({ ok: false, selfTest: true, error }, { status: 502, headers: NO_STORE })
    }
  }

  // Workiz's invoice example carries the job's uuid, but if an invoice ever has its own
  // code the later candidates (legacy body keys, ?uuid=) get a turn before giving up.
  let lastError: string | null = null
  for (const uuid of parsed.uuidCandidates) {
    try {
      const result = await syncJobByUuid(uuid, "webhook", { via })
      return NextResponse.json(
        {
          ok: true,
          trigger: parsed.triggerType,
          uuid: result.uuid,
          status: result.normalized.status,
          payouts: result.engine,
          notifications: result.notifications.map((n) => ({ payoutId: n.payoutId, status: n.status, reason: n.reason })),
        },
        { headers: NO_STORE },
      )
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (!/not found/i.test(lastError)) break
    }
  }

  await logSyncEvent("webhook", {
    jobUuid: parsed.uuidCandidates[0],
    ok: false,
    summary: `Webhook (${via}) for ${parsed.serialId ? `#${parsed.serialId}` : parsed.uuidCandidates[0]} failed: ${lastError}`,
    details: { trigger: parsed.triggerType, candidates: parsed.uuidCandidates, serialId: parsed.serialId, status: parsed.status },
  })
  return NextResponse.json({ ok: false, error: lastError }, { status: 502, headers: NO_STORE })
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Workiz webhook endpoint. Configure a Workiz Automation to POST here with your Auth key." }, { headers: NO_STORE })
}
