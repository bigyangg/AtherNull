import type {
  AgentProfile,
  Project,
  RepoProject,
  Task,
  TaskDetail,
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
}
