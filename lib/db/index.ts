import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema"

declare global {
  // Reuse the pool across hot reloads in development so we do not leak connections.
  var __gbPayoutPool: Pool | undefined
}

export const pool =
  globalThis.__gbPayoutPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    // Without these, an unreachable database leaves page renders hanging until the
    // platform kills the request. Failing fast lets the /admin error boundary offer
    // Retry / Sign out instead of an endless spinner.
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    idleTimeoutMillis: 30_000,
  })

if (process.env.NODE_ENV !== "production") {
  globalThis.__gbPayoutPool = pool
}

export const db = drizzle(pool, { schema })
export { schema }
