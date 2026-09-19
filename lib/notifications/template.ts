import type { PayoutRow, TechnicianProfile, WorkizJobRow } from "@/lib/db/schema"
import { formatCurrency } from "@/lib/payout/calculator"
import { payoutMoney } from "@/lib/payout/money"

export type TemplateContext = {
  technician: string
  jobSerial: string
  jobUuid: string
  clientName: string
  jobTotal: string
  discountLine: string
  colorSealLine: string
  tipLine: string
  basePayout: string
  tipPayout: string
  totalPayout: string
  status: string
  holdReason: string
}

export function buildTemplateContext(payout: PayoutRow, profile: TechnicianProfile, job: WorkizJobRow | null): TemplateContext {
  const m = payoutMoney(payout)
  const tipTotal = m.cardTip + m.nonCardTip
  return {
    technician: profile.name,
    jobSerial: job?.serialId ?? payout.jobUuid.slice(0, 8),
    jobUuid: payout.jobUuid,
    clientName: job?.clientName ?? "client",
    jobTotal: formatCurrency(m.jobTotal),
    discountLine: m.discount > 0 ? ` (after ${formatCurrency(m.discount)} discount)` : "",
    colorSealLine: m.colorSeal > 0 ? `, color seal ${formatCurrency(m.colorSeal)}` : "",
    tipLine: tipTotal > 0 ? `, tips ${formatCurrency(tipTotal)}` : "",
    basePayout: formatCurrency(m.base),
    tipPayout: formatCurrency(m.tip),
    totalPayout: formatCurrency(m.total),
    status: payout.status,
    holdReason: payout.holdReason ?? "",
  }
}

export const TEMPLATE_PLACEHOLDERS = [
  "technician",
  "jobSerial",
  "jobUuid",
  "clientName",
  "jobTotal",
  "discountLine",
  "colorSealLine",
  "tipLine",
  "basePayout",
  "tipPayout",
  "totalPayout",
  "status",
  "holdReason",
] as const satisfies ReadonlyArray<keyof TemplateContext>

/** Replace {{placeholders}}; unknown keys are left visible so admins notice typos. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template
    .replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key: string) => {
      if (key in ctx) return ctx[key as keyof TemplateContext]
      return match
    })
    .replace(/\s{2,}/g, " ")
    .trim()
}
