import { NextResponse } from "next/server"
import { safeEqual } from "@/lib/security/crypto"
import { isAdmin } from "@/lib/security/session"
import { logSyncEvent, reconcileRecentJobs } from "@/lib/workiz/sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Scheduled reconciliation (see vercel.json). Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; an admin session can also trigger it
 * from the dashboard for a manual run.
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

  try {
    const summary = await reconcileRecentJobs()
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logSyncEvent("reconcile", { ok: false, summary: `Reconcile failed: ${error}` })
    return NextResponse.json({ ok: false, error }, { status: 502 })
  }
}
