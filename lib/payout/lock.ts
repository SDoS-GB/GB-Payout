import { sql } from "drizzle-orm"
import type { Database } from "@/lib/db"

export async function lockPayoutJob(database: Database, uuid: string) {
  // Every ingestion and outbound snapshot check takes this same transaction-scoped lock.
  // Different jobs proceed independently; a rollback releases it automatically.
  await database.execute(sql`select pg_advisory_xact_lock(hashtext('gb-payout'), hashtext(${uuid}))`)
}
