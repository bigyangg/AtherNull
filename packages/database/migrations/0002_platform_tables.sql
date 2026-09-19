-- AtherNull platform schema (spec §5 "Data model and tenant isolation")
-- Depends on 0001_better_auth_schema.sql having run first: every
-- organization_id here references Better Auth's "organization" table, and
-- every person reference references its "user" table (ADR-0004) — this file
-- no longer defines identity itself.
-- Every tenant-scoped table carries organization_id; enforce membership checks
-- server-side on every read/write/download — never trust a client-supplied tenant ID.

create extension if not exists pgcrypto;

create table projects (
    id                    uuid primary key default gen_random_uuid(),
    organization_id       uuid not null references "organization"(id),
    permitted_repository  text not null,
    revision              text,
    scope                 text,
    owner_user_id         uuid not null references "user"(id),
    created_at            timestamptz not null default now()
);
create index on projects (organization_id);

create table agent_profiles (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references "organization"(id),
    -- Ordered cheapest/simplest -> most capable. Each element:
    -- { "tier": "fast", "model": "anthropic/claude-haiku-4-5-20251001",
    --   "maxComplexity": 0.33, "costCeilingMinor": 50 }
    -- See ADR-0003 (docs/adr/0003-cost-complexity-model-routing.md).
    model_tiers      jsonb not null,
    policy_version   text not null,
    tool_allowlist   jsonb not null default '[]',
    config_revision  integer not null default 1,
    created_at       timestamptz not null default now(),
    constraint agent_profiles_model_tiers_nonempty check (jsonb_array_length(model_tiers) > 0)
);
create index on agent_profiles (organization_id);

create table tasks (
    id                  uuid primary key default gen_random_uuid(),
    organization_id     uuid not null references "organization"(id),
    project_id          uuid not null references projects(id),
    requirements        text not null,
    acceptance_criteria jsonb not null default '[]',
    max_budget_minor    bigint not null,
    currency            text not null,
    status              text not null default 'CREATED',
    version             integer not null default 1,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index on tasks (organization_id);
create index on tasks (status);

create table executions (
    id           uuid primary key default gen_random_uuid(),
    task_id      uuid not null references tasks(id),
    attempt_id   uuid not null default gen_random_uuid(),
    lease_owner  text,
    lease_expires_at timestamptz,
    sandbox_id   text,
    status       text not null default 'PENDING',
    -- Model routing decision made at dispatch time (ADR-0003) — recorded so a
    -- surprising model choice is auditable, never a silent runtime guess.
    routing_tier   text,
    routing_score  numeric,
    routing_reason text,
    resolved_model text,
    started_at   timestamptz,
    ended_at     timestamptz,
    created_at   timestamptz not null default now()
);
create index on executions (task_id);
create unique index on executions (task_id, attempt_id);

create table usage_events (
    id                uuid primary key default gen_random_uuid(),
    execution_id      uuid not null references executions(id),
    provider_request_id text not null,
    model             text not null,
    tokens            integer not null,
    cost_minor        bigint not null,
    created_at        timestamptz not null default now(),
    unique (execution_id, provider_request_id)
);
create index on usage_events (execution_id);

create table artifacts (
    id               uuid primary key default gen_random_uuid(),
    organization_id  uuid not null references "organization"(id),
    execution_id     uuid not null references executions(id),
    object_key       text not null,
    content_hash     text not null,
    type             text not null,
    access_policy    text not null default 'tenant-private',
    created_at       timestamptz not null default now()
);
create index on artifacts (organization_id);
create index on artifacts (execution_id);

create table verification_runs (
    id              uuid primary key default gen_random_uuid(),
    artifact_hash   text not null,
    verifier_version text not null,
    tests           jsonb not null default '[]',
    outcome         text not null,
    evidence        jsonb not null default '{}',
    created_at      timestamptz not null default now()
);
create index on verification_runs (artifact_hash);

create table payment_intents (
    id              uuid primary key default gen_random_uuid(),
    job_id          uuid not null references tasks(id),
    chain           text not null,
    asset           text not null,
    amount_minor    bigint not null,
    actor            text not null,
    idempotency_key text not null unique,
    chain_reference text,
    status          text not null default 'PENDING',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index on payment_intents (job_id);

create table audit_events (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid not null references "organization"(id),
    actor           text not null,
    operation       text not null,
    object_type     text not null,
    object_id       text not null,
    before_state    jsonb,
    after_state     jsonb,
    created_at      timestamptz not null default now()
);
create index on audit_events (organization_id);
-- append-only: no update/delete grants on this table for application roles.
