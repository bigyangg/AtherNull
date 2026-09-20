import type { Database } from "@athernull/database";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

// Separate Pool from Better Auth's own (auth.ts) — different consumer,
// different lifecycle, and Better Auth owns its pool internally anyway.
// Same DATABASE_URL, same Postgres instance.
export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  }),
});
