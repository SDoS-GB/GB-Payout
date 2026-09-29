import { NextResponse } from "next/server"
import { safeEqual } from "@/lib/security/crypto"
import { drainOwnerNotifications } from "@/lib/notifications/owner-worker"
import { drainWebhookEvents } from "@/lib/workiz/event-worker"
import { acquireSyncLease, logSyncEvent, releaseSyncLease } from "@/lib/workiz/sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null
  if (!process.env.CRON_SECRET || !safeEqual(token, process.env.CRON_SECRET)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  const lease = await acquireSyncLease("automation-cron")
  if ("busy" in lease) return NextResponse.json({ ok: true, skipped: true, reason: "Another durable worker holds the lease" })
  try {
    const events = await drainWebhookEvents({ limit: 4 })
    const notifications = await drainOwnerNotifications({ limit: events.quotaHit ? 0 : 1 })
    await logSyncEvent("automation:cron", { ok: events.failed === 0 && !events.quotaHit, summary: `Durable worker: ${events.resolved} events processed, ${notifications.attempted} owner attempts`, details: { events, notifications } })
    return NextResponse.json({ ok: true, events, notifications }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    await logSyncEvent("automation:cron", { ok: false, summary: error instanceof Error ? error.message : "Background automation failed" })
    return NextResponse.json({ ok: false, error: "Automation failed; work remains in the durable queue" }, { status: 503 })
  } finally {
    await releaseSyncLease(lease.token)
  }
}
