import { after, NextResponse } from "next/server"
import { getWorkizSettings } from "@/lib/settings"
import { markWebhookEvent, storeWebhookEvent } from "@/lib/workiz/events"
import { drainWebhookEvents } from "@/lib/workiz/event-worker"
import { getWorkizClient, logSyncEvent } from "@/lib/workiz/sync"
import { parseRawBody, parseWebhookBody, webhookAuthorized } from "@/lib/workiz/webhook"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60
const NO_STORE = { "Cache-Control": "no-store" }

export async function POST(req: Request) {
  const settings = await getWorkizSettings()
  if (!settings.webhookSecret) return NextResponse.json({ ok: false, error: "Webhook authentication is not configured" }, { status: 503, headers: NO_STORE })
  const url = new URL(req.url)
  if (!webhookAuthorized(req.headers, url.searchParams, settings.webhookSecret)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: NO_STORE })
  const text = await req.text()
  if (new TextEncoder().encode(text).length > 256_000) return NextResponse.json({ ok: false, error: "Webhook exceeds 256 KB" }, { status: 413, headers: NO_STORE })
  const body = parseRawBody(text)
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "Expected a Workiz event object" }, { status: 400, headers: NO_STORE })
  const parsed = parseWebhookBody(body, url.searchParams)
  const { row: event, duplicate } = await storeWebhookEvent(parsed, body, parsed.uuidCandidates[0] ?? null)
  if (parsed.kind === "self_test") {
    // A self-test proves reachability/auth/API access, not receipt of an event from Workiz.
    try {
      const { client } = await getWorkizClient(settings)
      const job = parsed.uuidCandidates[0] ? await client.getJob(parsed.uuidCandidates[0]) : null
      const summary = job ? `Self-test OK: endpoint and auth work; fetched Workiz job #${job.SerialId}` : "Self-test reached the endpoint but no job was found"
      await markWebhookEvent(event.id, job ? "processed" : "failed")
      await logSyncEvent("webhook", { ok: Boolean(job), summary, details: { selfTest: true } })
      return NextResponse.json({ ok: Boolean(job), selfTest: true, summary }, { headers: NO_STORE })
    } catch (error) {
      await markWebhookEvent(event.id, "failed", { error: error instanceof Error ? error.message : "Workiz unavailable" })
      return NextResponse.json({ ok: false, selfTest: true, error: "Workiz access failed; see the admin event log" }, { status: 502, headers: NO_STORE })
    }
  }
  // Commit receipt before acknowledging. after() is only a latency optimization: the scheduled
  // worker also claims received/failed/abandoned events from Postgres if this process exits.
  if (event.status !== "processed" && event.status !== "ignored") after(async () => { await drainWebhookEvents({ limit: 2 }) })
  return NextResponse.json({ ok: true, stored: true, duplicate, eventId: event.id, status: event.status }, { status: 202, headers: NO_STORE })
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Workiz job/invoice/estimate webhook receiver. POST authenticated events; records are durably queued. A self-test is not a payment or SMS receipt." }, { headers: NO_STORE })
}
