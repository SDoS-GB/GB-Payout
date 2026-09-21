import pg from "pg"
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const { rows } = await db.query("select value from app_settings where key = 'workiz'")
await db.end()
const s = rows[0].value
for (const path of ["job/get/16MEBD/", "job/get/CC6YKK/", "job/get/NOPE123/"]) {
  const res = await fetch(`https://api.workiz.com/api/v1/${s.apiToken}/${path}`, { headers: { Accept: "application/json" } })
  const text = await res.text()
  let j = null; try { j = JSON.parse(text) } catch {}
  const d = j?.data && (Array.isArray(j.data) ? j.data[0] : j.data)
  console.log(path, "->", res.status, "len", text.length, d ? `#${d.SerialId} ${d.Status} tags=${JSON.stringify(d.Tags)} notes=${JSON.stringify(d.JobNotes)}` : text.slice(0, 120))
}
