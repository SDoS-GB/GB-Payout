import pg from "pg"
const { Client } = pg
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const { rows } = await db.query("select value from app_settings where key = 'workiz'")
await db.end()
const s = rows[0].value
const base = `https://api.workiz.com/api/v1/${encodeURIComponent(s.apiToken)}`
const get = async () => (await (await fetch(`${base}/job/get/CC6YKK/`)).json()).data
const post = async (body) => (await fetch(`${base}/job/update/`, { method: "POST", headers: { "Content-Type": "application/json", api_secret: s.apiSecret }, body: JSON.stringify({ auth_secret: s.apiSecret, ...body }) })).json()
const before = await get()
const b = Array.isArray(before) ? before[0] : before
const orig = b.JobNotes ?? ""
console.log("before JobNotes:", JSON.stringify(orig), "| Comments:", JSON.stringify(b.Comments ?? ""))
const marker = `${orig}${orig ? "\n\n" : ""}--- GB PAYOUT PROBE ---\nline two`
const r1 = await post({ UUID: "CC6YKK", JobNotes: marker })
console.log("update ->", JSON.stringify(r1))
const mid = await get(); const m = Array.isArray(mid) ? mid[0] : mid
console.log("after  JobNotes:", JSON.stringify(m.JobNotes), "| Tags:", JSON.stringify(m.Tags), "| Status:", m.Status, "| LastStatusUpdate:", m.LastStatusUpdate)
const r2 = await post({ UUID: "CC6YKK", JobNotes: orig })
console.log("restore ->", JSON.stringify(r2))
const end = await get(); const e = Array.isArray(end) ? end[0] : end
console.log("restored JobNotes:", JSON.stringify(e.JobNotes), "| LastStatusUpdate:", e.LastStatusUpdate)
