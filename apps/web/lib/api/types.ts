import type { Project, WorkspaceState } from "@/lib/types";

export interface CreateProjectInput {
  name: string;
  objective: string;
  maxBudgetMinor: number;
  currency: string;
}

// The web app's view of the backend. `lib/api/mock.ts` implements this
// against an in-memory store today; once Phase 1 job endpoints exist in
// apps/api, a `lib/api/live.ts` implementing the same interface against
// `fetch` is the only file that needs to change — see lib/api/index.ts.
export interface WorkspaceApi {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  getWorkspaceState(projectId: string): Promise<WorkspaceState>;
  sendChatMessage(projectId: string, text: string): Promise<WorkspaceState>;
}
