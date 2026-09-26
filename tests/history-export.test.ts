import { describe, expect, it } from "vitest"
import { HISTORY_CSV_HEADER, csvCell, historyToCsv, type ExportablePayment } from "@/lib/payout/history-export"

describe("csvCell", () => {
  it("quotes commas, quotes and newlines and guards formulas", () => {
    expect(csvCell("plain")).toBe("plain")
    expect(csvCell('Bill "Mac" McCarty, Jr.')).toBe('"Bill ""Mac"" McCarty, Jr."')
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"')
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)")
    expect(csvCell(null)).toBe("")
  })
})

describe("historyToCsv", () => {
  const payment: ExportablePayment = {
    id: 12,
    status: "recorded",
    kind: "payment",
    profileName: "Arthur",
    method: "Zelle",
    paidOn: "2026-09-25",
    paidAmount: "590.90",
    calculatedTotal: "590.90",
    reference: null,
    recordedAt: new Date("2026-09-25T22:40:00.000Z"),
    recordedBy: "admin",
    items: [{ jobUuid: "ABC123", amount: "590.90", job: { serialId: "924884", clientName: "Ray Oblenes" } }],
  }

  it("writes one row per job with the recorded amounts", () => {
    const csv = historyToCsv([payment])
    const [header, row, trailing] = csv.split("\r\n")
    expect(header).toBe(HISTORY_CSV_HEADER.join(","))
    expect(row).toBe("12,recorded,payment,Arthur,Zelle,2026-09-25,590.90,924884,Ray Oblenes,590.90,ABC123,,2026-09-25T22:40:00.000Z,admin,,")
    expect(trailing).toBe("")
  })

  it("marks undone payments and opening balances, and keeps empty payments as a single row", () => {
    const csv = historyToCsv([
      { ...payment, id: 13, status: "reversed", reversedAt: "2026-09-26T01:00:00.000Z", reversalReason: "Wrong tech", items: [] },
      { ...payment, id: 14, kind: "opening", method: null, paidOn: null },
    ])
    const rows = csv.trim().split("\r\n")
    expect(rows).toHaveLength(3)
    expect(rows[1].startsWith("13,undone,payment,Arthur,Zelle,2026-09-25,590.90,,,,,,")).toBe(true)
    expect(rows[1].endsWith(",2026-09-26T01:00:00.000Z,Wrong tech")).toBe(true)
    expect(rows[2].startsWith("14,recorded,opening balance,Arthur,,,590.90,924884")).toBe(true)
  })
})
