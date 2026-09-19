import type { NormalizedLineItem } from "@/lib/db/schema"

/**
 * Splits one Workiz job into the commission bases each technician is paid on.
 *
 * A job can carry work for the regular crew and, on the same invoice, separate
 * work performed by a "dedicated" technician (Tim). Line items that contain that
 * technician's literal marker (e.g. `*T*`) belong exclusively to him; everything
 * else is crew work. Each line item lands in exactly one segment and the
 * segments always add back up to the job's post-discount service total, so no
 * dollar is ever counted in two commission bases.
 *
 * Pure: no I/O, no rounding beyond the 2-decimal money inputs the calculator has
 * always been fed. Rate arithmetic happens later in `calculator.ts`.
 */

export type SegmentKind = "job" | "dedicated" | "crew"
export type MarkerField = "name" | "description"

/** The subset of a NormalizedJob the segmenter reads. */
export type SegmentableJob = {
  jobTotal: number
  colorSealTotal: number
  discountAmount: number
  cardServiceAmount: number
  nonCardServiceAmount: number
  cardTipAmount: number
  nonCardTipAmount: number
  lineItems: NormalizedLineItem[]
}

export type JobSegment = {
  kind: SegmentKind
  /** The marker that selected this segment's items; null for crew / whole-job. */
  marker: string | null
  /** Indexes into job.lineItems. Disjoint across segments. */
  itemIndexes: number[]
  itemNames: string[]
  /** Which Workiz field(s) the marker was found in, for verification. */
  markerFields: MarkerField[]
  /** Sum of this segment's positive line items before any discount. */
  grossAmount: number
  /** Negative line items that carry the marker: discounts specific to this segment. */
  itemDiscountAmount: number
  /** This segment's proportional share of whole-job discounts. */
  allocatedDiscountAmount: number
  /** Fraction of the job's service total this segment represents. */
  share: number
  jobTotal: number
  colorSealTotal: number
  cardServiceAmount: number
  nonCardServiceAmount: number
  cardTipAmount: number
  nonCardTipAmount: number
}

export type SegmentationVerification = {
  itemCount: number
  assignedItemCount: number
  doubleCountedItems: number
  segmentsTotal: number
  jobTotal: number
  balanced: boolean
}

export type Segmentation = {
  segments: JobSegment[]
  warnings: string[]
  verification: SegmentationVerification
}

const round2 = (n: number) => Math.round(n * 100) / 100
const BALANCE_TOLERANCE = 0.011

/**
 * Literal, case-sensitive containment test. `*T*` matches the three characters
 * asterisk-T-asterisk; it is never treated as a wildcard.
 */
export function findMarker(item: Pick<NormalizedLineItem, "name" | "description">, marker: string): MarkerField | null {
  const m = marker.trim()
  if (!m) return null
  if (item.name.includes(m)) return "name"
  if (item.description && item.description.includes(m)) return "description"
  return null
}

export function itemsWithMarker(items: NormalizedLineItem[], marker: string): NormalizedLineItem[] {
  return items.filter((i) => findMarker(i, marker) !== null)
}

function verify(job: SegmentableJob, segments: JobSegment[]): SegmentationVerification {
  const all = segments.flatMap((s) => s.itemIndexes)
  const unique = new Set(all)
  const segmentsTotal = round2(segments.reduce((s, seg) => s + seg.jobTotal, 0))
  return {
    itemCount: job.lineItems.length,
    assignedItemCount: unique.size,
    doubleCountedItems: all.length - unique.size,
    segmentsTotal,
    jobTotal: job.jobTotal,
    balanced: all.length === unique.size && unique.size === job.lineItems.length && Math.abs(segmentsTotal - job.jobTotal) < BALANCE_TOLERANCE,
  }
}

/** The whole job as a single segment: what every payout used before markers existed. */
export function wholeJobSegment(job: SegmentableJob): JobSegment {
  return {
    kind: "job",
    marker: null,
    itemIndexes: job.lineItems.map((_, i) => i),
    itemNames: job.lineItems.map((i) => i.name),
    markerFields: [],
    grossAmount: round2(job.lineItems.filter((i) => i.total > 0).reduce((s, i) => s + i.total, 0)),
    itemDiscountAmount: 0,
    allocatedDiscountAmount: job.discountAmount,
    share: 1,
    jobTotal: job.jobTotal,
    colorSealTotal: job.colorSealTotal,
    cardServiceAmount: job.cardServiceAmount,
    nonCardServiceAmount: job.nonCardServiceAmount,
    cardTipAmount: job.cardTipAmount,
    nonCardTipAmount: job.nonCardTipAmount,
  }
}

type Bucket = {
  kind: SegmentKind
  marker: string | null
  indexes: number[]
  fields: MarkerField[]
  positive: number
  negative: number
  colorGross: number
}

const newBucket = (kind: SegmentKind, marker: string | null): Bucket => ({ kind, marker, indexes: [], fields: [], positive: 0, negative: 0, colorGross: 0 })

/**
 * Split a job into one "dedicated" segment per marker plus one "crew" segment.
 *
 * Discount rules:
 * - A negative line item that carries a marker is a discount specific to that
 *   technician's work and stays inside his segment.
 * - The Workiz job-level Discount and any unmarked negative line items are
 *   whole-job discounts. They are allocated proportionally to each segment's
 *   pre-discount base so every segment ends up "after discounts", exactly as the
 *   job total itself is.
 * - Card-paid service dollars are allocated by the same proportion, so the 3.5%
 *   card fee is only ever applied to each segment's card-paid share.
 * - Tips go to the crew segment only. A dedicated technician is not in the tip
 *   split.
 *
 * With no markers the result is the unchanged whole job.
 */
export function segmentJob(job: SegmentableJob, markers: string[]): Segmentation {
  const uniqueMarkers = Array.from(new Set(markers.map((m) => m.trim()).filter(Boolean)))
  const warnings: string[] = []

  if (uniqueMarkers.length === 0) {
    const whole = wholeJobSegment(job)
    return { segments: [whole], warnings, verification: verify(job, [whole]) }
  }

  const dedicated = new Map<string, Bucket>(uniqueMarkers.map((m) => [m, newBucket("dedicated", m)]))
  const crew = newBucket("crew", null)

  job.lineItems.forEach((item, index) => {
    const hits = uniqueMarkers.map((m) => ({ marker: m, field: findMarker(item, m) })).filter((h): h is { marker: string; field: MarkerField } => h.field !== null)
    if (hits.length > 1) {
      warnings.push(`Line item "${item.name}" carries more than one technician marker (${hits.map((h) => h.marker).join(", ")}); assigned to ${hits[0].marker}`)
    }
    const bucket = hits.length ? (dedicated.get(hits[0].marker) as Bucket) : crew
    bucket.indexes.push(index)
    if (hits.length) bucket.fields.push(hits[0].field)
    if (item.total > 0) {
      bucket.positive += item.total
      if (item.isColorSeal) bucket.colorGross += item.total
    } else if (item.total < 0) {
      bucket.negative += Math.abs(item.total)
    }
  })

  // Pre-allocation base per segment. Dedicated segments net out their own marked
  // discount lines; the crew base is gross because unmarked negatives are whole-job.
  const baseOf = (b: Bucket) => (b.kind === "dedicated" ? Math.max(0, round2(b.positive - b.negative)) : round2(b.positive))
  const pool = round2([...dedicated.values(), crew].reduce((s, b) => s + baseOf(b), 0))
  const ratio = pool > 0 ? Math.min(1, job.jobTotal / pool) : 0

  if (pool > 0 && job.jobTotal - pool > 0.05) {
    warnings.push(`Line items total ${pool.toFixed(2)} is less than the job total ${job.jobTotal.toFixed(2)}; the unexplained ${(job.jobTotal - pool).toFixed(2)} is credited to crew work`)
  }

  const segments: JobSegment[] = []
  let dedicatedNet = 0
  let dedicatedCard = 0

  for (const marker of uniqueMarkers) {
    const b = dedicated.get(marker) as Bucket
    const base = baseOf(b)
    const net = Math.min(job.jobTotal, round2(base * ratio))
    const share = job.jobTotal > 0 ? net / job.jobTotal : 0
    const card = Math.min(net, round2(job.cardServiceAmount * share))
    dedicatedNet = round2(dedicatedNet + net)
    dedicatedCard = round2(dedicatedCard + card)
    segments.push({
      kind: "dedicated",
      marker,
      itemIndexes: b.indexes,
      itemNames: b.indexes.map((i) => job.lineItems[i].name),
      markerFields: Array.from(new Set(b.fields)),
      grossAmount: round2(b.positive),
      itemDiscountAmount: round2(b.negative),
      allocatedDiscountAmount: round2(Math.max(0, base - net)),
      share,
      jobTotal: net,
      colorSealTotal: Math.min(net, round2(b.colorGross * ratio)),
      cardServiceAmount: card,
      nonCardServiceAmount: round2(net - card),
      cardTipAmount: 0,
      nonCardTipAmount: 0,
    })
  }

  // The crew takes the remainder so the segments always sum to the job total exactly.
  const crewNet = round2(Math.max(0, job.jobTotal - dedicatedNet))
  const crewCard = Math.min(crewNet, round2(Math.max(0, job.cardServiceAmount - dedicatedCard)))
  segments.push({
    kind: "crew",
    marker: null,
    itemIndexes: crew.indexes,
    itemNames: crew.indexes.map((i) => job.lineItems[i].name),
    markerFields: [],
    grossAmount: round2(crew.positive),
    itemDiscountAmount: 0,
    allocatedDiscountAmount: round2(Math.max(0, crew.positive - crewNet)),
    share: job.jobTotal > 0 ? crewNet / job.jobTotal : 0,
    jobTotal: crewNet,
    colorSealTotal: Math.min(crewNet, round2(crew.colorGross * ratio)),
    cardServiceAmount: crewCard,
    nonCardServiceAmount: round2(crewNet - crewCard),
    cardTipAmount: job.cardTipAmount,
    nonCardTipAmount: job.nonCardTipAmount,
  })

  const verification = verify(job, segments)
  if (!verification.balanced) {
    warnings.push(
      `Segment check failed: ${verification.assignedItemCount}/${verification.itemCount} items assigned, ${verification.doubleCountedItems} double-counted, segments total ${verification.segmentsTotal.toFixed(2)} vs job ${verification.jobTotal.toFixed(2)}`,
    )
  }

  return { segments, warnings, verification }
}

/** The profile fields the planner needs; a full TechnicianProfile satisfies this. */
export type PlannableProfile = { id: number; name: string; lineItemMarker: string | null }
export type MarkerOwner = PlannableProfile

export type SegmentPlan = {
  segmentation: Segmentation
  /** Which commission base each mapped profile is paid on. */
  segmentFor: Map<number, JobSegment>
  /** How many technicians share that base (informational, stored as split_count). */
  splitCountFor: Map<number, number>
  /** Assignment problems that must hold every payout on the job for review. */
  warnings: string[]
}

const markerOf = (p: PlannableProfile) => p.lineItemMarker?.trim() || null

/**
 * Decide who is paid on what.
 *
 * - Regular crew + a marked technician on the same job: the marked technician is
 *   paid on his marked items only, the crew on everything else (and all tips).
 * - A technician working alone, or a crew with nobody marked: the whole job, as
 *   the calculator has always done.
 *
 * `markerOwners` is every active profile that has a marker, so items marked for
 * someone who is not assigned to the job can be flagged.
 */
export function planSegments<P extends PlannableProfile>(job: SegmentableJob, onJob: P[], markerOwners: MarkerOwner[]): SegmentPlan {
  const warnings: string[] = []
  const dedicated = onJob.filter((p) => markerOf(p))
  const crew = onJob.filter((p) => !markerOf(p))

  const ownersByMarker = new Map<string, string[]>()
  for (const p of dedicated) {
    const m = markerOf(p) as string
    ownersByMarker.set(m, [...(ownersByMarker.get(m) ?? []), p.name])
  }
  for (const [m, names] of ownersByMarker) {
    if (names.length > 1) warnings.push(`Marker ${m} is assigned to more than one technician on this job (${names.join(", ")})`)
  }

  const onJobIds = new Set(onJob.map((p) => p.id))
  for (const owner of markerOwners) {
    const m = markerOf(owner)
    if (!m || onJobIds.has(owner.id)) continue
    const hits = itemsWithMarker(job.lineItems, m)
    if (hits.length) {
      warnings.push(`${hits.length} line item${hits.length === 1 ? "" : "s"} carry ${m} but ${owner.name} is not assigned to this job: ${hits.map((i) => i.name).join(", ")}`)
    }
  }

  const segmentFor = new Map<number, JobSegment>()
  const splitCountFor = new Map<number, number>()

  if (dedicated.length === 0 || crew.length === 0) {
    const segmentation = segmentJob(job, [])
    for (const p of onJob) {
      segmentFor.set(p.id, segmentation.segments[0])
      splitCountFor.set(p.id, onJob.length)
    }
    return { segmentation, segmentFor, splitCountFor, warnings }
  }

  const segmentation = segmentJob(job, dedicated.map((p) => markerOf(p) as string))
  warnings.push(...segmentation.warnings)
  const crewSegment = segmentation.segments.find((s) => s.kind === "crew") as JobSegment

  for (const p of dedicated) {
    const m = markerOf(p) as string
    const seg = segmentation.segments.find((s) => s.kind === "dedicated" && s.marker === m) as JobSegment
    if (seg.itemIndexes.length === 0) warnings.push(`${p.name} is assigned to this job but no line items carry ${m}`)
    segmentFor.set(p.id, seg)
    splitCountFor.set(p.id, ownersByMarker.get(m)?.length ?? 1)
  }
  for (const p of crew) {
    segmentFor.set(p.id, crewSegment)
    splitCountFor.set(p.id, crew.length)
  }
  if (crewSegment.itemIndexes.length === 0) {
    warnings.push(`Every line item is marked for a dedicated technician; ${crew.map((p) => p.name).join(", ")} would be paid nothing`)
  }

  return { segmentation, segmentFor, splitCountFor, warnings }
}

/** Short human label for a payout's commission base. */
export function segmentLabel(kind: string | null | undefined, marker: string | null | undefined): string | null {
  if (kind === "dedicated") return `${marker ?? "Marked"} work only`
  if (kind === "crew") return marker ? `Crew work (excl. ${marker})` : "Crew work"
  return null
}
