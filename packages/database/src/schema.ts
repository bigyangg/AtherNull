import type { ColumnType, Generated } from "kysely";

// Typed from packages/database/migrations/0002_platform_tables.sql +
// 0003_tasks_agent_profile.sql + 0004_task_reproducibility_snapshot.sql. Only
// the tables apps/api's Phase 1 job engine touches are represented here — add
// more as more of the platform gets a typed query path. Types only, no
// connection/pool code, so importing this never pulls in a runtime DB
// dependency for callers that just need the shape.
//
// ColumnType's three params are (select, insert, update) — used directly
// (not nested inside Generated<>, which would double-wrap it) so a
// timestamptz column can be selected as Date but written as Date | string.
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface ProjectsTable {
  id: Generated<string>;
  organization_id: string;
  permitted_repository: string;
  revision: string | null;
  scope: string | null;
  owner_user_id: string;
  created_at: Timestamp;
}

export interface AgentProfilesTable {
  id: Generated<string>;
  organization_id: string;
  model_tiers: unknown; // jsonb — validate with ModelTierSchema.array() on read
  policy_version: string;
  tool_allowlist: Generated<unknown>; // jsonb, default '[]'
  config_revision: Generated<number>;
  created_at: Timestamp;
}

export interface TasksTable {
  id: Generated<string>;
  organization_id: string;
  project_id: string;
  agent_profile_id: string;
  // Snapshotted at job creation (0004_task_reproducibility_snapshot.sql), not
  // read live off agent_profiles — that table can change after a task
  // references it, and a task must stay reproducible against what was
  // actually approved.
  repository_revision: string;
  agent_profile_config_revision: number;
  agent_policy_version: string;
  requirements: string;
  acceptance_criteria: Generated<unknown>; // jsonb, default '[]'
  max_budget_minor: string; // bigint — Kysely/pg returns bigint as string by default
  currency: string;
  status: Generated<string>; // TaskStatus (packages/contracts) — text column, no DB-level enum
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  // Phase 4C — provenance-bound task creation (0010_task_provenance.sql).
  // Both null for every historical task created before this phase (legacy
  // /v1/jobs path, or any task predating provenance tracking); both set,
  // never one alone (tasks_provenance_paired), for every task created via
  // the canonical POST /v1/projects/:projectId/tasks/from-budget-authorization
  // endpoint. Immutable once set — never included in any updateTable("tasks")
  // call site, exactly like max_budget_minor/currency.
  source_estimate_id: string | null;
  source_budget_authorization_id: string | null;
}

export interface ExecutionsTable {
  id: Generated<string>;
  task_id: string;
  attempt_id: Generated<string>;
  lease_owner: string | null;
  lease_expires_at: NullableTimestamp;
  sandbox_id: string | null;
  // The OpenHands Agent Server's own conversation id for this execution
  // (0006_execution_conversation_id.sql) — set once the coding-agent worker's
  // agent_server_adapter.py creates the conversation, before .run() starts.
  conversation_id: string | null;
  status: Generated<string>;
  routing_tier: string | null;
  routing_score: number | null;
  routing_reason: string | null;
  resolved_model: string | null;
  started_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface UsageEventsTable {
  id: Generated<string>;
  execution_id: string;
  provider_request_id: string;
  model: string;
  tokens: number;
  cost_minor: string;
  created_at: Timestamp;
}

// The Agent Server's own event stream for an execution
// (0007_execution_events.sql) — id is the OpenHands event's own uuid, not
// generated here, so replayed/duplicate forwards are a plain upsert.
export interface ExecutionEventsTable {
  id: string;
  execution_id: string;
  kind: string;
  payload: unknown; // jsonb — shape is whatever the Agent Server's event kind carries
  occurred_at: Timestamp;
  created_at: Timestamp;
}

export interface VerificationRunsTable {
  id: Generated<string>;
  // Nullable: 0005_verification_runs_task_fk.sql added these after the table
  // already existed, and legacy rows (from before any task/execution link
  // existed) never had them.
  task_id: string | null;
  execution_id: string | null;
  artifact_hash: string | null; // no artifact pipeline wired up yet (0005)
  verifier_version: string;
  tests: Generated<unknown>; // jsonb, default '[]'
  outcome: string;
  evidence: Generated<unknown>; // jsonb, default '{}'
  created_at: Timestamp;
}

export interface PaymentIntentsTable {
  id: Generated<string>;
  job_id: string;
  chain: string;
  asset: string;
  amount_minor: string;
  actor: string;
  idempotency_key: string;
  chain_reference: string | null;
  status: Generated<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// Phase 4A — project scope/build-plan/cost-estimate lineage
// (0008_project_estimates.sql). lineage_id groups every revision of "the
// same estimate" together; version is 1-based and monotonic within a
// lineage (project_estimates_lineage_version_unique). status/pricing_status
// are typed as `string` here (same convention as TasksTable.status) — see
// packages/contracts/src/estimates.ts for the real enum.
export interface ProjectEstimatesTable {
  id: Generated<string>;
  lineage_id: string;
  version: number;
  status: Generated<string>; // EstimateStatus (packages/contracts) — text column, no DB-level enum
  organization_id: string;
  project_id: string;
  source_prompt: string;
  planner_output: unknown; // jsonb — validate with PlannerOutputSchema on read
  planner_model: string;
  pricing_status: Generated<string>; // "UNPRICED" | "PRICED"
  currency: string | null;
  estimated_min_minor: string | null; // bigint — Kysely/pg returns bigint as string by default
  estimated_max_minor: string | null;
  proposed_budget_cap_minor: string | null;
  pricing_breakdown: unknown; // jsonb | null
  rate_version: string | null;
  created_by: string;
  created_at: Timestamp;
  approved_by: string | null;
  approved_at: NullableTimestamp;
}

// Phase 4B — authorized project budget (0009_project_budget_authorizations.sql).
// One row per authorized amount against an EXACT project_estimates row
// (estimate_id, not lineage_id) — no inheritance across estimate versions.
// At most one ACTIVE row per estimate_id
// (project_budget_authorizations_one_active_per_estimate); a correction
// supersedes the prior ACTIVE row (status -> SUPERSEDED) and inserts a new
// ACTIVE row with supersedes_id pointing back at it, in the same
// transaction. Historical rows (amount_minor/currency/source/authorized_by/
// authorized_at) are never mutated once superseded.
export interface ProjectBudgetAuthorizationsTable {
  id: Generated<string>;
  organization_id: string;
  project_id: string;
  estimate_id: string;
  estimate_lineage_id: string;
  estimate_version: number;
  amount_minor: string; // bigint — Kysely/pg returns bigint as string by default
  currency: string;
  source: Generated<string>; // "ESTIMATE_PROPOSED_CAP" | "USER_SET" (packages/contracts) — text column, no DB-level enum
  // "ACTIVE" | "SUPERSEDED" | "CONSUMED" (Phase 4C adds CONSUMED — a
  // canonical task was created from this exact authorization; permanently
  // terminal, never reverts to ACTIVE, never superseded again).
  status: Generated<string>;
  supersedes_id: string | null;
  authorized_by: string;
  authorized_at: Timestamp;
  created_at: Timestamp;
}

// Better Auth's own table (0001_better_auth_schema.sql, camelCase columns —
// generated by its CLI, not this project's convention). Only typed here
// far enough to read a user's organization membership; every other identity
// column is intentionally left untyped since nothing here owns that schema.
export interface MemberTable {
  id: Generated<string>;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Timestamp;
}

export interface Database {
  projects: ProjectsTable;
  agent_profiles: AgentProfilesTable;
  tasks: TasksTable;
  executions: ExecutionsTable;
  usage_events: UsageEventsTable;
  execution_events: ExecutionEventsTable;
  verification_runs: VerificationRunsTable;
  payment_intents: PaymentIntentsTable;
  member: MemberTable;
  project_estimates: ProjectEstimatesTable;
  project_budget_authorizations: ProjectBudgetAuthorizationsTable;
}
