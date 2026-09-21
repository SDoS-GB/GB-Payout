import pg from "pg"
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const { rows } = await db.query("select value from app_settings where key = 'workiz'")
await db.end()
const s = rows[0].value
console.log(JSON.stringify({ tokenLen: s.apiToken.length, tokenPrefix: s.apiToken.slice(0,4), secretLen: (s.apiSecret||"").length, hasWs: /\s/.test(s.apiToken) }))
for (const path of ["job/get/CC6YKK/", "job/get/CC6YKK", "team/all/"]) {
  const res = await fetch(`https://api.workiz.com/api/v1/${s.apiToken}/${path}`, { headers: { Accept: "application/json", "User-Agent": "gb-payout-probe" } })
  const text = await res.text()
  console.log(path, "->", res.status, "len", text.length, text.slice(0, 120).replace(/\s+/g, " "))
}
