import { eq } from "drizzle-orm"
import { db, type Database } from "@/lib/db"
import { ownerNotifications, payouts, technicianProfiles } from "@/lib/db/schema"
import { gateReason, type EngineResult } from "@/lib/payout/engine"
import type { NotificationSettings, WorkizSettings } from "@/lib/settings"
import type { NormalizedJob } from "@/lib/workiz/normalize"
import { allPayoutsReady, buildOwnerMessage, ownerSnapshotHash } from "./owner-message"
import { OWNER_MAX_ATTEMPTS } from "./owner-status"

export function ownerConfigurationBlocker(settings: NotificationSettings, workiz: WorkizSettings): string | null {
  if (!settings.ownerRecipient?.workizTeamId) return "Owner recipient is not configured; never use the customer or assigned technician"
  if (!settings.ownerRecipient.phoneMasked) return "Owner phone is unavailable from Workiz; confirm the existing recipient and its last four digits in owner settings"
  if (!workiz.apiToken || !workiz.apiSecret) return "Workiz write credentials are missing"
  if (!workiz.payoutReadyTag.trim()) return "Workiz payout tag is missing"
  if (!settings.automationConfirmedAt || !settings.automationRuleName) return "Workiz automation is unverified: confirm immediate tag-added trigger, fixed owner recipient, and Job description message"
  return null
}

export async function materializeOwnerNotification(job: NormalizedJob, engine: EngineResult, workiz: WorkizSettings, settings: NotificationSettings, database: Database = db) {
  const rows = await database.select({ id: payouts.id, profileId: payouts.profileId, name: technicianProfiles.name, status: payouts.status, totalPayout: payouts.totalPayout, inputHash: payouts.inputHash, holdReason: payouts.holdReason })
    .from(payouts).innerJoin(technicianProfiles, eq(payouts.profileId, technicianProfiles.id)).where(eq(payouts.jobUuid, job.uuid))
  const [previous] = await database.select().from(ownerNotifications).where(eq(ownerNotifications.jobUuid, job.uuid)).limit(1)
  const eligibility = gateReason(job, workiz) ?? allPayoutsReady(rows, engine.payoutIds, engine.unmappedTeamIds)
  const message = eligibility ? "" : buildOwnerMessage(job, rows, workiz.businessTimezone)
  const snapshotHash = ownerSnapshotHash(message, rows)
  const config = ownerConfigurationBlocker(settings, workiz)
  let status = "queued"
  let blockReason: string | null = eligibility ?? config
  if (blockReason) status = "blocked"
  else if (!previous?.requestedAt) {
    if (!settings.sendEnabled) { status = "preview_only"; blockReason = "Automatic owner sending is off. A one-job test must be explicitly requested." }
    else if (!settings.verifiedDeliveryAt) { status = "blocked"; blockReason = "An owner-confirmed live test is required before automatic sending" }
    else if (!settings.automaticSince || !job.lastStatusUpdate || job.lastStatusUpdate < new Date(settings.automaticSince)) {
      status = "blocked"; blockReason = "Historical job: automatic backfill texts are suppressed. Use Send payout to owner for this job only."
    }
  }
  const changedRequest = Boolean(previous?.requestedAt && previous.snapshotHash !== snapshotHash)
  if (changedRequest) { status = "blocked"; blockReason = "The explicitly requested payout changed. Review the current message and request this job again." }
  if (previous?.requiresReview) { status = "failed"; blockReason = previous.lastError ?? "Ambiguous delivery needs review; no automatic resend" }
  else if (previous && previous.attempts >= OWNER_MAX_ATTEMPTS && !previous.sentAt) { status = "failed"; blockReason = "Owner send retry limit reached; investigate the last error" }
  else if (previous?.status === "failed" && previous.attempts > 0 && previous.snapshotHash === snapshotHash) { status = "failed"; blockReason = previous.lastError ?? "The provider rejected this attempt; review the error before requesting it again" }
  if (previous && (previous.sentAt || ["sending", "provider_accepted", "delivered"].includes(previous.status))) {
    status = previous.deliveredAt ? "delivered" : previous.sentAt ? "provider_accepted" : previous.status
    blockReason = previous.sentSnapshotHash && previous.sentSnapshotHash !== snapshotHash ? "Payout inputs changed after the Workiz trigger; no second text will be sent automatically" : blockReason
  }
  const preserveDestination = previous && (previous.sentAt || previous.requiresReview || previous.status === "sending")
  const values = {
    jobUuid: job.uuid, status, blockReason, snapshotHash, message,
    requestedAt: changedRequest ? null : previous?.requestedAt ?? null,
    requestedBy: changedRequest ? null : previous?.requestedBy ?? null,
    destinationId: preserveDestination ? previous.destinationId : settings.ownerRecipient?.workizTeamId ?? null,
    destinationLabel: preserveDestination ? previous.destinationLabel : settings.ownerRecipient?.name ?? null,
    destinationMasked: preserveDestination ? previous.destinationMasked : settings.ownerRecipient?.phoneMasked ?? null,
    nextAttemptAt: status === "queued" ? previous?.nextAttemptAt ?? new Date() : status === "sending" || previous?.requiresReview ? previous?.nextAttemptAt ?? null : null,
    updatedAt: new Date(),
  }
  const [row] = await database.insert(ownerNotifications).values(values).onConflictDoUpdate({ target: ownerNotifications.jobUuid, set: values }).returning()
  return row
}
