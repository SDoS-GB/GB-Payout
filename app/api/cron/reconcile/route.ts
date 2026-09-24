import { NextResponse } from "next/server"
import { safeEqual } from "@/lib/security/crypto"
import { isAdmin } from "@/lib/security/session"
import { isScheduledSyncHour, zonedParts, BUSINESS_TIMEZONE } from "@/lib/workiz/schedule"
import { SyncInProgressError, logSyncEvent, reconcileRecentJobs } from "@/lib/workiz/sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Scheduled reconciliation. vercel.json fires this at 18:00, 19:00, 02:00 and 03:00 UTC — the
 * four UTC hours that can be 2 PM or 10 PM in America/New_York across daylight-saving changes.
 * The gate below keeps the two invocations that land in the right local hour and skips the
 * others, so the business sees exactly two runs a day whatever the offset. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; an admin session can trigger a run at any time.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
  const cronSecret = process.env.CRON_SECRET
  const viaCron = Boolean(cronSecret) && safeEqual(bearer, cronSecret)
  const viaAdmin = !viaCron && (await isAdmin())

  if (!viaCron && !viaAdmin) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date()
  if (viaCron && !isScheduledSyncHour(now)) {
    const local = zonedParts(now)
    return NextResponse.json({ ok: true, skipped: true, reason: `Not a scheduled hour in ${BUSINESS_TIMEZONE} (local ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")})` })
  }

  try {
    const summary = await reconcileRecentJobs({ trigger: viaCron ? "cron" : "admin" })
    return NextResponse.json({ ok: summary.complete, ...summary })
  } catch (err) {
    if (err instanceof SyncInProgressError) {
      return NextResponse.json({ ok: false, busy: true, error: err.message }, { status: 409 })
    }
    const error = err instanceof Error ? err.message : String(err)
    await logSyncEvent("reconcile", { ok: false, summary: `INCOMPLETE sync (${viaCron ? "cron" : "admin"}): ${error}` })
    return NextResponse.json({ ok: false, error }, { status: 502 })
  }
}
