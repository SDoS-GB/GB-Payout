export const OWNER_STATUS_LABELS: Record<string, string> = {
  blocked: "Blocked",
  preview_only: "Preview only",
  queued: "Queued",
  sending: "Sending",
  provider_accepted: "Workiz update accepted — SMS delivery unconfirmed",
  delivered: "Delivered — owner confirmed receipt",
  failed: "Failed",
}

export const OWNER_MAX_ATTEMPTS = 5
export const OWNER_RETRY_MS = 20 * 60_000
export const OWNER_LEASE_MS = 3 * 60_000

export function ownerAttemptDisposition(outcome: { accepted: boolean; ambiguous: boolean; retryable: boolean; blocked?: boolean }, attempts: number) {
  const retry = !outcome.accepted && !outcome.ambiguous && outcome.retryable && attempts < OWNER_MAX_ATTEMPTS
  return {
    status: outcome.accepted ? "provider_accepted" : retry ? "queued" : outcome.blocked ? "blocked" : "failed",
    retry,
    requiresReview: outcome.ambiguous,
    reconcile: outcome.ambiguous,
  }
}
