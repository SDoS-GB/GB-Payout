import { createHash } from "node:crypto"
import type { NormalizedJob } from "@/lib/workiz/normalize"
import { classifyPaymentMethod } from "@/lib/workiz/payments"

export type OwnerPayout = { id: number; profileId: number; name: string; status: string; totalPayout: string; inputHash: string | null; holdReason: string | null }

export function buildOwnerMessage(job: NormalizedJob, rows: OwnerPayout[], timeZone: string): string {
  const methods = new Map<string, number>()
  for (const pay of job.payments) {
    const name = classifyPaymentMethod(pay.method).label
    methods.set(name, (methods.get(name) ?? 0) + pay.amount)
  }
  const date = job.lastStatusUpdate ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(job.lastStatusUpdate) : "date unavailable"
  return [
    "GB payout ready",
    `Job #${job.serialId ?? job.uuid} - ${job.clientName ?? "Customer name unavailable"}`,
    `Completed ${date}`,
    `Client payments: ${Array.from(methods).map(([name, amount]) => `${name} $${amount.toFixed(2)}`).join("; ")}`,
    job.cardServiceAmount > 0 ? "Card fee applied proportionally." : "No card-paid services.",
    ...rows.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `${p.name}: $${Number(p.totalPayout).toFixed(2)}`),
  ].join("\n")
}

export function ownerSnapshotHash(message: string, rows: OwnerPayout[]): string {
  return createHash("sha256").update(JSON.stringify({ message, payouts: rows.slice().sort((a, b) => a.id - b.id).map((p) => [p.id, p.profileId, p.status, p.inputHash, p.totalPayout]) })).digest("hex")
}

export function allPayoutsReady(rows: OwnerPayout[], expectedIds: number[], unresolved: string[]): string | null {
  if (unresolved.length) return `Unmapped or inactive technicians: ${unresolved.join(", ")}`
  if (!rows.length || !expectedIds.length) return "No complete technician calculation exists for this job"
  if (expectedIds.some((id) => !rows.some((p) => p.id === id))) return "A required technician calculation is missing"
  const unfinished = rows.filter((p) => p.status !== "ready")
  if (unfinished.length) return unfinished.map((p) => `${p.name}: ${p.holdReason ?? p.status}`).join("; ")
  if (rows.some((p) => !p.inputHash || !Number.isFinite(Number(p.totalPayout)) || Number(p.totalPayout) < 0)) return "A technician calculation is unverified"
  return null
}
