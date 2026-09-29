import { WorkizApiError, type WorkizClient, type WorkizRawJob } from "@/lib/workiz/client"
import { mergePayoutNote } from "@/lib/workiz/payout-note"
import { hasTag } from "@/lib/workiz/tags"

export type OwnerTransport = Pick<WorkizClient, "getJob" | "updateJob">
export type DeliveryOutcome = { accepted: boolean; ambiguous: boolean; retryable: boolean; blocked?: boolean; error: string | null; evidence: Record<string, unknown> }

export function verifyOwnerTrigger(job: WorkizRawJob | null, message: string, tag: string): boolean {
  const description = typeof job?.JobNotes === "string" ? job.JobNotes : ""
  return Boolean(job && Array.isArray(job.Tags) && hasTag(job.Tags.map(String), tag) && (description === message || description.startsWith(`${message}\n\n`)))
}

const accepted = (evidence: Record<string, unknown>): DeliveryOutcome => ({ accepted: true, ambiguous: false, retryable: false, error: null, evidence: { ...evidence, smsDelivery: "unconfirmed", providerMessageId: null } })

export async function deliverOwnerTrigger(input: { client: OwnerTransport; uuid: string; before: WorkizRawJob; tag: string; message: string; verifyBeforeTrigger: (job: WorkizRawJob) => Promise<void> }): Promise<DeliveryOutcome> {
  const { client, uuid, before, tag, message } = input
  if (Array.isArray(before.Tags) && hasTag(before.Tags.map(String), tag)) {
    return { accepted: false, ambiguous: true, retryable: false, error: "Payout tag already exists. No new trigger was attempted; inspect Workiz's automation/message log before any resend.", evidence: { alreadyTagged: true } }
  }
  let triggerStarted = false
  try {
    const description = mergePayoutNote(typeof before.JobNotes === "string" ? before.JobNotes : null, message)
    await client.updateJob(uuid, { JobNotes: description })
    const prepared = await client.getJob(uuid)
    if (!prepared || prepared.JobNotes !== description) throw new Error("Workiz did not retain the owner summary; tag was not added")
    await input.verifyBeforeTrigger(prepared)
    if (Array.isArray(prepared.Tags) && hasTag(prepared.Tags.map(String), tag)) throw new Error("Payout tag appeared during preparation; no new trigger was attempted")
    // Separate calls are intentional: the description must be readable BEFORE the tag-added
    // automation fires. A single update with both fields offers no documented ordering guarantee.
    triggerStarted = true
    const response = await client.updateJob(uuid, { Tags: [tag] })
    const readBack = await client.getJob(uuid)
    if (verifyOwnerTrigger(readBack, message, tag)) return accepted({ response, tagVerified: true, descriptionVerified: true })
    return { accepted: false, ambiguous: true, retryable: false, error: "Workiz update was acknowledged but the tag/summary could not be verified. Delivery is unconfirmed; no automatic resend.", evidence: { response, tagVerified: false } }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Workiz request failed"
    const rejected = error instanceof WorkizApiError && ((error.status >= 400 && error.status < 500) || (error.body && typeof error.body === "object" && (error.body as { flag?: boolean }).flag === false))
    const quota = error instanceof WorkizApiError && error.status === 429
    if (triggerStarted && !rejected) {
      try {
        if (verifyOwnerTrigger(await client.getJob(uuid), message, tag)) return accepted({ reconciledAfterError: true, tagVerified: true, descriptionVerified: true })
      } catch { /* Preserve the ambiguous attempt; another read is scheduled, never another POST. */ }
      return { accepted: false, ambiguous: true, retryable: false, error: `${detail}. Trigger outcome ambiguous; reconcile Workiz before any resend.`, evidence: { triggerStarted, smsDelivery: "unconfirmed" } }
    }
    const transient = quota || (!triggerStarted && (error instanceof TypeError || (error instanceof Error && /timeout|abort/i.test(error.name)) || (error instanceof WorkizApiError && error.status >= 500)))
    return { accepted: false, ambiguous: false, retryable: transient, error: detail, evidence: { triggerStarted, explicitlyRejected: rejected } }
  }
}
