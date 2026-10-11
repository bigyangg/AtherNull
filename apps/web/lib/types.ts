// Web-only types layered on top of @athernull/contracts. The task status
// values mirror the FSM in PLAN.md (§2 "Phase 1 — Core job engine") — this
// file only adds the *display* mapping, it isn't a second source of truth.

export type TaskStatus =
  | "CREATED"
  | "AWAITING_FUNDING"
  | "FUNDED"
  | "QUEUED"
  | "RUNNING"
  | "VERIFYING"
  | "AWAITING_ACCEPTANCE"
  | "ACCEPTED"
  | "SETTLING"
  | "SETTLED"
  | "FAILED"
  | "CANCELLED"
  | "REJECTED"
  | "DISPUTED"
  | "REFUNDING"
  | "REFUNDED"
  // Phase 4D.2A — a SOFT, POST-RESPONSE operational token-usage pause, never
  // a monetary/hard limit. See docs/adr/0012-operational-usage-limits.md.
  | "PAUSED_USAGE_LIMIT";

export const TASK_STATUS_DISPLAY: Record<
  TaskStatus,
  { label: string; tone: "default" | "success" | "warning" | "destructive" | "muted" }
> = {
  CREATED: { label: "Draft", tone: "muted" },
  AWAITING_FUNDING: { label: "Awaiting funding", tone: "warning" },
  FUNDED: { label: "Funded", tone: "muted" },
  QUEUED: { label: "Queued", tone: "muted" },
  RUNNING: { label: "Building", tone: "default" },
  VERIFYING: { label: "Verifying", tone: "default" },
  AWAITING_ACCEPTANCE: { label: "Needs your review", tone: "warning" },
  ACCEPTED: { label: "Accepted", tone: "success" },
  SETTLING: { label: "Settling on-chain", tone: "default" },
  SETTLED: { label: "Settled", tone: "success" },
  FAILED: { label: "Failed", tone: "destructive" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  REJECTED: { label: "Rejected", tone: "destructive" },
  DISPUTED: { label: "Disputed", tone: "destructive" },
  REFUNDING: { label: "Refunding on-chain", tone: "warning" },
  REFUNDED: { label: "Refunded", tone: "muted" },
  PAUSED_USAGE_LIMIT: { label: "Paused: usage limit reached", tone: "warning" },
};

// A task status counts as "settled" once the workspace should stop polling
// for progress — either it reached a terminal outcome or it's waiting on the
// customer, not the agent.
// SETTLING/REFUNDING stay active: the on-chain payout is still finalizing.
const INACTIVE_STATUSES = new Set<TaskStatus>([
  "AWAITING_ACCEPTANCE",
  "ACCEPTED",
  "SETTLED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "DISPUTED",
  "REFUNDED",
]);

export function isTaskActive(status: TaskStatus): boolean {
  return !INACTIVE_STATUSES.has(status);
}

export type BuildStepStatus = "queued" | "running" | "completed" | "failed";

export interface BuildStep {
  id: string;
  label: string;
  status: BuildStepStatus;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: string; // ISO-8601
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  objective: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceState {
  project: Project;
  buildSteps: BuildStep[];
  budgetSpentMinor: number;
  budgetMaxMinor: number;
  currency: string;
  messages: ChatMessage[];
  previewUrl: string;
}

// --- Real task-status dashboard model (apps/api's tasks/executions/agent_profiles) ---
// Distinct from Project/WorkspaceState above, which back the mocked
// "Create New" greenfield flow (lib/api/mock.ts) and are left as-is. A
// RepoProject is a permitted repository (apps/api's `projects` table),
// not a from-scratch app — see PLAN.md's "Import Repository" entry point.

export interface RepoProject {
  id: string;
  permittedRepository: string;
  revision: string | null;
  scope: string | null;
  createdAt: string;
}

export interface Execution {
  id: string;
  taskId: string;
  attemptId: string;
  status: string;
  // Set once agent_server_adapter.py's EXECUTION_ADAPTER=agent_server path
  // creates the OpenHands conversation — null for direct-SDK executions,
  // which have no persisted event history to show a live workspace for.
  conversationId: string | null;
  routingTier: string | null;
  routingScore: number | null;
  routingReason: string | null;
  resolvedModel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  organizationId: string;
  projectId: string;
  agentProfileId: string;
  repositoryRevision: string;
  requirements: string;
  acceptanceCriteria: string[];
  maxBudgetMinor: number;
  currency: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  // Phase 4C — provenance-bound task creation. Both null for a legacy task
  // (or any task predating this phase); both set for a task created via the
  // canonical POST /v1/projects/:projectId/tasks/from-budget-authorization
  // endpoint. See docs/adr/0010-provenance-bound-task-creation.md.
  sourceEstimateId: string | null;
  sourceBudgetAuthorizationId: string | null;
}

export interface VerificationRun {
  id: string;
  taskId: string | null;
  executionId: string | null;
  verifierVersion: string;
  tests: { name: string; passed: boolean }[];
  outcome: "PASS" | "FAIL";
  evidence: Record<string, unknown>;
  createdAt: string;
}

// Phase 4D.1 — real usage metering. Raw token totals aggregated across every
// execution attempt under a task (apps/api's GET /v1/jobs/:id, GET
// /v1/usage/summary) — never a monetary figure.
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

// Always { status: "UNPRICED", amountMinor: null, currency: null } in this
// phase — no rate card exists yet (apps/api/src/pricing/rates.ts). Reuses
// the same PricingStatus union project_estimates already uses (defined
// further below in this file) rather than a second, disagreeing one.
export interface PricingInfo {
  status: PricingStatus;
  amountMinor: number | null;
  currency: string | null;
}

// Phase 4D.2A — Operational Usage Limits + Pause/Resume. A SOFT,
// POST-RESPONSE operational token limit: once observed cumulative usage
// reaches or exceeds limitQuantity, AtherNull pauses the execution at the
// next safe OpenHands step boundary. Never monetary — see
// docs/adr/0012-operational-usage-limits.md. NEVER render any `$`,
// "Add Funds", "Spent", "Paid", "Deposit", or "Escrow" language anywhere
// this type is used.
export interface UsagePolicy {
  id: string;
  version: number;
  metric: "TOTAL_LLM_TOKENS";
  limitQuantity: number;
  status: "ACTIVE" | "SUPERSEDED";
}

// observedUsage is the REAL, possibly-over-limitQuantity value — a paused
// build may genuinely have used more than the configured limit (one
// already-in-flight response/step can overshoot); this must never be shown
// clamped to configuredLimit.
export interface UsagePause {
  id: string;
  executionId: string;
  metric: "TOTAL_LLM_TOKENS";
  configuredLimit: number;
  observedUsage: number;
  enforcementAction: "PAUSE" | "INTERRUPT";
  resumeMode: "SAME_EXECUTION" | "NEW_ATTEMPT";
  pausedAt: string;
  resumedAt: string | null;
}

export interface TaskUsageLimit {
  policy: UsagePolicy;
  cumulativeUsage: number;
  openPause: UsagePause | null;
}

export interface TaskDetail extends Task {
  executions: Execution[];
  verificationRuns: VerificationRun[];
  // null (never a fabricated 0) once real usage exists whose cost is
  // genuinely unknown (always true in this phase — see PricingInfo above).
  // A real 0 only when zero usage_events rows exist at all for this task.
  budgetSpentMinor: number | null;
  usage: UsageTotals;
  pricing: PricingInfo;
  // null whenever no ACTIVE task_usage_policies row exists for this task —
  // the pre-existing behavior, unchanged (correction 19).
  usageLimit: TaskUsageLimit | null;
}

// The Agent Server's own event stream for an execution (apps/api's
// execution_events table) — kind/payload are whatever the OpenHands SDK's
// event model produced (MessageEvent, ActionEvent, ObservationEvent, ...),
// not a contract this app controls. See lib/execution-events.ts for the
// defensive per-kind parsers that read `payload`.
export interface ExecutionEvent {
  id: string;
  executionId: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
  createdAt: string;
}

export interface EstimateResult {
  tier: string;
  model: string;
  score: number;
  reason: string;
  costCeilingMinor: number | null;
}

export interface ModelTier {
  tier: string;
  model: string;
  maxComplexity: number;
  costCeilingMinor: number | null;
}

export interface AgentProfile {
  id: string;
  policyVersion: string;
  configRevision: number;
  modelTiers: ModelTier[];
  toolAllowlist: string[];
}

export interface DailySpend {
  date: string; // ISO-8601
  spentMinor: number;
}

export interface UsageSummary {
  totalSpentMinor: number;
  currency: string;
  dailySpend: DailySpend[];
  taskCountsByStatus: Partial<Record<TaskStatus, number>>;
  // Phase 4D.1 — additive real usage/pricing fields alongside the
  // pre-existing fields above, which keep their prior shape and computation
  // unchanged (see apps/api/src/routes/usage.ts).
  usage: UsageTotals;
  pricing: PricingInfo;
}

// --- Phase 4A: project scope/build-plan/cost-estimate lineage ---
// Backs apps/api's /v1/projects/:projectId/estimates/* routes
// (packages/contracts/src/estimates.ts's EstimateResponseSchema, already
// camelCase — no raw/to mapping needed in lib/api/live.ts, same as
// EstimateResult above).

export type EstimateStatus = "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "SUPERSEDED";
export type PricingStatus = "UNPRICED" | "PRICED";

export interface ResourceEstimate {
  complexity: number;
  estimatedDurationHours: { min: number; max: number };
  inferenceRequirements: {
    estimatedTier: string;
    estimatedTokens?: { min: number; max: number };
  };
  storageRequirements?: string;
  computeRequirements?: string;
  deploymentType?: string;
}

export interface PlannerOutput {
  goal: string;
  scope: { included: string[]; excluded: string[] };
  deliverables: string[];
  implementationPlan: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
  infrastructureRequirements: string[];
  risks: string[];
  resourceEstimate: ResourceEstimate;
}

export interface ProjectEstimate {
  id: string;
  lineageId: string;
  version: number;
  status: EstimateStatus;
  organizationId: string;
  projectId: string;
  sourcePrompt: string;
  plannerOutput: PlannerOutput;
  plannerModel: string;
  pricingStatus: PricingStatus;
  currency: string | null;
  estimatedMinMinor: number | null;
  estimatedMaxMinor: number | null;
  proposedBudgetCapMinor: number | null;
  pricingBreakdown: unknown;
  rateVersion: string | null;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

// Phase 4B — mirrors ProjectBudgetAuthorizationsTable
// (packages/database/src/schema.ts) / BudgetAuthorizationResponseSchema
// (packages/contracts/src/budget-authorizations.ts). Never a task/funding/
// settlement concept — see components/projects/budget-authorization-panel.tsx's
// header comment for the exact vocabulary this UI must and must not use.
export type BudgetAuthorizationSource = "ESTIMATE_PROPOSED_CAP" | "USER_SET";
// Phase 4C adds CONSUMED: a canonical task was created from this exact
// authorization. Permanently terminal — never reverts to ACTIVE, never
// superseded again.
export type BudgetAuthorizationStatus = "ACTIVE" | "SUPERSEDED" | "CONSUMED";

export interface BudgetAuthorization {
  id: string;
  organizationId: string;
  projectId: string;
  estimateId: string;
  estimateLineageId: string;
  estimateVersion: number;
  amountMinor: number;
  currency: string;
  source: BudgetAuthorizationSource;
  status: BudgetAuthorizationStatus;
  supersedesId: string | null;
  authorizedBy: string;
  authorizedAt: string;
  createdAt: string;
}

export function formatMinor(minor: number, currency: string): string {
  return (minor / 100).toLocaleString("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  });
}

// ADR-0016 — a tool-less, pre-funding discussion started in the canvas.
export interface Discussion {
  id: string;
  plannedLineageId: string | null;
  title: string | null;
  messageCount: number;
  createdAt: string;
  lastMessageAt: string;
}

// Planner input produced from a discussion starts with this marker (apps/api
// agent-gateway/discussions.ts); the UI shows it collapsed.
export const DISCUSSION_PROMPT_MARKER = "[Planned from a canvas discussion]";

// ADR-0017 — the exact change under review for a build (latest captured patch).
export interface BuildPatch {
  executionId: string;
  baseRevision: string;
  patch: string;
  sha256: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  capturedAt: string;
}

// GET /v1/builds — drafts (a plan with no build yet) and builds (tasks).
export interface BuildListItem {
  kind: "draft" | "build";
  id: string; // lineage id for drafts, task id for builds
  projectId: string;
  repository: string;
  title: string;
  status: string;
  updatedAt: string;
}
