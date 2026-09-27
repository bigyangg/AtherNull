-- Phase 4D.1 — Real Usage Metering Foundation.
--
-- usage_events (0002_platform_tables.sql) has existed since Phase 1 but has
-- had zero writers anywhere in the codebase (confirmed by full-repo grep,
-- twice, across this phase's own audit passes: only leftJoin/coalesce
-- readers exist in apps/api/src/routes/usage.ts and jobs.ts, both
-- permanently computing 0 because no row has ever been inserted). Confirmed
-- empty by direct `select count(*) from usage_events` against BOTH the real
-- athernull_dev and athernull_test Postgres databases immediately before
-- writing this migration (0 rows in each — see this phase's delivery report
-- for the exact commands run). Because the table is genuinely empty, the
-- destructive parts below (dropping `tokens`, making `cost_minor` nullable)
-- are pure schema changes with no existing data to lose or reinterpret, and
-- the additive NOT NULL columns below need no backfill.
--
-- This migration wires the table up for real usage measurement, and nothing
-- beyond measurement: no pricing/rate-card logic is implemented here (that's
-- Phase 4D.2's job — apps/api/src/pricing/rates.ts's RATE_CONFIG is still
-- null), no credits/funding/reservations/enforcement of any kind.

-- Additive uniqueness needed for the new composite FKs below. Confirmed
-- neither already exists before adding it:
--   - executions has no unique constraint on (id, task_id) — 0002 only has
--     unique(task_id, attempt_id).
--   - tasks has no unique constraint on (id, project_id, organization_id) —
--     0010_task_provenance.sql's tasks_project_id_organization_id_unique is,
--     despite its name, a FOREIGN KEY (tasks.project_id, tasks.organization_id
--     -> projects.id, projects.organization_id), not a UNIQUE constraint on
--     tasks itself, so it does not satisfy what a composite FK *referencing*
--     tasks(id, project_id, organization_id) requires.
alter table executions add constraint executions_id_task_id_unique unique (id, task_id);
alter table tasks add constraint tasks_id_project_id_organization_id_unique unique (id, project_id, organization_id);

-- Tenant/provenance attribution columns. executions itself carries no
-- organization_id/project_id (confirmed by direct inspection of
-- 0002_platform_tables.sql) — attribution routes through tasks, which has
-- both. These are derived and set server-side by apps/api's ingestion
-- handler (apps/api/src/usage-events.ts) from the trusted
-- execution_id -> task_id -> project_id/organization_id chain that already
-- exists at claim time — never accepted as worker-supplied input. Precedent:
-- `artifacts` (0002_platform_tables.sql) already carries both
-- organization_id AND execution_id directly, predating even Phase 4A.
alter table usage_events add column task_id uuid not null;
alter table usage_events add column project_id uuid not null;
alter table usage_events add column organization_id uuid not null;

alter table usage_events add constraint usage_events_execution_task_fkey
    foreign key (execution_id, task_id) references executions (id, task_id);
alter table usage_events add constraint usage_events_task_project_org_fkey
    foreign key (task_id, project_id, organization_id) references tasks (id, project_id, organization_id);

create index on usage_events (task_id);
create index on usage_events (organization_id);

-- Runtime provider/model identity, persisted verbatim (never normalized into
-- a rate-card identifier — that's Phase 4D.2's job entirely). `model` already
-- existed; `provider` is new so "nvidia_nim" and "nvidia/nemotron-..." are
-- two distinct columns, never re-derived from one concatenated string.
alter table usage_events add column provider text not null;

-- Raw per-response token categories exactly as the OpenHands SDK's
-- Telemetry._record_usage extracts them (workers/coding-agent/.venv/.../
-- openhands/sdk/llm/utils/telemetry.py) — never a manufactured category; 0
-- only where the SDK's own extraction logic already defaults to 0 (its
-- `getattr(..., 0) or 0` patterns for cache_read/cache_write/reasoning).
-- total_tokens is derived server-side at insert time (apps/api/src/
-- usage-events.ts) as input_tokens + output_tokens: LiteLLM's ModelResponse
-- carries a raw usage.total_tokens on the wire, but by the time usage
-- reaches ConversationStats via conversation.stats polling it has already
-- been re-extracted into a TokenUsage record (openhands/sdk/llm/utils/
-- metrics.py), which has no total field at all — so there is no
-- provider-returned total surviving to this point, and exactly one explicit
-- formula is used instead. input_tokens + output_tokens (not also adding
-- cache_read/cache_write/reasoning) matches metrics.py's own
-- cache_hit_rate comment, which documents that litellm/OpenAI-compatible
-- providers (NVIDIA NIM is OpenAI-compatible) count cache reads *inside*
-- prompt_tokens as a sub-category, not additively; reasoning_tokens are
-- likewise a documented sub-category of completion_tokens per OpenAI's own
-- completion_tokens_details convention.
alter table usage_events add column input_tokens integer not null;
alter table usage_events add column output_tokens integer not null;
alter table usage_events add column cache_read_tokens integer not null default 0;
alter table usage_events add column cache_write_tokens integer not null default 0;
alter table usage_events add column reasoning_tokens integer not null default 0;
alter table usage_events add column total_tokens integer not null;

-- Time semantics. No genuine provider-side completion timestamp survives
-- into TokenUsage/ConversationStats by the time the worker polls
-- conversation.stats: LiteLLM's ModelResponse.created (a real Unix
-- timestamp) exists on the raw response object, but
-- Telemetry._record_usage never carries it into the TokenUsage it appends to
-- Metrics.token_usages (confirmed by reading telemetry.py's exact
-- extraction code) — so there is no trustworthy occurrence timestamp to
-- name occurred_at. observed_at instead records when AtherNull's worker
-- polled and first saw this usage record — an honest, weaker claim.
-- recorded_at is the separate DB-insert-time column, mirroring
-- execution_events' existing occurred_at/created_at split
-- (apps/api/src/execution-events.ts).
alter table usage_events add column observed_at timestamptz not null default now();
alter table usage_events rename column created_at to recorded_at;

-- Pricing. No rate card exists yet (apps/api/src/pricing/rates.ts's
-- RATE_CONFIG is null) — every row this phase writes is UNPRICED, with
-- cost_minor/currency/rate_version all NULL together. NULL, never 0: a
-- monetary unknown must never be represented as a real, deterministic zero.
-- cost_minor is safe to make nullable (no historical NOT NULL value is
-- being reinterpreted — confirmed zero existing rows above). The check
-- constraint makes "half-priced" rows (e.g. a cost with no currency)
-- impossible by construction, the same pattern 0010_task_provenance.sql
-- used for tasks_provenance_paired.
alter table usage_events alter column cost_minor drop not null;
alter table usage_events add column pricing_status text not null default 'UNPRICED'
    check (pricing_status in ('UNPRICED', 'PRICED'));
alter table usage_events add column currency text;
alter table usage_events add column rate_version text;
alter table usage_events add constraint usage_events_pricing_consistency check (
    (pricing_status = 'UNPRICED' and cost_minor is null and currency is null and rate_version is null)
    or
    (pricing_status = 'PRICED' and cost_minor is not null and currency is not null and rate_version is not null)
);

-- `tokens` (a single undifferentiated count, the only token-shaped column
-- this table had before this phase) is superseded by the raw per-category
-- columns above — dropped, not kept alongside, since keeping both would
-- invent a second, disagreeing definition of "how many tokens" with no
-- caller ever populating it consistently. Safe: confirmed zero existing
-- rows, and every current reader (apps/api/src/routes/usage.ts, jobs.ts)
-- was grep-audited to confirm neither ever reads `tokens` — both only ever
-- read cost_minor.
alter table usage_events drop column tokens;
