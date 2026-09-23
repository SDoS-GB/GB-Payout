import { and, asc, desc, eq, inArray, lt } from "drizzle-orm"
import { db } from "@/lib/db"
import { webhookEvents, workizJobIds, type WebhookEventRow } from "@/lib/db/schema"
import type { ParsedWebhook } from "./webhook"

/**
 * Durable record of every Workiz webhook plus the JOB-… ↔ UUID map learned from them.
 *
 * Why both exist: Workiz's estimate webhooks (the only place a deposit paid weeks before the
 * job shows up with its payment type) reference the job only by its internal "JOB-…" id, which
 * the REST API cannot look up. Job and invoice webhooks carry both ids, so every one of them
 * teaches the map; an estimate event that arrives before we know the mapping waits as
 * `unresolved` and is replayed the moment a job/invoice event for the same JOB-… id lands.
 */

export type StoredEvent = { row: WebhookEventRow; duplicate: boolean }

const isUniqueViolation = (err: unknown) => {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code
  return code === "23505"
}

/** Persist the event before anything is done with it. A retry of the same event returns the stored row flagged `duplicate`. */
export async function storeWebhookEvent(parsed: ParsedWebhook, payload: unknown, jobUuid: string | null): Promise<StoredEvent> {
  const values = {
    eventKey: parsed.eventKey,
    triggerType: parsed.triggerType,
    ruleName: parsed.ruleName,
    kind: parsed.kind,
    jobUuid,
    jobInternalId: parsed.jobInternalId,
    serialId: parsed.serialId,
    documentId: parsed.kind === "invoice" || parsed.kind === "estimate" ? parsed.documentId : null,
    payload: (payload ?? null) as object | null,
    status: "received",
  }
  try {
    const [row] = await db.insert(webhookEvents).values(values).returning()
    return { row, duplicate: false }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventKey, parsed.eventKey)).limit(1)
    return { row, duplicate: true }
  }
}

export async function markWebhookEvent(id: number, status: "processed" | "unresolved" | "ignored" | "failed" | "duplicate", patch: { jobUuid?: string | null; error?: string | null } = {}) {
  await db
    .update(webhookEvents)
    .set({
      status,
      processedAt: status === "unresolved" ? null : new Date(),
      error: patch.error ?? null,
      ...(patch.jobUuid !== undefined ? { jobUuid: patch.jobUuid } : {}),
    })
    .where(eq(webhookEvents.id, id))
}

export async function bumpWebhookEventAttempt(id: number) {
  const [row] = await db.select({ attempts: webhookEvents.attempts }).from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1)
  await db
    .update(webhookEvents)
    .set({ attempts: (row?.attempts ?? 0) + 1 })
    .where(eq(webhookEvents.id, id))
}

/** Learn (or refresh) the JOB-… ↔ UUID pair. No-op without both ids. */
export async function rememberJobIds(input: { internalId: string | null | undefined; uuid: string | null | undefined; serialId?: string | number | null }) {
  if (!input.internalId || !input.uuid) return
  const serialId = input.serialId === null || input.serialId === undefined ? null : String(input.serialId)
  await db
    .insert(workizJobIds)
    .values({ internalId: input.internalId, uuid: input.uuid, serialId })
    .onConflictDoUpdate({ target: workizJobIds.internalId, set: { uuid: input.uuid, serialId: serialId ?? undefined, updatedAt: new Date() } })
}

export async function resolveJobUuid(internalId: string | null | undefined): Promise<string | null> {
  if (!internalId) return null
  const [row] = await db.select({ uuid: workizJobIds.uuid }).from(workizJobIds).where(eq(workizJobIds.internalId, internalId)).limit(1)
  return row?.uuid ?? null
}

/** Unresolved document events for one internal job id (oldest first), or for any job when omitted. */
export async function pendingUnresolvedEvents(opts: { internalId?: string; limit?: number; olderThan?: Date } = {}): Promise<WebhookEventRow[]> {
  const conds = [eq(webhookEvents.status, "unresolved")]
  if (opts.internalId) conds.push(eq(webhookEvents.jobInternalId, opts.internalId))
  if (opts.olderThan) conds.push(lt(webhookEvents.receivedAt, opts.olderThan))
  return db
    .select()
    .from(webhookEvents)
    .where(and(...conds))
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(opts.limit ?? 50)
}

export async function recentWebhookEvents(limit = 30): Promise<WebhookEventRow[]> {
  return db.select().from(webhookEvents).orderBy(desc(webhookEvents.receivedAt)).limit(limit)
}

export async function countWebhookEventsByStatus(): Promise<Record<string, number>> {
  const rows = await db.select({ status: webhookEvents.status }).from(webhookEvents).where(inArray(webhookEvents.status, ["unresolved", "failed"]))
  const out: Record<string, number> = {}
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1
  return out
}
