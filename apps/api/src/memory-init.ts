import type { ProjectMemory, TodoItem, ProjectOverallStatus, ProjectPhases } from "@athernull/contracts";

/**
 * Initialize or load project memory for a new task.
 * This creates the hierarchical memory structure in the sandbox volume.
 */

// In-memory store (in production, this would be persisted to the sandbox volume)
const projectMemoryStore = new Map<string, ProjectMemory>();

export function ensureProjectMemory(
  projectId: string,
  name: string,
  owner: string,
): ProjectMemory {
  let memory = projectMemoryStore.get(projectId);
  if (!memory) {
    memory = createProjectMemory(projectId, name, owner);
    projectMemoryStore.set(projectId, memory);
  }
  return memory;
}

function createProjectMemory(projectId: string, name: string, owner: string): ProjectMemory {
  const now = new Date().toISOString();

  const phases: ProjectPhases = {
    planning: { status: "pending" },
    implementation: { status: "pending" },
    verification: { status: "pending" },
    acceptance: { status: "pending" },
  };

  const memory: ProjectMemory = {
    projectId,
    name,
    createdAt: now,
    owner,
    overallStatus: "PLANNING",
    phases,
    todoList: [],
    decisions: [],
    artifacts: {},
    metadata: {},
  };

  return memory;
}

export function getProjectMemory(projectId: string): ProjectMemory | undefined {
  return projectMemoryStore.get(projectId);
}

export function updateProjectMemory(projectId: string, updates: Partial<ProjectMemory>): ProjectMemory | undefined {
  const memory = projectMemoryStore.get(projectId);
  if (!memory) return undefined;

  const updated = { ...memory, ...updates };
  projectMemoryStore.set(projectId, updated);
  return updated;
}

export function addTodoToProject(
  projectId: string,
  title: string,
  deliverable?: string,
  assignee?: string,
): TodoItem | undefined {
  const memory = projectMemoryStore.get(projectId);
  if (!memory) return undefined;

  const todo: TodoItem = {
    id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    status: "pending",
    deliverable,
    assignee,
    dependsOn: [],
  };

  memory.todoList.push(todo);
  projectMemoryStore.set(projectId, memory);
  return todo;
}

export function updateProjectPhase(
  projectId: string,
  phase: keyof ProjectPhases,
  status: "pending" | "in_progress" | "done" | "blocked",
  threadId?: string,
): ProjectMemory | undefined {
  const memory = projectMemoryStore.get(projectId);
  if (!memory) return undefined;

  memory.phases[phase].status = status;
  if (threadId) memory.phases[phase].threadId = threadId;
  if (status === "in_progress" && !memory.phases[phase].startedAt) {
    memory.phases[phase].startedAt = new Date().toISOString();
  }
  if (status === "done" && !memory.phases[phase].completedAt) {
    memory.phases[phase].completedAt = new Date().toISOString();
  }

  // Update overall status based on phases
  memory.overallStatus = computeOverallStatus(memory.phases);

  projectMemoryStore.set(projectId, memory);
  return memory;
}

function computeOverallStatus(phases: ProjectPhases): ProjectOverallStatus {
  if (phases.planning.status === "in_progress" || phases.planning.status === "pending") {
    return "PLANNING";
  }
  if (phases.implementation.status === "in_progress") {
    return "BUILDING";
  }
  if (phases.verification.status === "in_progress" || phases.verification.status === "pending") {
    return "VERIFYING";
  }
  if (phases.acceptance.status === "in_progress" || phases.acceptance.status === "pending") {
    return "AWAITING_ACCEPTANCE";
  }
  if (phases.acceptance.status === "done") {
    return "SETTLED";
  }
  if (phases.verification.status === "blocked" || phases.implementation.status === "blocked") {
    return "FAILED";
  }
  return "PLANNING";
}