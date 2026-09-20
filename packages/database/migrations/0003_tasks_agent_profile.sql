-- Phase 1 (core job engine): tasks needs to remember which agent profile it
-- was created with so the claim-time router (ADR-0003) knows which
-- model_tiers ladder to use. CreateJobRequestSchema already requires
-- agentProfileId on job creation; this column is where it's persisted.
alter table tasks
    add column agent_profile_id uuid not null references agent_profiles(id);

create index on tasks (agent_profile_id);
