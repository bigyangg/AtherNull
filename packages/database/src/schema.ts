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
  // Phase 4D.2A (0012_task_usage_policies.sql). Set only by the fail-closed
  // "both conversation.pause() and conversation.interrupt() failed" path
  // (routes/internal.ts's /complete, outcome: "failure") — the literal
  // string 'USAGE_ENFORCEMENT_FAILED'. Null for every ordinary failure. Free
  // text, no CHECK constraint, matching `status`'s own existing convention.
  failure_reason: string | null;
}

// Phase 4D.1 — real usage metering (0011_usage_metering.sql). Attribution
// (task_id/project_id/organization_id) is always derived server-side from
// the trusted execution_id -> task_id -> project_id/organization_id chain
// (apps/api/src/usage-events.ts) — never accepted as worker-supplied input.
// Raw token categories mirror the OpenHands SDK's TokenUsage fields exactly;
// total_tokens is derived server-side as input_tokens + output_tokens (see
// the migration's own comment for why). pricing_status is always 'UNPRICED'
// in this phase (cost_minor/currency/rate_version always null together,
// enforced by usage_events_pricing_consistency) — no rate card exists yet
// (apps/api/src/pricing/rates.ts's RATE_CONFIG is null). observed_at (not
// occurred_at) because no genuine provider-side completion timestamp
// survives into the data this table is populated from; recorded_at is the
// separate DB-insert-time column, mirroring execution_events'
// occurred_at/created_at split.
export interface UsageEventsTable {
  id: Generated<string>;
  execution_id: string;
  task_id: string;
  project_id: string;
  organization_id: string;
  provider_request_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: Generated<number>; // default 0
  cache_write_tokens: Generated<number>; // default 0
  reasoning_tokens: Generated<number>; // default 0
  total_tokens: number;
  pricing_status: Generated<string>; // "UNPRICED" | "PRICED" — always UNPRICED in this phase
  cost_minor: string | null; // bigint — Kysely/pg returns bigint as string by default; null iff UNPRICED
  currency: string | null;
  rate_version: string | null;
  observed_at: Timestamp;
  recorded_at: Timestamp;
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

// Phase 4D.2A — operational usage-limit policy (0012_task_usage_policies.sql).
// SOFT, POST-RESPONSE token limit — never monetary (see the migration's own
// header comment and docs/adr/0012-operational-usage-limits.md). At most one
// ACTIVE row per task_id (task_usage_policies_one_active_per_task); an
// extension supersedes the prior ACTIVE row and inserts a new one with
// supersedes_id pointing back at it, in the same transaction — mirrors
// ProjectBudgetAuthorizationsTable's exact correction pattern. Historical
// rows are never mutated once superseded. `metric` is typed as `string` here
// (same convention as TasksTable.status) — see
// packages/contracts/src/usage-policies.ts for the real enum
// (TOTAL_LLM_TOKENS only, in this phase).
export interface TaskUsagePoliciesTable {
  id: Generated<string>;
  organization_id: string;
  project_id: string;
  task_id: string;
  lineage_id: string;
  version: number;
  metric: string;
  limit_quantity: string; // bigint — Kysely/pg returns bigint as string by default
  status: Generated<string>; // "ACTIVE" | "SUPERSEDED"
  supersedes_id: string | null;
  authorized_by: string;
  authorized_at: Timestamp;
  created_at: Timestamp;
}

// Phase 4D.2A — durable pause record (0012_task_usage_policies.sql).
// observed_usage is the REAL, possibly-over-configured_limit value — never
// clamped (soft, post-response enforcement). At most one OPEN
// (resumed_at is null) row per execution_id
// (task_usage_pauses_one_open_per_execution) — the idempotency guard's
// DB-level backstop (correction 10a/11).
export interface TaskUsagePausesTable {
  id: Generated<string>;
  organization_id: string;
  project_id: string;
  task_id: string;
  execution_id: string;
  policy_id: string;
  metric: string;
  configured_limit: string; // bigint — Kysely/pg returns bigint as string by default
  observed_usage: string; // bigint — Kysely/pg returns bigint as string by default
  enforcement_action: string; // "PAUSE" | "INTERRUPT"
  resume_mode: string; // "SAME_EXECUTION" | "NEW_ATTEMPT"
  paused_at: Timestamp;
  resumed_at: NullableTimestamp;
  resume_execution_id: string | null;
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

// Phase 4E.1 — Solana devnet project funding (0013_project_funding.sql,
// ADR-0013). Integer lamports only (bigint -> string, like every other
// bigint column here). network/rpc_provider/asset_type are CHECK-constrained
// to devnet/helius/DEVNET_SOL by the database itself. Identity, provenance,
// requirement, and a bound customer_wallet are immutable (DB trigger).
export interface ProjectFundingAccountsTable {
  id: Generated<string>;
  organization_id: string;
  project_id: string;
  task_id: string;
  budget_authorization_id: string;
  network: string;
  rpc_provider: string;
  asset_type: string;
  program_id: string;
  onchain_account: string;
  binding_hash: Uint8Array; // bytea, 32 bytes
  customer_wallet: string | null;
  customer_bound_at: NullableTimestamp;
  requirement_source: string;
  required_amount_base_units: string;
  confirmed_amount_base_units: Generated<string>;
  status: Generated<string>; // AWAITING_FUNDS | PARTIALLY_FUNDED | FUNDED
  init_signature: string | null;
  init_sent_at: NullableTimestamp;
  initialized_at: NullableTimestamp;
  created_by: string;
  created_at: Generated<Date>;
  funded_at: NullableTimestamp;
  verified_at: NullableTimestamp;
  last_verified_slot: string | null; // bigint
  last_verified_commitment: string | null; // always "finalized" when set
  version: Generated<number>;
}

// Append-only ledger of verified, finalized deposit_project_funding
// instructions. UNIQUE(signature): exactly one deposit instruction per
// transaction is accepted in Phase 4E.1.
export interface ProjectFundingDepositsTable {
  id: Generated<string>;
  funding_account_id: string;
  signature: string;
  amount_base_units: string;
  depositor_wallet: string;
  slot: string; // bigint
  block_time: NullableTimestamp;
  commitment: string; // always "finalized"
  verified_at: Generated<Date>;
  created_at: Generated<Date>;
}

// Phase 4E.2 — one settle/refund decision per funding account
// (0014_project_funding_settlements.sql). Amounts are lamports (bigint).
export interface ProjectFundingSettlementsTable {
  id: Generated<string>;
  funding_account_id: string;
  organization_id: string;
  task_id: string;
  kind: string; // SETTLE | REFUND
  release_amount_base_units: string;
  refund_amount_base_units: string;
  recipient_wallet: string | null;
  customer_wallet: string;
  status: Generated<string>; // PENDING | SUBMITTED | FINALIZED
  signature: string | null;
  sent_at: NullableTimestamp;
  finalized_slot: string | null; // bigint
  finalized_at: NullableTimestamp;
  created_by: string;
  created_at: Generated<Date>;
}

// ADR-0015 — an organization's sandboxed Agent Server (agent gateway target).
export interface OrgAgentServersTable {
  organization_id: string;
  base_url: string;
  session_api_key: string;
  container_name: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ADR-0016 — a pre-funding, tool-less discussion started from the canvas.
export interface DiscussionConversationsTable {
  conversation_id: string;
  organization_id: string;
  created_by: string;
  message_count: Generated<number>;
  created_at: Generated<Date>;
  last_message_at: Generated<Date>;
  planned_lineage_id: string | null;
}

// ADR-0017 — the agent's change for one execution, as verified.
export interface ExecutionPatchesTable {
  execution_id: string;
  task_id: string;
  organization_id: string;
  base_revision: string;
  patch: string;
  sha256: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  created_at: Generated<Date>;
  verify_lease_owner: string | null;
  verify_lease_expires_at: NullableTimestamp;
}

// ADR-0018 — on-demand agent workspace provisioning.
export interface AgentSandboxRequestsTable {
  organization_id: string;
  requested_by: string;
  status: Generated<string>; // PENDING | PROVISIONING | READY | FAILED
  attempts: Generated<number>;
  error: string | null;
  claimed_at: NullableTimestamp;
  requested_at: Generated<Date>;
  updated_at: Generated<Date>;
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
  task_usage_policies: TaskUsagePoliciesTable;
  task_usage_pauses: TaskUsagePausesTable;
  project_funding_accounts: ProjectFundingAccountsTable;
  project_funding_deposits: ProjectFundingDepositsTable;
  project_funding_settlements: ProjectFundingSettlementsTable;
  org_agent_servers: OrgAgentServersTable;
  discussion_conversations: DiscussionConversationsTable;
  execution_patches: ExecutionPatchesTable;
  agent_sandbox_requests: AgentSandboxRequestsTable;
}
