import type { PayoutRow } from "@/lib/db/schema"

/**
 * Converts a payout row's numeric string columns into plain numbers.
 * Kept free of database imports so client components can use it.
 */
export function payoutMoney(row: PayoutRow) {
  return {
    total: Number(row.totalPayout),
    base: Number(row.basePayout),
    tip: Number(row.tipPayout),
    nonColor: Number(row.nonColorPayout),
    color: Number(row.colorPayout),
    jobTotal: Number(row.jobTotal),
    colorSeal: Number(row.colorSealTotal),
    discount: Number(row.discountAmount),
    cardService: Number(row.cardServiceAmount),
    nonCardService: Number(row.nonCardServiceAmount),
    cardTip: Number(row.cardTipAmount),
    nonCardTip: Number(row.nonCardTipAmount),
  }
}
