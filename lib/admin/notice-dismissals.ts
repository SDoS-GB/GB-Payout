import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { adminNoticeDismissals } from "@/lib/db/schema"
import { MAX_NOTICE_KEYS_PER_CLEAR, isValidNoticeKey } from "./notices"

/** Every notice key this account has cleared. Read on each dashboard load so all devices agree. */
export async function listDismissedNoticeKeys(account: string): Promise<Set<string>> {
  const rows = await db.select({ key: adminNoticeDismissals.noticeKey }).from(adminNoticeDismissals).where(eq(adminNoticeDismissals.account, account))
  return new Set(rows.map((r) => r.key))
}

/**
 * Record dismissals for exactly the keys presented to the owner. Unknown or malformed keys are
 * rejected as a whole (nothing is written); keys already dismissed are skipped by the unique
 * index, so a retry or a double tap is harmless. Returns how many were newly recorded.
 */
export async function dismissNoticeKeys(account: string, keys: unknown, by: string): Promise<{ ok: true; recorded: number; requested: number } | { ok: false; error: string }> {
  if (!Array.isArray(keys)) return { ok: false, error: "Nothing to clear" }
  const unique = Array.from(new Set(keys))
  if (unique.length === 0) return { ok: false, error: "Nothing to clear" }
  if (unique.length > MAX_NOTICE_KEYS_PER_CLEAR) return { ok: false, error: `Too many notifications at once (${unique.length}); reload and try again` }
  if (!unique.every(isValidNoticeKey)) return { ok: false, error: "Some notifications could not be identified; reload and try again" }
  const inserted = await db
    .insert(adminNoticeDismissals)
    .values(unique.map((noticeKey) => ({ account, noticeKey, dismissedBy: by })))
    .onConflictDoNothing()
    .returning({ id: adminNoticeDismissals.id })
  return { ok: true, recorded: inserted.length, requested: unique.length }
}
