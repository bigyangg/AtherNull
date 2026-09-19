import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { Pool } from "pg";

// ADR-0004 (docs/adr/0004-better-auth-for-identity.md): Better Auth owns the
// identity schema (organization/member/invitation/user/session), generated
// via its own CLI into packages/database/migrations/0001_better_auth_schema.sql
// — never hand-edited. Every other table's organization_id/owner references
// point at what this generates.
export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  advanced: {
    database: {
      // Every hand-written table already uses `uuid primary key default
      // gen_random_uuid()` — match that instead of Better Auth's default
      // base62 string ids, so foreign keys stay a plain `uuid` column.
      generateId: "uuid",
    },
  },
  plugins: [organization()],
});
