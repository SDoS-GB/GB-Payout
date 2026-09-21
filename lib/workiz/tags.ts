/**
 * Workiz job tags — what the API actually does, verified live on 2026-09-21 (job 7HKYSL):
 *
 *  - `POST job/update/ { UUID, Tags: [...] }` MERGES. Tags already on the job are never
 *    removed, even when the array sent omits them. There is no way to remove a tag via the API.
 *  - A tag name that does not already exist in the account's tag list is silently dropped:
 *    Workiz answers `flag: true, msg: "Job updated"` but the read-back does not contain it.
 *  - There is no endpoint to list, create or delete tags.
 *
 * Consequently the only safe operation is "add a tag that the admin has already created in
 * Workiz", and the tag's presence on the job is the idempotency marker: once a job carries the
 * payout-ready tag we never touch it again, so the Workiz automation fires exactly once per job.
 */

export const DEFAULT_PAYOUT_READY_TAG = "Payout Ready"

export function normalizeTagName(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

export function hasTag(tags: readonly string[], tag: string): boolean {
  const wanted = normalizeTagName(tag).toLowerCase()
  return tags.some((t) => normalizeTagName(String(t)).toLowerCase() === wanted)
}

export type TagSkipReason = "disabled" | "empty-tag" | "no-ready-payout" | "already-tagged"

export type TagPlan = { action: "add"; tag: string; tags: string[] } | { action: "skip"; reason: TagSkipReason }

export function planPayoutReadyTag(input: { enabled: boolean; tag: string; existingTags: readonly string[]; hasReadyPayout: boolean }): TagPlan {
  if (!input.enabled) return { action: "skip", reason: "disabled" }
  const tag = normalizeTagName(input.tag)
  if (!tag) return { action: "skip", reason: "empty-tag" }
  if (!input.hasReadyPayout) return { action: "skip", reason: "no-ready-payout" }
  if (hasTag(input.existingTags, tag)) return { action: "skip", reason: "already-tagged" }
  return { action: "add", tag, tags: [...input.existingTags.map(String), tag] }
}

export type TagVerdict = "applied" | "not-applied"

export function verifyTagApplied(tagsAfterUpdate: readonly string[], tag: string): TagVerdict {
  return hasTag(tagsAfterUpdate, tag) ? "applied" : "not-applied"
}

/** Human explanation for the one failure mode the API hides behind a success response. */
export function explainNotApplied(tag: string): string {
  return `Workiz accepted the update but "${tag}" is not on the job. The tag must already exist in your Workiz account: open any job, click + next to Tags, create "${tag}" exactly, then try again.`
}
