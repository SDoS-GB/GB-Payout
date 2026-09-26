/**
 * CSV for Paid history, built from the already-loaded payment list. One row per job inside each
 * payment so a spreadsheet can total by technician, payment or job. Amounts are the recorded
 * figures; nothing is recomputed.
 */

export type ExportablePayment = {
  id: number
  status: string
  kind: string
  profileName: string
  method: string | null
  paidOn: string | null
  paidAmount: string | number | null
  calculatedTotal: string | number
  reference: string | null
  recordedAt: Date | string
  recordedBy: string
  reversedAt?: Date | string | null
  reversalReason?: string | null
  items: Array<{ jobUuid: string; amount: string | number; job: { serialId: string | null; clientName: string | null } | null }>
}

export const HISTORY_CSV_HEADER = ["Payment #", "Status", "Type", "Technician", "Method", "Paid on", "Payment total", "Job #", "Customer", "Job amount", "Job UUID", "Reference", "Recorded at (UTC)", "Recorded by", "Undone at (UTC)", "Undo reason"] as const

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = value instanceof Date ? value.toISOString() : String(value)
  // Neutralise spreadsheet formula injection as well as quoting.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

const iso = (d: Date | string | null | undefined) => {
  if (!d) return ""
  const date = typeof d === "string" ? new Date(d) : d
  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

const amount = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : Number(v).toFixed(2))

export function historyToCsv(payments: ExportablePayment[]): string {
  const lines: string[] = [HISTORY_CSV_HEADER.join(",")]
  for (const b of payments) {
    const total = amount(b.paidAmount ?? b.calculatedTotal)
    const status = b.status === "reversed" ? "undone" : b.status
    const type = b.kind === "opening" ? "opening balance" : "payment"
    const common = [b.id, status, type, b.profileName, b.method ?? "", b.paidOn ?? "", total]
    const tail = [b.reference ?? "", iso(b.recordedAt), b.recordedBy, iso(b.reversedAt), b.reversalReason ?? ""]
    if (b.items.length === 0) {
      lines.push([...common, "", "", "", "", ...tail].map(csvCell).join(","))
      continue
    }
    for (const item of b.items) {
      lines.push([...common, item.job?.serialId ?? "", item.job?.clientName ?? "", amount(item.amount), item.jobUuid, ...tail].map(csvCell).join(","))
    }
  }
  return `${lines.join("\r\n")}\r\n`
}

export function historyCsvFilename(now = new Date()): string {
  return `grout-brothers-paid-history-${now.toISOString().slice(0, 10)}.csv`
}
