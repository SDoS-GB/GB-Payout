import { NextResponse } from "next/server"
import { safeEqual } from "@/lib/security/crypto"
import { getWorkizSettings } from "@/lib/settings"
import { logSyncEvent, syncJobByUuid } from "@/lib/workiz/sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Receiver for a Workiz Automation "Send webhook" action.
 *
 * Configure the automation in Workiz as:
 *   Trigger:  Job status changed (to your payable status, e.g. "Done")
 *   Action:   Webhook → POST https://<your-domain>/api/workiz/webhook
 *   Header:   Authorization: Bearer <webhook secret from Admin → Workiz settings>
 *   Body:     JSON including the job UUID, e.g. {"UUID":"{{job.uuid}}"}
 *
 * The payload is treated only as a hint: we always refetch the job through
 * the REST API before calculating anything, so a spoofed body cannot inject
 * amounts. Authentication is a shared secret compared in constant time.
 */
export async function POST(req: Request) {
  const settings = await getWorkizSettings()
  if (!settings.webhookSecret) {
    return NextResponse.json({ ok: false, error: "Webhook secret not configured" }, { status: 503 })
  }

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
  const headerSecret = req.headers.get("x-webhook-secret")
  const url = new URL(req.url)
  const querySecret = url.searchParams.get("secret")

  if (!safeEqual(bearer, settings.webhookSecret) && !safeEqual(headerSecret, settings.webhookSecret) && !safeEqual(querySecret, settings.webhookSecret)) {
    await logSyncEvent("webhook", { ok: false, summary: "Rejected webhook: bad secret" })
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown = null
  const text = await req.text()
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // Some automations post form-encoded bodies.
    body = Object.fromEntries(new URLSearchParams(text))
  }

  const uuid = extractUuid(body) ?? url.searchParams.get("uuid")
  if (!uuid) {
    await logSyncEvent("webhook", { ok: false, summary: "Webhook without job UUID", details: { keys: body && typeof body === "object" ? Object.keys(body as object) : typeof body } })
    return NextResponse.json({ ok: false, error: "Missing job UUID" }, { status: 400 })
  }

  try {
    const result = await syncJobByUuid(uuid, "webhook")
    return NextResponse.json({
      ok: true,
      uuid: result.uuid,
      status: result.normalized.status,
      payouts: result.engine,
      notifications: result.notifications.map((n) => ({ payoutId: n.payoutId, status: n.status, reason: n.reason })),
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logSyncEvent("webhook", { jobUuid: uuid, ok: false, summary: `Webhook processing failed: ${error}` })
    return NextResponse.json({ ok: false, error }, { status: 502 })
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Workiz webhook endpoint. POST with Authorization: Bearer <secret>." })
}

function extractUuid(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const direct = b.UUID ?? b.uuid ?? b.Uuid ?? b.job_uuid ?? b.jobUuid ?? b.JobUUID
  if (typeof direct === "string" && direct.length > 0) return direct
  for (const nested of [b.job, b.Job, b.data, b.Data, b.payload]) {
    const found = extractUuid(nested)
    if (found) return found
  }
  return null
}
