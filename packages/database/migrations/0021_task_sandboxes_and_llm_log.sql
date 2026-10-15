-- Phase 2: Per-task sandbox isolation and LLM proxy usage logging
-- Depends on 0002_platform_tables.sql (org_agent_servers, tasks, etc.)

-- Per-task sandbox tracking
create table task_sandboxes (
    task_id                 uuid primary key references tasks(id) on delete cascade,
    organization_id         uuid not null references "organization"(id),
    project_id              uuid not null references projects(id),
    container_name          text not null,
    base_url                text not null,
    session_api_key         text not null,
    network_name            text not null,
    volume_name             text not null,
    status                  text not null default 'PROVISIONING', -- PROVISIONING, READY, DECOMMISSIONING, DECOMMISSIONED
    created_at              timestamptz not null default now(),
    ready_at                timestamptz,
    decommissioned_at       timestamptz
);
create index on task_sandboxes (organization_id);
create index on task_sandboxes (project_id);
create index on task_sandboxes (status);

-- LLM usage logging for audit trail and rate limiting
create table llm_usage_log (
    id                      uuid primary key default gen_random_uuid(),
    task_id                 uuid not null references tasks(id) on delete cascade,
    model                   text not null,
    prompt_tokens           integer not null default 0,
    completion_tokens       integer not null default 0,
    total_tokens            integer not null default 0,
    created_at              timestamptz not null default now()
);
create index on llm_usage_log (task_id);
create index on llm_usage_log (model);
create index on llm_usage_log (created_at);