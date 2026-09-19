# apps/api

Core API. Owns: identity, authorization, projects, tasks, acceptance requests, public API (spec §3).
Must not own: executing arbitrary customer code.

Identity is handled by Better Auth, mounted at `/api/auth/*` (see `src/auth.ts`,
`docs/adr/0004-better-auth-for-identity.md`). No sign-in method is enabled yet — that's a separate
decision. Copy `.env.example` to `.env` and point `DATABASE_URL` at a running Postgres (see
`infrastructure/README.md`) before starting the server.

Beyond `/health` and `/api/auth/*`, the job engine itself still hasn't landed — that's Phase 1.
