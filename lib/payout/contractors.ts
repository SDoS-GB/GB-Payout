/**
 * Technician profiles that the manual payout calculator has always used.
 * Moved verbatim out of app/page.tsx so the server-side Workiz payout engine
 * and the calculator share one source of truth. Legacy values are unchanged;
 * Daniel was added later on the same commission as Arthur.
 *
 * Confirmed rates (2026-09-23): regular technicians 20% regular / 25% color
 * sealing, Vadim 25% / 25%, Tim 80% on work that belongs to Tim.
 */
export const CONTRACTORS = {
  Vadim: { pin: "4826", nonColorRate: 0.25, colorRate: 0.25 },
  Denis: { pin: "7155", nonColorRate: 0.2, colorRate: 0.25 },
  Arthur: { pin: "5183", nonColorRate: 0.2, colorRate: 0.25 },
  Viktor: { pin: "3515", nonColorRate: 0.2, colorRate: 0.25 },
  Tim: { pin: "4496", nonColorRate: 0.8, colorRate: 0.8 },
  Alex: { pin: "8254", nonColorRate: 0.2, colorRate: 0.25 },
  Rodion: { pin: "8585", nonColorRate: 0.2, colorRate: 0.25 },
  Daniel: { pin: "1468", nonColorRate: 0.2, colorRate: 0.25 },
} as const

export type ContractorName = keyof typeof CONTRACTORS

export const CONTRACTOR_NAMES = Object.keys(CONTRACTORS) as ContractorName[]

/**
 * Behavioural switches the legacy calculator derives from the technician name.
 * - `separateColorSeal`: the calculator hides the Color Seal input for Tim and
 *   treats the whole job as non-color work (`showColorSeal = name !== "Tim"`).
 * - `tipShare`: legacy `tipDivisor` was 0.5 for a two-tech crew. Tim's used to
 *   be 1; since the 2026-09-23 correction Tim receives no share of any tip, so
 *   the calculator shows his tip as held for the office rather than paid out.
 */
export function legacyProfileOptions(name: string) {
  return {
    separateColorSeal: name !== "Tim",
    tipShare: name === "Tim" ? 0 : 0.5,
  }
}

/**
 * Line-item marker token. A Workiz item belongs to this technician only when
 * its Name carries the literal asterisk-delimited marker `*T*` (whitespace
 * inside the asterisks allowed: `* T *`). Only seeded for new profiles; admins
 * edit it in the Technicians tab.
 */
export const LINE_ITEM_MARKERS: Partial<Record<ContractorName, string>> = {
  Tim: "T",
}

/**
 * Workiz Work Type whose jobs belong wholly to one technician. A job whose
 * `JobType` is "Tim's Job" pays Tim on the entire discounted service subtotal
 * (color sealing included) and the regular crew earns no service commission on
 * it. Only seeded for new profiles; admins edit it in the Technicians tab.
 */
export const WORK_TYPE_OWNERS: Partial<Record<ContractorName, string>> = {
  Tim: "Tim's Job",
}

/**
 * Technicians who are on every job of another technician without being assigned
 * in Workiz (companion -> the technician they always work with). Denis goes out
 * with Vadim on every job while Workiz only lists Vadim. Only seeded for new
 * profiles; admins change it in the Technicians tab.
 */
export const COMPANIONS: Partial<Record<ContractorName, ContractorName>> = {
  Denis: "Vadim",
}
