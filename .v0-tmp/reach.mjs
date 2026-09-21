import pg from "pg"
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const { rows } = await db.query("select value from app_settings where key = 'workiz'")
await db.end()
const s = rows[0].value
const res = await fetch(`https://api.workiz.com/api/v1/${encodeURIComponent(s.apiToken)}/job/get/CC6YKK/`, { headers: { Accept: "application/json" } })
const text = await res.text()
console.log("status", res.status, "len", text.length, "ct", res.headers.get("content-type"))
console.log(text.slice(0, 300))
