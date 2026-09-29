import { PGlite } from "@electric-sql/pglite"
import { is, SQL, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/pglite"
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core"
import * as schema from "@/lib/db/schema"

// In-memory PostgreSQL only: no DATABASE_URL, production records, or provider calls.
export const testPostgres = new PGlite()
export const testDatabase = drizzle(testPostgres, { schema })
const tables: PgTable[] = Object.values(schema).filter((value) => is(value, PgTable))
const dialect = new PgDialect()
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const render = (value: SQL) => dialect.sqlToQuery(value.inlineParams()).sql

export async function initializeTestDatabase() {
  for (const table of tables) {
    const config = getTableConfig(table)
    const columns = config.columns.map((column) => {
      const defaultValue = column.default === undefined ? "" : ` default ${is(column.default, SQL) ? render(column.default) : render(sql`${column.mapToDriverValue(column.default)}`)}`
      return `${quote(column.name)} ${column.getSQLType()}${column.primary ? " primary key" : ""}${column.notNull ? " not null" : ""}${column.isUnique ? " unique" : ""}${defaultValue}`
    })
    await testPostgres.exec(`create table ${quote(config.name)} (${columns.join(", ")})`)
    for (const index of config.indexes) {
      const { name, unique, columns: indexed, where } = index.config
      const names = indexed.map((column) => {
        if (!("name" in column) || !column.name) throw new Error("The test harness requires named index columns")
        return quote(column.name)
      })
      await testPostgres.exec(`create ${unique ? "unique " : ""}index ${quote(name!)} on ${quote(config.name)} (${names.join(", ")})${where ? ` where ${render(where)}` : ""}`)
    }
  }
}

export async function resetTestDatabase() {
  await testPostgres.exec(`truncate ${tables.map((table) => quote(getTableConfig(table).name)).join(", ")} restart identity`)
}
