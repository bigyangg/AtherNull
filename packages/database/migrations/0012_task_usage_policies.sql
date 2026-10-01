-- Phase 4D.2A — Operational Usage Limits + Pause/Resume.
--
-- This is a SOFT, POST-RESPONSE operational token limit, never a hard limit,
-- spend limit, monetary budget enforcement, dollar ceiling, or funded
-- balance: "After observed cumulative token usage reaches or exceeds the
-- configured usage limit, AtherNull pauses the execution at the next safe
-- OpenHands step boundary." One already-in-flight response/step may cause
-- overshoot — this schema always stores the REAL observed value, never
-- clamped down to the configured limit (see task_usage_pauses.observed_usage
-- below).
--
-- Zero monetary coupling: nothing in this migration touches
-- project_budget_authorizations, payment_intents, cost_minor, or
-- usage_events' pricing columns. `metric` is presently constrained to
-- TOTAL_LLM_TOKENS only (packages/contracts/src/usage-policies.ts's single
-- shared definition: input_tokens + output_tokens, matching
-- usage_events.total_tokens exactly — see 0011_usage_metering.sql's own
-- comment for why cache/reasoning categories are sub-categories, never
-- additive).

-- Reused, not duplicated: tasks(id, project_id, organization_id) is already
-- unique (tasks_id_project_id_organization_id_unique, added by
-- 0011_usage_metering.sql) — both composite FKs below reference it directly.

create table task_usage_policies (
    id                  uuid primary key default gen_random_uuid(),

    organization_id     uuid not null references "organization"(id),
    project_id          uuid not null references projects(id),
    task_id             uuid not null,
    foreign key (task_id, project_id, organization_id) references tasks (id, project_id, organization_id),

    -- Groups every revision of "the same task's usage policy" together —
    -- same lineage/version convention as project_estimates
    -- (0008_project_estimates.sql). version is 1-based and monotonic within
    -- a lineage.
    lineage_id          uuid not null,
    version             integer not null check (version > 0),

    -- Only TOTAL_LLM_TOKENS exists in this phase — the check constraint
    -- makes any other metric impossible by construction, not just convention.
    metric              text not null check (metric in ('TOTAL_LLM_TOKENS')),
    limit_quantity      bigint not null check (limit_quantity > 0),
    status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUPERSEDED')),

    -- Corrections chain: null for the first policy on a task, otherwise
    -- points at the row this one replaces. Historical rows are NEVER updated
    -- in place — an extension is always a new row (correction 5: only
    -- increases allowed; enforced at the application layer in
    -- apps/api/src/usage-policies.ts, not by a DB check, since the DB has no
    -- access to "the row being superseded" at insert time).
    supersedes_id       uuid references task_usage_policies(id),

    authorized_by       uuid not null references "user"(id),
    authorized_at       timestamptz not null default now(),
    created_at          timestamptz not null default now()
);

create index on task_usage_policies (task_id);
create index on task_usage_policies (organization_id);

-- At most one ACTIVE policy per task — mirrors
-- project_budget_authorizations_one_active_per_estimate's exact pattern
-- (0009_project_budget_authorizations.sql).
create unique index task_usage_policies_one_active_per_task
    on task_usage_policies (task_id) where status = 'ACTIVE';

create unique index task_usage_policies_lineage_version_unique
    on task_usage_policies (lineage_id, version);

-- Additive uniqueness needed for task_usage_pauses' policy/organization
-- pairing FK below — tenant integrity: the policy's own organization_id must
-- equal a pause row's organization_id, the same pairing-FK idiom
-- project_budget_authorizations already uses for its estimate/organization
-- pair (0009_project_budget_authorizations.sql).
alter table task_usage_policies add constraint task_usage_policies_id_organization_id_unique unique (id, organization_id);
alter table task_usage_policies add constraint task_usage_policies_id_task_unique unique (id, task_id);
alter table task_usage_policies add constraint task_usage_policies_supersedes_task_fk
    foreign key (supersedes_id, task_id) references task_usage_policies (id, task_id);

-- Pause records. observed_usage is the REAL, possibly-over-the-configured-
-- limit number — this table has no mechanism to clamp it and must never gain
-- one (see this migration's header comment on overshoot honesty).
create table task_usage_pauses (
    id                  uuid primary key default gen_random_uuid(),

    organization_id     uuid not null references "organization"(id),
    project_id          uuid not null references projects(id),
    task_id             uuid not null,
    foreign key (task_id, project_id, organization_id) references tasks (id, project_id, organization_id),

    -- Reused, not duplicated: executions(id, task_id) is already unique
    -- (executions_id_task_id_unique, 0011_usage_metering.sql).
    execution_id        uuid not null,
    foreign key (execution_id, task_id) references executions (id, task_id),

    policy_id           uuid not null references task_usage_policies(id),
    foreign key (policy_id, organization_id) references task_usage_policies (id, organization_id),
    foreign key (policy_id, task_id) references task_usage_policies (id, task_id),

    metric              text not null check (metric in ('TOTAL_LLM_TOKENS')),
    configured_limit    bigint not null check (configured_limit > 0),
    observed_usage      bigint not null check (observed_usage >= 0),

    -- Distinguishes exactly how the execution was stopped (correction 8):
    -- never tell the UI a conversation is resumable if it structurally isn't.
    enforcement_action  text not null check (enforcement_action in ('PAUSE', 'INTERRUPT')),
    resume_mode         text not null check (resume_mode in ('SAME_EXECUTION', 'NEW_ATTEMPT')),

    paused_at           timestamptz not null default now(),
    resumed_at          timestamptz,
    resume_execution_id uuid,
    foreign key (resume_execution_id, task_id) references executions (id, task_id),
    check (enforcement_action <> 'INTERRUPT' or resume_mode = 'NEW_ATTEMPT'),
    created_at          timestamptz not null default now()
);

create index on task_usage_pauses (task_id);
create index on task_usage_pauses (execution_id);

-- Idempotency guard's DB-level backstop (correction 10a/11): at most one
-- OPEN (unresolved) pause per execution. The application-level guard
-- (worker-side "enforcement already attempted" flag, apps/api's
-- transactional insert) is the primary defense; this is the last-resort
-- safety net so a genuine race can never produce two open pause rows for the
-- same execution, exactly like every other *_one_active_per_* index in this
-- codebase.
create unique index task_usage_pauses_one_open_per_execution
    on task_usage_pauses (execution_id) where resumed_at is null;

-- Correction 12 — enforcement-failure reason. Deliberately NOT a new
-- TaskStatus: when both conversation.pause() and conversation.interrupt()
-- fail, the execution/task fail through the EXISTING RUNNING -> FAILED
-- semantics (routes/internal.ts's /complete), and this column is the sole
-- durable, machine-readable record of *why* (the literal string
-- 'USAGE_ENFORCEMENT_FAILED', set only by that fail-closed path — never
-- populated for an ordinary agent failure). Nullable and free-text (no CHECK
-- constraint), matching executions.status's own existing free-text
-- convention noted in this phase's audit.
alter table executions add column failure_reason text;
