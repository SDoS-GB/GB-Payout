/**
 * Which of a technician's due payouts are ticked for the next PAID click, and how that survives a
 * refresh. Pure: no React, no payout arithmetic beyond adding the stored amounts in cents.
 */

export type DueSelectableJob = {
  /** Stable technician-payout id (one Workiz job can have one per technician). */
  id: number
  /** The stored payout for this technician, already rounded to cents. */
  amount: number
  /** Short label for notices, e.g. "#1234". */
  label: string
}

export type DueSelection = {
  /** Ticked payouts and the amount shown when they were ticked. */
  ticked: ReadonlyMap<number, number>
  /** Payouts the owner deliberately left out; survive refreshes until re-ticked or gone. */
  unticked: ReadonlySet<number>
}

export type ReconcileOutcome = {
  selection: DueSelection
  /** False when nothing about the selection had to move; callers keep the previous object. */
  changed: boolean
  /** Owner-facing summary of what the refresh did to the selection, or null when silent. */
  notice: string | null
}

const AMOUNT_TOLERANCE = 0.005

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** A fresh opening: every eligible payout starts ticked. */
export function initialSelection(jobs: readonly DueSelectableJob[]): DueSelection {
  return { ticked: new Map(jobs.map((j) => [j.id, j.amount])), unticked: new Set() }
}

export function setTicked(prev: DueSelection, job: DueSelectableJob, on: boolean): DueSelection {
  const ticked = new Map(prev.ticked)
  const unticked = new Set(prev.unticked)
  if (on) {
    ticked.set(job.id, job.amount)
    unticked.delete(job.id)
  } else {
    ticked.delete(job.id)
    unticked.add(job.id)
  }
  return { ticked, unticked }
}

export function setAllTicked(jobs: readonly DueSelectableJob[], on: boolean): DueSelection {
  return on ? initialSelection(jobs) : { ticked: new Map(), unticked: new Set(jobs.map((j) => j.id)) }
}

/**
 * Apply a refreshed job list to the selection the owner built:
 * - deliberate unticks stay unticked;
 * - a ticked payout whose amount changed is unticked and named, so the new amount is seen before
 *   it can be paid;
 * - payouts that left Due are dropped;
 * - payouts that newly became due start ticked.
 */
export function reconcileSelection(prev: DueSelection, jobs: readonly DueSelectableJob[], money: (n: number) => string): ReconcileOutcome {
  const ticked = new Map<number, number>()
  const unticked = new Set<number>()
  const changed: string[] = []
  const added: string[] = []
  const present = new Set<number>()

  for (const job of jobs) {
    present.add(job.id)
    if (prev.unticked.has(job.id)) {
      unticked.add(job.id)
      continue
    }
    const before = prev.ticked.get(job.id)
    if (before === undefined) {
      ticked.set(job.id, job.amount)
      added.push(job.label)
    } else if (Math.abs(job.amount - before) > AMOUNT_TOLERANCE) {
      unticked.add(job.id)
      changed.push(`${job.label}: ${money(before)} → ${money(job.amount)}`)
    } else {
      ticked.set(job.id, before)
    }
  }

  let gone = 0
  for (const id of prev.ticked.keys()) if (!present.has(id)) gone++
  let droppedUnticked = 0
  for (const id of prev.unticked) if (!present.has(id)) droppedUnticked++

  const moved = changed.length > 0 || added.length > 0 || gone > 0 || droppedUnticked > 0
  if (!moved) return { selection: prev, changed: false, notice: null }

  const parts: string[] = []
  if (gone > 0) parts.push(`${plural(gone, "ticked job")} ${gone === 1 ? "is" : "are"} no longer due and ${gone === 1 ? "was" : "were"} removed`)
  if (changed.length > 0) parts.push(`amount changed after the refresh (${changed.join(", ")}) — tick again to include`)
  if (added.length > 0) parts.push(`${plural(added.length, "new job")} added and ticked (${added.join(", ")})`)

  return { selection: { ticked, unticked }, changed: true, notice: parts.length ? parts.join(" · ") : null }
}

/** Sum of the current stored amounts of the ticked jobs, added in whole cents. */
export function selectedTotal(selection: DueSelection, jobs: readonly DueSelectableJob[]): number {
  let cents = 0
  for (const job of jobs) if (selection.ticked.has(job.id)) cents += Math.round(job.amount * 100)
  return cents / 100
}

/** The records (any shape carrying the payout id) that are currently ticked, in list order. */
export function selectedJobs<T extends { id: number }>(selection: DueSelection, jobs: readonly T[]): T[] {
  return jobs.filter((j) => selection.ticked.has(j.id))
}
