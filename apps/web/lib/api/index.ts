import { liveApi } from "@/lib/api/live";
import { mockApi } from "@/lib/api/mock";
import type { TaskDashboardApi, WorkspaceApi } from "@/lib/api/types";

// Two separate backends, deliberately not unified:
// - `api` backs the mocked "Create New" greenfield flow (chat + live
//   preview + build steps) — in-memory only, no apps/api concept exists for
//   any of it yet. Nothing outside lib/api/mock.ts should import it directly.
// - `dashboardApi` backs the real "Import Repository" / task-status
//   dashboard, wired to apps/api's /v1/* routes.
export const api: WorkspaceApi = mockApi;
export const dashboardApi: TaskDashboardApi = liveApi;

export type {
  CreateProjectInput,
  CreateRepoProjectInput,
  CreateTaskInput,
  EstimateTaskInput,
  TaskDashboardApi,
  WorkspaceApi,
} from "@/lib/api/types";
