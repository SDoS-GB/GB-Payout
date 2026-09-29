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
