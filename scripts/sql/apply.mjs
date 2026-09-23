// Runs one SQL file against DATABASE_URL inside a single transaction.
// Usage: node scripts/sql/apply.mjs scripts/sql/<file>.sql
import { readFileSync } from "node:fs"
import pg from "pg"

const file = process.argv[2]
if (!file) {
  console.error("usage: node scripts/sql/apply.mjs <file.sql>")
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}

const sql = readFileSync(file, "utf8")
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await client.connect()
try {
  await client.query("begin")
  await client.query(sql)
  await client.query("commit")
  console.log(`applied ${file}`)
} catch (err) {
  await client.query("rollback")
  console.error(`failed ${file}: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  await client.end()
}
