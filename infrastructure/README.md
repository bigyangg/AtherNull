# infrastructure

Local dev: `docker-compose.yml` gives you Postgres + Redis. Postgres is on host port **5433**, not
the default 5432 — this dev machine already runs an unrelated project's Postgres container bound to
5432, confirmed via `docker ps` before this compose file was written. Check before assuming 5432 is
free on any machine this gets run on. Redis stays on its default 6379. Nothing here is the
production topology.

For the real deployment (existing Coolify-managed VPS + separate worker infrastructure), follow the
safe rollout checklist in the spec (§6) before creating anything:

- Inventory existing containers, volumes, free disk and available RAM before deploying.
- Take and test off-server backups of affected systems.
- Create a new Coolify project and unique volumes. Do not reuse client credentials.
- Never run a host-wide prune or volume deletion as a convenience step.
- Roll back AtherNull containers by project only; check health before exposing public traffic.

Coolify project config, monitoring config and the worker-host setup (ADR-002 sandbox choice) land
here once Phase 0/3 decisions are made — see PLAN.md.
