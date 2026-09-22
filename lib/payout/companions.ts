/**
 * Technicians who work every job alongside another technician without being
 * assigned to it in Workiz. Denis rides with Vadim on every job, but Workiz only
 * lists Vadim, so a plain team lookup would never produce a payout for Denis.
 *
 * A profile whose `worksWithProfileId` points at a technician on the job is added
 * to the job as a regular crew member and paid on the same segment at his own
 * rates - exactly what the calculator does for two techs on one job. Pairing is
 * one level deep: a companion of a companion is not pulled in.
 */
export type CompanionProfile = {
  id: number
  name: string
  active: boolean
  worksWithProfileId: number | null
}

export type CompanionAddition<T extends CompanionProfile> = { companion: T; primary: T }

export type AddCompanionsOptions = {
  /**
   * Technicians whose payout on this job is already paid or void. A companion
   * is not introduced onto a job that was settled before the pairing existed,
   * so old jobs do not sprout new "ready" payouts that were already paid by hand.
   */
  settledPrimaryIds?: ReadonlySet<number>
  /** Technicians who already have a payout row on this job; a companion with a row keeps being maintained. */
  existingPayoutProfileIds?: ReadonlySet<number>
}

export function addCompanions<T extends CompanionProfile>(
  onJob: readonly T[],
  roster: readonly T[],
  opts: AddCompanionsOptions = {},
): { profiles: T[]; added: CompanionAddition<T>[] } {
  const assigned = new Map(onJob.map((p) => [p.id, p]))
  const settled = opts.settledPrimaryIds ?? new Set<number>()
  const existing = opts.existingPayoutProfileIds ?? new Set<number>()

  const profiles = [...onJob]
  const added: CompanionAddition<T>[] = []
  const seen = new Set(onJob.map((p) => p.id))

  for (const candidate of [...roster].sort((a, b) => a.id - b.id)) {
    if (!candidate.active || candidate.worksWithProfileId == null || seen.has(candidate.id)) continue
    const primary = assigned.get(candidate.worksWithProfileId)
    if (!primary) continue
    if (settled.has(primary.id) && !existing.has(candidate.id)) continue
    profiles.push(candidate)
    added.push({ companion: candidate, primary })
    seen.add(candidate.id)
  }

  return { profiles, added }
}

/** "Denis always works with Vadim" for notes and UI. */
export function describeCompanion<T extends CompanionProfile>(addition: CompanionAddition<T>): string {
  return `${addition.companion.name} always works with ${addition.primary.name}`
}
