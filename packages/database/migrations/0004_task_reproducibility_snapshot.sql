-- Phase 1 (core job engine): a task must stay reproducible after creation —
-- later execution needs to prove exactly what was approved. CreateJobRequestSchema
-- already required repositoryRevision on job creation, but nothing persisted it;
-- and agent_profiles.config_revision/policy_version can change after a task
-- references it, so those must be snapshotted at approval time too, not read
-- live off agent_profiles when a task is later claimed/executed.
alter table tasks
    add column repository_revision text not null,
    add column agent_profile_config_revision integer not null,
    add column agent_policy_version text not null;
