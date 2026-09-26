import type {
  AgentProfile,
  EstimateResult,
  ExecutionEvent,
  Project,
  ProjectEstimate,
  RepoProject,
  Task,
  TaskDetail,
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

// The real "Import Repository" / task-status dashboard's view of the
// backend — implemented by lib/api/live.ts against apps/api's /v1/* routes.
export interface TaskDashboardApi {
  listRepoProjects(): Promise<RepoProject[]>;
  createRepoProject(input: CreateRepoProjectInput): Promise<RepoProject>;
  listAgentProfiles(): Promise<AgentProfile[]>;
  listTasks(): Promise<Task[]>;
  createTask(input: CreateTaskInput): Promise<Task>;
  fundTask(taskId: string): Promise<Task>;
  getTask(taskId: string): Promise<TaskDetail>;
  estimateTask(input: EstimateTaskInput): Promise<EstimateResult>;
  verifyTask(taskId: string, outcome: "PASS" | "FAIL"): Promise<Task>;
  acceptTask(taskId: string): Promise<Task>;
  rejectTask(taskId: string, reason?: string): Promise<Task>;
  getUsageSummary(): Promise<UsageSummary>;
  getExecutionEvents(taskId: string, executionId: string): Promise<ExecutionEvent[]>;

  // Phase 4A — project scope/build-plan/cost-estimate lineage. Purely a
  // planning/pricing surface: none of these ever create or touch a task or
  // execution (see apps/api/src/routes/estimates.ts's header comment).
  generateEstimate(projectId: string, prompt: string): Promise<ProjectEstimate>;
  listEstimates(projectId: string): Promise<ProjectEstimate[]>;
  getEstimate(projectId: string, estimateId: string): Promise<ProjectEstimate>;
  reviseEstimate(projectId: string, estimateId: string, prompt: string): Promise<ProjectEstimate>;
  approveEstimate(projectId: string, estimateId: string): Promise<ProjectEstimate>;
}
