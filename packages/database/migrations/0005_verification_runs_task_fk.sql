-- Links verification_runs (0002_platform_tables.sql) to the task/execution it
-- was recorded against — it had no FK to either, so nothing could look up
-- "what was the outcome for this task" (needed by POST /v1/jobs/:id/verify
-- and GET /v1/jobs/:id). artifact_hash is relaxed to nullable since there is
-- no artifact pipeline wired up yet; a manual verification pass (this
-- pass's stand-in for Phase 4's real independent verifier) has no hash to
-- supply.
alter table verification_runs
    add column task_id      uuid references tasks(id),
    add column execution_id uuid references executions(id);

alter table verification_runs
    alter column artifact_hash drop not null;

create index on verification_runs (task_id);
create index on verification_runs (execution_id);
