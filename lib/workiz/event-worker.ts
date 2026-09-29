import { claimWebhookEvent, finishWebhookAttempt, pendingWebhookEvents, rememberJobIds } from "./events"
import { isWorkizQuotaError, logSyncEvent, syncDocumentWebhook, syncJobByUuid } from "./sync"
import { parseWebhookBody } from "./webhook"

export async function drainWebhookEvents(options: { limit?: number; internalId?: string } = {}) {
  const result = { replayed: 0, resolved: 0, stillUnresolved: 0, failed: 0, quotaHit: false }
  for (let i = 0; i < (options.limit ?? 6); i++) {
    const [pending] = await pendingWebhookEvents(1, options.internalId)
    if (!pending) break
    const event = await claimWebhookEvent(pending.id)
    if (!event) continue
    result.replayed++
    try {
      const parsed = parseWebhookBody(event.payload)
      const via = `${parsed.triggerType ?? "legacy job event"}${parsed.ruleName ? ` · rule "${parsed.ruleName}"` : ""}`
      if (parsed.kind === "ignored" || parsed.kind === "self_test") {
        await finishWebhookAttempt(event, "ignored")
        continue
      }
      if (parsed.kind === "invoice" || parsed.kind === "estimate") {
        const outcome = await syncDocumentWebhook({ parsed, via })
        if (!outcome.resolved) {
          await finishWebhookAttempt(event, "unresolved", { error: outcome.reason })
          result.stillUnresolved++
          continue
        }
        await finishWebhookAttempt(event, "processed", { jobUuid: outcome.result.uuid })
      } else {
        const uuid = parsed.uuidCandidates[0]
        if (!uuid) throw new Error("No verified job UUID in webhook; a document number is not a job number")
        const outcome = await syncJobByUuid(uuid, "webhook", { via })
        await rememberJobIds({ internalId: parsed.jobInternalId, uuid: outcome.uuid, serialId: outcome.normalized.serialId })
        await finishWebhookAttempt(event, "processed", { jobUuid: outcome.uuid })
      }
      result.resolved++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const quota = isWorkizQuotaError(error)
      await finishWebhookAttempt(event, "failed", { error: message, quota })
      await logSyncEvent("webhook:retry", { jobUuid: event.jobUuid, ok: false, summary: message, details: { eventId: event.id, attempt: event.attempts, quota } })
      result.failed++
      if (quota) { result.quotaHit = true; break }
    }
  }
  return result
}
