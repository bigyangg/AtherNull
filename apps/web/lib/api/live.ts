import type { AgentProfile, Execution, RepoProject, Task, TaskDetail } from "@/lib/types";
import type {
  CreateRepoProjectInput,
  CreateTaskInput,
  TaskDashboardApi,
} from "@/lib/api/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    // apps/api's CORS config (app.ts) allows credentialed cross-origin
    // requests specifically so the Better Auth session cookie is sent here —
    // same pattern as lib/auth/client.ts.
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body && typeof body === "object" && "error" in body ? String(body.error) : null) ??
        `Request to ${path} failed with ${res.status}`,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Raw shapes as apps/api returns them (snake_case, straight off the DB rows
// — see apps/api/src/routes/{projects,jobs,agent-profiles}.ts). Mapped to
// the web app's camelCase lib/types below so nothing outside this file
// needs to know the backend's column naming.
interface RawProject {
  id: string;
  permitted_repository: string;
  revision: string | null;
  scope: string | null;
  created_at: string;
}

interface RawAgentProfile {
  id: string;
  policy_version: string;
  config_revision: number;
}

interface RawExecution {
  id: string;
  task_id: string;
  attempt_id: string;
  status: string;
  routing_tier: string | null;
  routing_score: number | string | null;
  routing_reason: string | null;
  resolved_model: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface RawTask {
  id: string;
  organization_id: string;
  project_id: string;
  agent_profile_id: string;
  repository_revision: string;
  requirements: string;
  acceptance_criteria: string[];
  max_budget_minor: string; // bigint over the wire
  currency: string;
  status: Task["status"];
  created_at: string;
  updated_at: string;
}

interface RawTaskDetail extends RawTask {
  executions: RawExecution[];
  budgetSpentMinor: number;
}

function toProject(raw: RawProject): RepoProject {
  return {
    id: raw.id,
    permittedRepository: raw.permitted_repository,
    revision: raw.revision,
    scope: raw.scope,
    createdAt: raw.created_at,
  };
}

function toAgentProfile(raw: RawAgentProfile): AgentProfile {
  return { id: raw.id, policyVersion: raw.policy_version, configRevision: raw.config_revision };
}

function toExecution(raw: RawExecution): Execution {
  return {
    id: raw.id,
    taskId: raw.task_id,
    attemptId: raw.attempt_id,
    status: raw.status,
    routingTier: raw.routing_tier,
    routingScore: raw.routing_score === null ? null : Number(raw.routing_score),
    routingReason: raw.routing_reason,
    resolvedModel: raw.resolved_model,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    createdAt: raw.created_at,
  };
}

function toTask(raw: RawTask): Task {
  return {
    id: raw.id,
    organizationId: raw.organization_id,
    projectId: raw.project_id,
    agentProfileId: raw.agent_profile_id,
    repositoryRevision: raw.repository_revision,
    requirements: raw.requirements,
    acceptanceCriteria: raw.acceptance_criteria,
    maxBudgetMinor: Number(raw.max_budget_minor),
    currency: raw.currency,
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export const liveApi: TaskDashboardApi = {
  async listRepoProjects() {
    const raw = await apiFetch<RawProject[]>("/v1/projects");
    return raw.map(toProject);
  },

  async createRepoProject(input: CreateRepoProjectInput) {
    const raw = await apiFetch<RawProject>("/v1/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return toProject(raw);
  },

  async listAgentProfiles() {
    const raw = await apiFetch<RawAgentProfile[]>("/v1/agent-profiles");
    return raw.map(toAgentProfile);
  },

  async listTasks() {
    const raw = await apiFetch<RawTask[]>("/v1/jobs");
    return raw.map(toTask);
  },

  async createTask(input: CreateTaskInput) {
    const raw = await apiFetch<RawTask>("/v1/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return toTask(raw);
  },

  async fundTask(taskId: string) {
    const raw = await apiFetch<RawTask>(`/v1/jobs/${taskId}/fund`, { method: "POST" });
    return toTask(raw);
  },

  async getTask(taskId: string) {
    const raw = await apiFetch<RawTaskDetail>(`/v1/jobs/${taskId}`);
    const task = toTask(raw);
    return {
      ...task,
      executions: raw.executions.map(toExecution),
      budgetSpentMinor: raw.budgetSpentMinor,
    };
  },
};
