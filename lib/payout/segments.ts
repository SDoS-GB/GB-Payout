import type { NormalizedLineItem } from "@/lib/db/schema"

/**
 * Decides who owns which service dollars on one Workiz job, in this order:
 *
 *  A. Work Type ("Tim's Job"): the whole discounted service subtotal belongs to
 *     the technician whose profile owns that Work Type, color sealing included.
 *     The regular crew earns no service commission on it, markers or not.
 *  B. Marked items: a line item whose Name carries the literal asterisk-delimited
 *     marker (`*T*`, `* T *`) belongs exclusively to the technician with that
 *     marker. An ordinary T, the name Tim, or a word starting with T never counts.
 *  C. Everything else is regular crew work, paid to every regular technician on
 *     the job at their own rates (amounts are never divided by head count).
 *
 * Tips are separate: the business-held tip is split equally among the regular
 * technicians on the job; a dedicated technician (marker or Work Type owner)
 * never shares it, and a tip with no regular technician to receive it is flagged.
 *
 * Every line item lands in exactly one segment and the segments always add back
 * up to the job's post-discount service total. Pure: no I/O, no rounding beyond
 * the 2-decimal money inputs the calculator has always been fed.
 */

export type SegmentKind = "job" | "dedicated" | "crew"
export type MarkerField = "name"
/** Why a segment belongs to whoever is paid on it. */
export type OwnershipReason = "crew" | "marker" | "work-type"

/** The subset of a NormalizedJob the planner reads. */
export type SegmentableJob = {
  /** Workiz `JobType` (shown as "Work Type" / "Job type" in Workiz). */
  jobType?: string | null
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
  ownership: OwnershipReason
  /** The Work Type that selected this segment; null unless ownership is "work-type". */
  workType: string | null
  /** The marker that selected this segment's items; null for crew / whole-job. */
  marker: string | null
  /** Indexes into job.lineItems. Disjoint across segments. */
  itemIndexes: number[]
  itemNames: string[]
  /** Which Workiz field the marker was found in, for verification. */
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

// --- Marker tokens -----------------------------------------------------------

/**
 * A profile's marker is a short token (`T`). A Workiz line item belongs to that
 * technician only when its Name carries the literal asterisk-delimited token,
 * `*T*` or `* T *` (whitespace inside the asterisks allowed, case-insensitive).
 * A bare `T`, `(T)`, `T:` or a word that merely starts with T never counts.
 * Decoration typed into the profile field is ignored: `*T*` and `T` configure
 * the same token. Several tokens may be listed (`T, Tim`) but the confirmed
 * house rule uses a single `T`.
 */
export function parseMarkerTokens(marker: string | null | undefined): string[] {
  if (!marker) return []
  const tokens = marker
    .split(/[,;/|]+/)
    .map((t) => t.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean)
  return Array.from(new Set(tokens.map((t) => t.toLowerCase()))).map((lower) => tokens.find((t) => t.toLowerCase() === lower) as string)
}

/** Canonical stored form of a marker field: tokens joined as `T, Tim`. */
export function normalizeMarkerTokens(marker: string | null | undefined): string | null {
  const tokens = parseMarkerTokens(marker)
  return tokens.length ? tokens.join(", ") : null
}

/** How a marker is shown to people: its first token in the `*T*` house style. */
export function markerLabel(marker: string | null | undefined): string | null {
  const [first] = parseMarkerTokens(marker)
  return first ? `*${first}*` : null
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const patternCache = new Map<string, RegExp>()

/** The literal delimited marker: an asterisk, optional spaces, the token, optional spaces, an asterisk. */
function patternFor(token: string): RegExp {
  const key = token.toLowerCase()
  let p = patternCache.get(key)
  if (!p) {
    p = new RegExp(`\\*\\s*${escapeRegExp(token)}\\s*\\*`, "i")
    patternCache.set(key, p)
  }
  return p
}

function textHasToken(text: string | null | undefined, token: string): boolean {
  if (!text) return false
  return patternFor(token).test(text)
}

/**
 * Whether the item's Name carries this marker. Only the Name (the field dispatch
 * writes the marker into on live jobs, e.g. "Walk-in Master Shower Re-Grouting *T*")
 * assigns ownership; the Description is Workiz's product marketing text.
 */
export function findMarker(item: Pick<NormalizedLineItem, "name" | "description">, marker: string): MarkerField | null {
  const tokens = parseMarkerTokens(marker)
  if (tokens.length === 0) return null
  if (tokens.some((t) => textHasToken(item.name, t))) return "name"
  return null
}

/** A marker typed into the Description but not the Name: flagged, never trusted. */
export function markerOnlyInDescription(item: Pick<NormalizedLineItem, "name" | "description">, marker: string): boolean {
  const tokens = parseMarkerTokens(marker)
  if (tokens.length === 0 || findMarker(item, marker)) return false
  return tokens.some((t) => textHasToken(item.description, t))
}

export function itemsWithMarker(items: NormalizedLineItem[], marker: string): NormalizedLineItem[] {
  return items.filter((i) => findMarker(i, marker) !== null)
}

// --- Work Type -----------------------------------------------------------------

/**
 * Canonical form of a Workiz Work Type for comparison: trimmed, lower-cased,
 * inner whitespace collapsed, curly apostrophes made straight.
 */
export function normalizeWorkType(value: string | null | undefined): string | null {
  if (value == null) return null
  const s = value
    .replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  return s.length ? s : null
}

export function workTypeMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeWorkType(a)
  const nb = normalizeWorkType(b)
  return na !== null && nb !== null && na === nb
}

// --- Segmentation --------------------------------------------------------------

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

const positiveGross = (job: SegmentableJob) => round2(job.lineItems.filter((i) => i.total > 0).reduce((s, i) => s + i.total, 0))

/** The whole job as a single segment: what every payout used before markers existed. */
export function wholeJobSegment(job: SegmentableJob): JobSegment {
  return {
    kind: "job",
    ownership: "crew",
    workType: null,
    marker: null,
    itemIndexes: job.lineItems.map((_, i) => i),
    itemNames: job.lineItems.map((i) => i.name),
    markerFields: [],
    grossAmount: positiveGross(job),
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

/**
 * Rule A: the whole discounted service subtotal belongs to the Work Type owner.
 * Returns the owner's segment (every item, no tips) and an empty crew segment
 * that carries the tips so regular technicians on the job can still split them.
 */
export function workTypeSegments(job: SegmentableJob, workType: string): { owner: JobSegment; crew: JobSegment } {
  const owner: JobSegment = {
    ...wholeJobSegment(job),
    kind: "dedicated",
    ownership: "work-type",
    workType,
    cardTipAmount: 0,
    nonCardTipAmount: 0,
  }
  const crew: JobSegment = {
    kind: "crew",
    ownership: "crew",
    workType: null,
    marker: null,
    itemIndexes: [],
    itemNames: [],
    markerFields: [],
    grossAmount: 0,
    itemDiscountAmount: 0,
    allocatedDiscountAmount: 0,
    share: 0,
    jobTotal: 0,
    colorSealTotal: 0,
    cardServiceAmount: 0,
    nonCardServiceAmount: 0,
    cardTipAmount: job.cardTipAmount,
    nonCardTipAmount: job.nonCardTipAmount,
  }
  return { owner, crew }
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
 * Rule B + C: split a job into one "dedicated" segment per marker plus one
 * "crew" segment.
 *
 * Discount rules:
 * - A negative line item that carries a marker is a discount specific to that
 *   technician's work and stays inside his segment.
 * - The Workiz job-level Discount and any unmarked negative line items are
 *   whole-job discounts. They are allocated proportionally to each segment's
 *   pre-discount base so every segment ends up "after discounts", exactly as the
 *   job total itself is. Nothing is deducted twice.
 * - Card-paid service dollars are shown per segment in the same proportion for
 *   display; the commission itself uses the invoice-wide card share (calculator).
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
      warnings.push(
        `Line item "${item.name}" carries more than one technician marker (${hits.map((h) => markerLabel(h.marker) ?? h.marker).join(", ")}); assigned to ${markerLabel(hits[0].marker) ?? hits[0].marker}`,
      )
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
      ownership: "marker",
      workType: null,
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
    ownership: "crew",
    workType: null,
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

// --- Planning ------------------------------------------------------------------

/** The profile fields the planner needs; a full TechnicianProfile satisfies this. */
export type PlannableProfile = { id: number; name: string; lineItemMarker: string | null; ownedWorkType?: string | null }
export type MarkerOwner = PlannableProfile

export type TipAllocation = {
  /** Business-held tip on the job (card + other), before any split. */
  total: number
  /** Regular technicians who share the tip equally. */
  recipients: { id: number; name: string }[]
  /** Each recipient's fraction: 1 / recipients.length. */
  share: number
  /** Technicians on the job who never share tips. */
  excluded: { id: number; name: string; reason: OwnershipReason }[]
  /** Set when a tip exists but nobody is eligible to receive it. */
  needsReview: string | null
}

export type SegmentPlan = {
  segmentation: Segmentation
  /** Which commission base each mapped profile is paid on. */
  segmentFor: Map<number, JobSegment>
  /** How many technicians share that base (informational, stored as split_count). */
  splitCountFor: Map<number, number>
  /** Fraction of the business-held tip each profile receives (0 for dedicated technicians). */
  tipShareFor: Map<number, number>
  tips: TipAllocation
  /** Assignment problems that must hold every payout on the job for review. */
  warnings: string[]
}

export const TIP_REVIEW_PREFIX = "Tip allocation needs review"

const markerOf = (p: PlannableProfile) => normalizeMarkerTokens(p.lineItemMarker)
const shown = (marker: string) => markerLabel(marker) ?? marker
const money = (n: number) => `$${n.toFixed(2)}`
/** A technician who is paid on his own work only and never shares tips. */
const isDedicated = (p: PlannableProfile) => Boolean(markerOf(p) || normalizeWorkType(p.ownedWorkType))

/** Active profiles whose owned Work Type matches the job's. */
export function workTypeOwners<P extends PlannableProfile>(jobType: string | null | undefined, roster: readonly P[]): P[] {
  if (!normalizeWorkType(jobType)) return []
  return roster.filter((p) => workTypeMatches(p.ownedWorkType, jobType))
}

function allocateTips(job: SegmentableJob, onJob: PlannableProfile[], regular: PlannableProfile[], reasonFor: (p: PlannableProfile) => OwnershipReason): TipAllocation {
  const total = round2(job.cardTipAmount + job.nonCardTipAmount)
  const recipients = regular.map((p) => ({ id: p.id, name: p.name }))
  const excluded = onJob.filter((p) => !regular.some((r) => r.id === p.id)).map((p) => ({ id: p.id, name: p.name, reason: reasonFor(p) }))
  const share = recipients.length ? 1 / recipients.length : 0
  let needsReview: string | null = null
  if (total > 0 && recipients.length === 0) {
    const names = excluded.map((e) => e.name).join(", ")
    needsReview = `${TIP_REVIEW_PREFIX}: ${money(total)} was recorded as a tip but no regular technician is on this job to receive it${names ? ` (${names} ${excluded.length === 1 ? "does" : "do"} not share tips)` : ""}; decide who it belongs to before release`
  }
  return { total, recipients, share, excluded, needsReview }
}

/**
 * Decide who is paid on what.
 *
 * - Work Type owned by a technician: that technician is paid on the whole job;
 *   the regular crew gets no service commission but still splits any tip.
 * - Regular crew + a marked technician on the same job: the marked technician is
 *   paid on his marked items only, the crew on everything else (and all tips).
 * - A technician working alone, or a crew with nobody marked: the whole job, as
 *   the calculator has always done.
 *
 * `roster` is every active profile, so items marked for someone who is not
 * assigned to the job, or a Work Type whose owner is missing, can be flagged.
 */
export function planSegments<P extends PlannableProfile>(job: SegmentableJob, onJob: P[], roster: readonly MarkerOwner[]): SegmentPlan {
  const warnings: string[] = []
  const segmentFor = new Map<number, JobSegment>()
  const splitCountFor = new Map<number, number>()
  const tipShareFor = new Map<number, number>()
  const onJobIds = new Set(onJob.map((p) => p.id))

  // Items whose marker is only in the Description are never trusted, but they are a data problem worth a look.
  for (const owner of roster) {
    const m = markerOf(owner)
    if (!m) continue
    const descOnly = job.lineItems.filter((i) => markerOnlyInDescription(i, m))
    if (descOnly.length) {
      warnings.push(`${descOnly.length} line item${descOnly.length === 1 ? " has" : "s have"} ${shown(m)} in the description but not the item name; markers are read from the name only, so ${descOnly.map((i) => `"${i.name}"`).join(", ")} ${descOnly.length === 1 ? "is" : "are"} treated as crew work`)
    }
  }

  // --- Rule A: Work Type ownership -----------------------------------------------
  const owners = workTypeOwners(job.jobType, roster)
  if (owners.length > 1) {
    warnings.push(`Work Type "${job.jobType}" is owned by more than one technician profile (${owners.map((o) => o.name).join(", ")}); fix the profiles before release`)
  }
  if (owners.length === 1) {
    const owner = owners[0]
    const workType = (job.jobType as string).trim()
    const { owner: ownerSegment, crew: crewSegment } = workTypeSegments(job, workType)
    const regular = onJob.filter((p) => p.id !== owner.id && !isDedicated(p))
    const otherDedicated = onJob.filter((p) => p.id !== owner.id && isDedicated(p))

    if (!onJobIds.has(owner.id)) {
      warnings.push(`Work Type is "${workType}" but ${owner.name} is not assigned to this job in Workiz; confirm the job belongs to ${owner.name} before release`)
    }
    for (const p of otherDedicated) {
      warnings.push(`${p.name} is assigned to this job but the Work Type "${workType}" gives the whole job to ${owner.name}; ${p.name} would be paid nothing`)
    }
    for (const other of roster) {
      const m = markerOf(other)
      if (!m || other.id === owner.id) continue
      const hits = itemsWithMarker(job.lineItems, m)
      if (hits.length) warnings.push(`${hits.length} line item${hits.length === 1 ? "" : "s"} carry ${shown(m)} for ${other.name} but the Work Type "${workType}" gives the whole job to ${owner.name}: ${hits.map((i) => i.name).join(", ")}`)
    }

    for (const p of onJob) {
      if (p.id === owner.id) {
        segmentFor.set(p.id, ownerSegment)
        splitCountFor.set(p.id, 1)
        tipShareFor.set(p.id, 0)
      } else {
        segmentFor.set(p.id, crewSegment)
        splitCountFor.set(p.id, Math.max(1, regular.length))
      }
    }
    const tips = allocateTips(job, onJob, regular, (p) => (p.id === owner.id ? "work-type" : "marker"))
    for (const p of regular) tipShareFor.set(p.id, tips.share)
    for (const p of otherDedicated) tipShareFor.set(p.id, 0)
    if (tips.needsReview) warnings.push(tips.needsReview)

    const segments = [ownerSegment, crewSegment]
    const segmentation: Segmentation = { segments, warnings: [], verification: verify(job, segments) }
    return { segmentation, segmentFor, splitCountFor, tipShareFor, tips, warnings }
  }

  // --- Rule B / C: markers, then crew ---------------------------------------------
  const dedicated = onJob.filter((p) => markerOf(p))
  const crew = onJob.filter((p) => !markerOf(p))
  // Regular technicians are the tip recipients; anyone with a marker or an owned Work Type is not.
  const regular = onJob.filter((p) => !isDedicated(p))

  const ownersByMarker = new Map<string, string[]>()
  for (const p of dedicated) {
    const m = markerOf(p) as string
    ownersByMarker.set(m, [...(ownersByMarker.get(m) ?? []), p.name])
  }
  for (const [m, names] of ownersByMarker) {
    if (names.length > 1) warnings.push(`Marker ${shown(m)} is assigned to more than one technician on this job (${names.join(", ")})`)
  }

  for (const owner of roster) {
    const m = markerOf(owner)
    if (!m || onJobIds.has(owner.id)) continue
    const hits = itemsWithMarker(job.lineItems, m)
    if (hits.length) {
      warnings.push(`${hits.length} line item${hits.length === 1 ? "" : "s"} carry ${shown(m)} but ${owner.name} is not assigned to this job: ${hits.map((i) => i.name).join(", ")}`)
    }
  }

  const tips = allocateTips(job, onJob, regular, () => "marker")
  if (tips.needsReview) warnings.push(tips.needsReview)
  for (const p of onJob) tipShareFor.set(p.id, regular.some((r) => r.id === p.id) ? tips.share : 0)

  if (dedicated.length === 0 || crew.length === 0) {
    const segmentation = segmentJob(job, [])
    for (const p of onJob) {
      segmentFor.set(p.id, segmentation.segments[0])
      splitCountFor.set(p.id, onJob.length)
    }
    return { segmentation, segmentFor, splitCountFor, tipShareFor, tips, warnings }
  }

  const segmentation = segmentJob(job, dedicated.map((p) => markerOf(p) as string))
  warnings.push(...segmentation.warnings)
  const crewSegment = segmentation.segments.find((s) => s.kind === "crew") as JobSegment

  for (const p of dedicated) {
    const m = markerOf(p) as string
    const seg = segmentation.segments.find((s) => s.kind === "dedicated" && s.marker === m) as JobSegment
    if (seg.itemIndexes.length === 0) warnings.push(`${p.name} is assigned to this job but no line items carry ${shown(m)}`)
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

  return { segmentation, segmentFor, splitCountFor, tipShareFor, tips, warnings }
}

/** Ownership info a payout snapshot may carry, for labels. */
export type OwnershipInfo = { reason?: string | null; workType?: string | null }

/** Short human label for a payout's commission base. */
export function segmentLabel(kind: string | null | undefined, marker: string | null | undefined, ownership?: OwnershipInfo | null): string | null {
  // A payout on a job whose Work Type is owned: the owner gets the whole job, the crew nothing.
  if (ownership?.workType) {
    if (ownership.reason === "work-type") return `Whole job · Work Type "${ownership.workType}"`
    if (kind === "crew") return `No crew commission · Work Type "${ownership.workType}"`
  }
  const label = markerLabel(marker)
  if (kind === "dedicated") return `${label ?? "Marked"} work only`
  if (kind === "crew") return label ? `Crew work (excl. ${label})` : "Crew work"
  return null
}

/** One-line explanation of why a technician is paid on a segment. */
export function ownershipExplanation(kind: string | null | undefined, marker: string | null | undefined, ownership?: OwnershipInfo | null): string {
  if (ownership?.workType) {
    if (ownership.reason === "work-type") return `Work Type is "${ownership.workType}": the entire discounted service subtotal belongs to this technician, color sealing included.`
    if (kind === "crew") return `Work Type is "${ownership.workType}": the whole job belongs to its owner, so this technician earns no service commission here (tips are still split among regular technicians).`
  }
  const label = markerLabel(marker)
  if (kind === "dedicated") return `Only line items whose name carries the ${label ?? "marker"} marker; nothing else on the invoice.`
  if (kind === "crew") return label ? `Regular crew work: every line item except those marked ${label}.` : "Regular crew work: every line item on the invoice."
  return "Whole job: no ownership markers or owned Work Type, so every line item is regular crew work."
}
