/**
 * Payout arithmetic extracted from app/page.tsx `calcJobPayout`.
 *
 * The legacy function is preserved operation-for-operation in
 * `calcLegacyJobPayout`. `calcPayoutWithPaymentSplit` is the authorised
 * extension for mixed card / non-card payments: it applies the same
 * per-category formula to the card-paid and non-card-paid portions and sums
 * them once, so an all-card or all-non-card job is routed straight back to
 * the legacy function and stays bit-identical.
 *
 * Nothing in here rounds intermediate values. Display rounding is `toFixed(2)`
 * exactly as the calculator UI does.
 */

export const CALC_VERSION = "legacy-v1+ownership-2026-09-23"

export const CARD_FEE_MULTIPLIER = 0.965
/** Processor fee on the card-paid part of the invoice; `1 - CARD_FEE_MULTIPLIER`. */
export const CARD_FEE_RATE = 0.035

/**
 * The single invoice-wide multiplier every service amount is scaled by before a
 * rate is applied: `1 - cardShare x 3.5%`, where `cardShare = C / S` is the
 * fraction of the discounted service subtotal the customer paid by card. It is
 * the same for every technician and category on the job, so nobody's smaller
 * portion is ever measured against its own card percentage.
 */
export function serviceFactorFor(cardServiceShare: number): number {
  const share = Math.min(1, Math.max(0, Number.isFinite(cardServiceShare) ? cardServiceShare : 0))
  return 1 - share * CARD_FEE_RATE
}

/** `C / S` with the S = 0 case made explicit: no service revenue means no card share. */
export function cardShareOf(cardServiceAmount: number, jobTotal: number): number {
  if (!(jobTotal > 0)) return 0
  return Math.min(1, Math.max(0, cardServiceAmount / jobTotal))
}

export interface Rates {
  nonColorRate: number
  colorRate: number
}

export interface ProfileOptions {
  /** false = treat whole job as non-color (legacy Tim behaviour). */
  separateColorSeal: boolean
  /** legacy tipDivisor: 0.5 for a two-tech split, 1 for a solo tech. */
  tipShare: number
}

export interface LegacyJobInput {
  jobTotal: string | number
  colorSealTotal: string | number
  tip: string | number
  isCreditCard: boolean
}

export interface PayoutBreakdown {
  nonColorPayout: number
  colorPayout: number
  tipPayout: number
  basePayout: number
  totalPayout: number
  nonColorAmount: number
  colorAmount: number
  jobTotalNum: number
  colorSealTotalNum: number
  tipNum: number
}

/** Identical to the calculator's `parseNumber`, widened to accept numbers. */
export const parseNumber = (value: string | number): number => {
  const num = Number.parseFloat(String(value)) || 0
  return num < 0 ? 0 : num
}

export const formatCurrency = (value: number): string => `$${value.toFixed(2)}`

/**
 * Verbatim port of the legacy `calcJobPayout` body. `showColorSeal` and the
 * tip divisor are passed in because the page derives them from the logged-in
 * contractor and the contractor being calculated respectively.
 */
export function calcLegacyJobPayout(job: LegacyJobInput, rates: Rates, options: ProfileOptions): PayoutBreakdown {
  const showColorSeal = options.separateColorSeal
  const jobTotalNum = parseNumber(job.jobTotal)
  const colorSealTotalNum = parseNumber(job.colorSealTotal)
  const tipNum = parseNumber(job.tip)
  const nonColorAmount = showColorSeal ? jobTotalNum - colorSealTotalNum : jobTotalNum
  const colorAmount = showColorSeal ? colorSealTotalNum : 0

  const fee = job.isCreditCard ? CARD_FEE_MULTIPLIER : 1
  const nonColorPayout = nonColorAmount * fee * rates.nonColorRate
  const colorPayout = colorAmount * fee * rates.colorRate

  let tipPayout = 0
  if (tipNum > 0) {
    const tipDivisor = options.tipShare
    tipPayout = tipNum * fee * tipDivisor
  }

  const basePayout = nonColorPayout + colorPayout
  const totalPayout = basePayout + tipPayout
  return { nonColorPayout, colorPayout, tipPayout, basePayout, totalPayout, nonColorAmount, colorAmount, jobTotalNum, colorSealTotalNum, tipNum }
}

export interface SplitPayoutInput {
  /** Service subtotal after discounts, excluding tips and tax. */
  jobTotal: number
  /** Color-sealing portion after discounts (already inside jobTotal). */
  colorSealTotal: number
  /** Service dollars paid by credit card (no tips / tax inside). */
  cardServiceAmount: number
  /** Tips paid by card that the business owes the crew (fee applies). */
  cardTip: number
  /** Tips the business holds that were paid by check/cash/Zelle (no fee). */
  nonCardOwedTip: number
}

export interface SplitPayoutBreakdown extends PayoutBreakdown {
  /** `C / S`: fraction of the invoice's service subtotal paid by card. */
  cardServiceShare: number
  /** `1 - cardServiceShare x 3.5%`, applied to every service dollar before its rate. */
  serviceFactor: number
  /** Service amounts after the invoice-wide factor (what the rates are applied to). */
  adjustedNonColorAmount: number
  adjustedColorAmount: number
  cardNonColorAmount: number
  cardColorAmount: number
  nonCardNonColorAmount: number
  nonCardColorAmount: number
  cardTipPayout: number
  nonCardTipPayout: number
  mode: "legacy-card" | "legacy-non-card" | "split"
}

export interface CardShareInput {
  /** Service subtotal after discounts, excluding tips and tax (this technician's eligible amount). */
  jobTotal: number
  /** Color-sealing portion after discounts (already inside jobTotal). */
  colorSealTotal: number
  /** Invoice-wide `C / S`, identical for every technician on the job. */
  cardServiceShare: number
  /** Tips paid by card that the business owes the crew (fee applies). */
  cardTip: number
  /** Tips the business holds that were paid by check/cash/Zelle (no fee). */
  nonCardOwedTip: number
}

const EPSILON = 1e-9

/**
 * The authoritative commission formula. Every eligible service dollar is scaled
 * by the invoice-wide `serviceFactor` and then multiplied by the technician's
 * rate; the business-held tip is scaled by the fee only where it was paid by
 * card and then by the technician's share. Pure all-card and all-non-card
 * inputs are routed through the legacy function so historical results stay
 * bit-identical.
 */
export function calcPayoutWithCardShare(input: CardShareInput, rates: Rates, options: ProfileOptions): SplitPayoutBreakdown {
  const jobTotal = parseNumber(input.jobTotal)
  const colorSeal = parseNumber(input.colorSealTotal)
  const cardTip = parseNumber(input.cardTip)
  const nonCardTip = parseNumber(input.nonCardOwedTip)
  const cardServiceShare = Math.min(1, Math.max(0, Number.isFinite(input.cardServiceShare) ? input.cardServiceShare : 0))

  const noCardMoney = cardServiceShare < EPSILON && cardTip < EPSILON
  const fullyCard = (jobTotal < EPSILON || 1 - cardServiceShare < EPSILON) && nonCardTip < EPSILON

  if (noCardMoney) {
    const legacy = calcLegacyJobPayout({ jobTotal, colorSealTotal: colorSeal, tip: nonCardTip, isCreditCard: false }, rates, options)
    return {
      ...legacy,
      cardServiceShare: 0,
      serviceFactor: 1,
      adjustedNonColorAmount: legacy.nonColorAmount,
      adjustedColorAmount: legacy.colorAmount,
      cardNonColorAmount: 0,
      cardColorAmount: 0,
      nonCardNonColorAmount: legacy.nonColorAmount,
      nonCardColorAmount: legacy.colorAmount,
      cardTipPayout: 0,
      nonCardTipPayout: legacy.tipPayout,
      mode: "legacy-non-card",
    }
  }

  if (fullyCard) {
    const legacy = calcLegacyJobPayout({ jobTotal, colorSealTotal: colorSeal, tip: cardTip, isCreditCard: true }, rates, options)
    return {
      ...legacy,
      cardServiceShare: 1,
      serviceFactor: CARD_FEE_MULTIPLIER,
      adjustedNonColorAmount: legacy.nonColorAmount * CARD_FEE_MULTIPLIER,
      adjustedColorAmount: legacy.colorAmount * CARD_FEE_MULTIPLIER,
      cardNonColorAmount: legacy.nonColorAmount,
      cardColorAmount: legacy.colorAmount,
      nonCardNonColorAmount: 0,
      nonCardColorAmount: 0,
      cardTipPayout: legacy.tipPayout,
      nonCardTipPayout: 0,
      mode: "legacy-card",
    }
  }

  const showColorSeal = options.separateColorSeal
  const nonColorAmount = showColorSeal ? jobTotal - colorSeal : jobTotal
  const colorAmount = showColorSeal ? colorSeal : 0

  const serviceFactor = serviceFactorFor(cardServiceShare)
  const adjustedNonColorAmount = nonColorAmount * serviceFactor
  const adjustedColorAmount = colorAmount * serviceFactor
  const nonColorPayout = adjustedNonColorAmount * rates.nonColorRate
  const colorPayout = adjustedColorAmount * rates.colorRate

  // Informational split of the eligible amounts by payment method (display only).
  const cardNonColorAmount = nonColorAmount * cardServiceShare
  const nonCardNonColorAmount = nonColorAmount - cardNonColorAmount
  const cardColorAmount = colorAmount * cardServiceShare
  const nonCardColorAmount = colorAmount - cardColorAmount

  let cardTipPayout = 0
  if (cardTip > 0) cardTipPayout = cardTip * CARD_FEE_MULTIPLIER * options.tipShare
  let nonCardTipPayout = 0
  if (nonCardTip > 0) nonCardTipPayout = nonCardTip * 1 * options.tipShare
  const tipPayout = cardTipPayout + nonCardTipPayout

  const basePayout = nonColorPayout + colorPayout
  const totalPayout = basePayout + tipPayout

  return {
    nonColorPayout,
    colorPayout,
    tipPayout,
    basePayout,
    totalPayout,
    nonColorAmount,
    colorAmount,
    jobTotalNum: jobTotal,
    colorSealTotalNum: colorSeal,
    tipNum: cardTip + nonCardTip,
    cardServiceShare,
    serviceFactor,
    adjustedNonColorAmount,
    adjustedColorAmount,
    cardNonColorAmount,
    cardColorAmount,
    nonCardNonColorAmount,
    nonCardColorAmount,
    cardTipPayout,
    nonCardTipPayout,
    mode: "split",
  }
}

/**
 * Mixed-payment payout expressed in dollars paid by card. The card share is
 * `cardServiceAmount / jobTotal`; the arithmetic is `calcPayoutWithCardShare`.
 */
export function calcPayoutWithPaymentSplit(input: SplitPayoutInput, rates: Rates, options: ProfileOptions): SplitPayoutBreakdown {
  const jobTotal = parseNumber(input.jobTotal)
  const cardService = parseNumber(input.cardServiceAmount)
  return calcPayoutWithCardShare(
    {
      jobTotal,
      colorSealTotal: parseNumber(input.colorSealTotal),
      cardServiceShare: cardShareOf(cardService, jobTotal),
      cardTip: parseNumber(input.cardTip),
      nonCardOwedTip: parseNumber(input.nonCardOwedTip),
    },
    rates,
    options,
  )
}

/** Amount owed as the calculator displays it (cents). */
export function toCents(value: number): number {
  return Number(value.toFixed(2))
}
