import type {
  PrepareFundingRequest,
  PrepareFundingResponse,
  ProjectFundingView,
  SettlementProgressResponse,
  VerifyFundingResponse,
} from "@athernull/contracts";
import type {
  AgentProfile,
  BuildListItem,
  BuildPatch,
  ChatBuildState,
  Discussion,
  BudgetAuthorization,
  BudgetAuthorizationSource,
  EstimateResult,
  ExecutionEvent,
  Project,
  ProjectEstimate,
  RepoProject,
  Task,
  TaskDetail,
  UsagePolicy,
  UsageSummary,
  WorkspaceState,
} from "@/lib/types";

export interface CreateProjectInput {
  name: string;
  objective: string;
  maxBudgetMinor: number;
  currency: string;
}

// The greenfield "Create New" flow's view of the backend. `lib/api/mock.ts`
// implements this against an in-memory store — deliberately not connected to
// apps/api (see lib/api/index.ts and PLAN.md's dashboard rework: this flow
// needs its own preview-hosting/scaffold decisions before it can be real).
export interface WorkspaceApi {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  getWorkspaceState(projectId: string): Promise<WorkspaceState>;
  sendChatMessage(projectId: string, text: string): Promise<WorkspaceState>;
}

export interface CreateRepoProjectInput {
  permittedRepository: string;
  revision?: string;
  scope?: string;
}

export interface CreateTaskInput {
  projectId: string;
  repositoryRevision: string;
  objective: string;
  acceptanceCriteria: string[];
  agentProfileId: string;
  budgetMinor: number;
  currency: string;
}

// Mirrors CreateTaskInput minus the fields that don't feed cost/routing
// (projectId/repositoryRevision/currency) — same shape apps/api's
// EstimateJobRequestSchema takes.
export interface EstimateTaskInput {
  agentProfileId: string;
  objective: string;
  acceptanceCriteria: string[];
  budgetMinor: number;
}

// Phase 4B — mirrors apps/api's AuthorizeBudgetRequestSchema
// (packages/contracts/src/budget-authorizations.ts). amountMinor is omitted
// when source is ESTIMATE_PROPOSED_CAP and the caller wants the server's own
// persisted proposed_budget_cap_minor used verbatim.
export interface AuthorizeBudgetInput {
  source: BudgetAuthorizationSource;
  amountMinor?: number;
  currency: string;
}

// Phase 4C — mirrors apps/api's PrepareBuildRequestSchema
// (packages/contracts/src/task-provenance.ts). Never sends
// organizationId/estimateId/amount/currency — the server derives all of that
// from the persisted budgetAuthorizationId. agentProfileId/repositoryRevision
// are still caller-supplied, same as legacy CreateTaskInput, since nothing
// upstream (planner/estimate/authorization) produces either of them yet.
export interface PrepareBuildInput {
  budgetAuthorizationId: string;
  agentProfileId: string;
  repositoryRevision: string;
}

// The real "Import Repository" / task-status dashboard's view of the
// backend — implemented by lib/api/live.ts against apps/api's /v1/* routes.
export interface TaskDashboardApi {
  listRepoProjects(): Promise<RepoProject[]>;
  createRepoProject(input: CreateRepoProjectInput): Promise<RepoProject>;
  listAgentProfiles(): Promise<AgentProfile[]>;
  listTasks(): Promise<Task[]>;
  createTask(input: CreateTaskInput): Promise<Task>;
  fundTask(taskId: string): Promise<Task>;
  // Phase 4E.1 — Solana devnet project funding. getProjectFunding resolves
  // null when no funding account exists for the task yet.
  getProjectFunding(taskId: string): Promise<ProjectFundingView | null>;
  createProjectFunding(taskId: string): Promise<ProjectFundingView>;
  prepareProjectFunding(taskId: string, input: PrepareFundingRequest): Promise<PrepareFundingResponse>;
  verifyProjectFunding(taskId: string, signature?: string): Promise<VerifyFundingResponse>;
  getTask(taskId: string): Promise<TaskDetail>;
  estimateTask(input: EstimateTaskInput): Promise<EstimateResult>;
  verifyTask(taskId: string, outcome: "PASS" | "FAIL"): Promise<Task>;
  acceptTask(taskId: string): Promise<Task>;
  rejectTask(taskId: string, reason?: string): Promise<Task>;
  /** Sends a verified build back to the agent with feedback (same funding). */
  requestChanges(taskId: string, feedback: string): Promise<{ taskId: string; status: string; round: number; roundsLeft: number }>;
  // Phase 4E.2 — on-chain payout. accept settles and reject refunds the
  // task's devnet funding; refundTask refunds a FAILED/CANCELLED funded
  // build; verifySettlement drives an already-decided payout and reports
  // progress (SETTLING/REFUNDING -> SETTLED/REFUNDED once finalized).
  refundTask(taskId: string): Promise<Task>;
  verifySettlement(taskId: string): Promise<SettlementProgressResponse>;
  getUsageSummary(): Promise<UsageSummary>;
  getExecutionEvents(taskId: string, executionId: string): Promise<ExecutionEvent[]>;

  // Phase 4A — project scope/build-plan/cost-estimate lineage. Purely a
  // planning/pricing surface: none of these ever create or touch a task or
  // execution (see apps/api/src/routes/estimates.ts's header comment).
  generateEstimate(projectId: string, prompt: string): Promise<ProjectEstimate>;
  // ADR-0016 — pre-funding canvas discussions, and planning from one (the
  // server reads the transcript from the org's sandbox itself).
  generateEstimateFromDiscussion(projectId: string, discussionId: string): Promise<ProjectEstimate>;
  listDiscussions(): Promise<Discussion[]>;
  // Chat-native builds: one discussion's build state (null when the
  // conversation isn't a discussion of this org), and drafting/updating its
  // plan from the chat (a new idea gets an AtherNull-hosted repository).
  getChatBuild(discussionId: string): Promise<ChatBuildState | null>;
  draftChatPlan(discussionId: string): Promise<ProjectEstimate>;
  updateChatPlan(discussionId: string): Promise<ProjectEstimate>;
  // ADR-0017 — the build's captured change; null until one exists.
  getBuildPatch(taskId: string): Promise<BuildPatch | null>;
  listBuilds(): Promise<BuildListItem[]>;
  listEstimates(projectId: string): Promise<ProjectEstimate[]>;
  getEstimate(projectId: string, estimateId: string): Promise<ProjectEstimate>;
  reviseEstimate(projectId: string, estimateId: string, prompt: string): Promise<ProjectEstimate>;
  approveEstimate(projectId: string, estimateId: string): Promise<ProjectEstimate>;

  // Phase 4B — authorized project budget. Committing a real money amount
  // against an APPROVED estimate — never funding, never settlement, never a
  // task (see apps/api/src/routes/budget-authorizations.ts's header
  // comment).
  authorizeBudget(
    projectId: string,
    estimateId: string,
    input: AuthorizeBudgetInput,
  ): Promise<BudgetAuthorization>;
  listBudgetAuthorizations(projectId: string, estimateId: string): Promise<BudgetAuthorization[]>;

  // Phase 4D.2A — operational usage limits + pause/resume. A SOFT,
  // POST-RESPONSE token limit, never monetary — see
  // apps/api/src/routes/usage-policies.ts's header comment and
  // docs/adr/0012-operational-usage-limits.md. createUsagePolicy fails with
  // an error if one is already ACTIVE (use extendUsagePolicy instead);
  // extendUsagePolicy only ever accepts a strictly greater limitQuantity.
  // resumeUsageLimit takes no input — which resume architecture applies
  // (same live conversation vs. a brand-new attempt) is derived server-side
  // from the task's own state, never a client choice.
  createUsagePolicy(projectId: string, taskId: string, limitQuantity: number): Promise<UsagePolicy>;
  extendUsagePolicy(projectId: string, taskId: string, limitQuantity: number, expectedVersion: number): Promise<UsagePolicy>;
  resumeUsageLimit(projectId: string, taskId: string): Promise<{ mode: "SAME_EXECUTION" | "NEW_ATTEMPT" }>;

  // Phase 4C — every budget authorization across every estimate in a
  // project (current + superseded + consumed), used to let a privileged
  // member pick an ACTIVE one to prepare a build from.
  listProjectBudgetAuthorizations(projectId: string): Promise<BudgetAuthorization[]>;

  // Phase 4C — the canonical, provenance-bound way to create a task. Lands
  // the task at AWAITING_FUNDING and stops there: no execution, no funding,
  // no payment movement. A separate, later "Activate Build" action (still
  // dashboardApi.fundTask under the hood) is what moves it to QUEUED. Never
  // call this "funding" or "paying" in any UI copy — see
  // components/projects/add-task-form.tsx's header comment.
  prepareBuild(projectId: string, input: PrepareBuildInput): Promise<Task>;
}
