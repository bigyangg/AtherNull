import type {
  BuildStep,
  ChatMessage,
  Project,
  TaskStatus,
  WorkspaceState,
} from "@/lib/types";
import type { CreateProjectInput, WorkspaceApi } from "@/lib/api/types";

const BUILD_STEP_TEMPLATE = [
  "Project scaffold",
  "Home page",
  "Core pages",
  "Database schema",
  "Admin dashboard",
  "Quality checks",
];

const STEP_INTERVAL_MS = 3000;
const AGENT_REPLY_DELAY_MS = 1200;

interface StoreEntry {
  project: Project;
  buildSteps: BuildStep[];
  budgetSpentMinor: number;
  budgetMaxMinor: number;
  currency: string;
  messages: ChatMessage[];
  previewUrl: string;
  costPerStepMinor: number;
}

// Module-level singleton so state survives client-side navigation within a
// session. This is intentionally the entire "backend" for this milestone —
// see lib/api/types.ts for the interface a real implementation would match.
const store = new Map<string, StoreEntry>();

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base || "project";
}

function id(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function toProjectView(entry: StoreEntry): Project {
  return { ...entry.project };
}

function toWorkspaceState(entry: StoreEntry): WorkspaceState {
  return {
    project: toProjectView(entry),
    buildSteps: entry.buildSteps.map((step) => ({ ...step })),
    budgetSpentMinor: entry.budgetSpentMinor,
    budgetMaxMinor: entry.budgetMaxMinor,
    currency: entry.currency,
    messages: entry.messages.map((message) => ({ ...message })),
    previewUrl: entry.previewUrl,
  };
}

function setStatus(entry: StoreEntry, status: TaskStatus) {
  entry.project.status = status;
  entry.project.updatedAt = now();
}

function advance(entry: StoreEntry) {
  const running = entry.buildSteps.find((step) => step.status === "running");
  if (running) {
    running.status = "completed";
    entry.budgetSpentMinor = Math.min(
      entry.budgetMaxMinor,
      entry.budgetSpentMinor + entry.costPerStepMinor,
    );
  }

  const next = entry.buildSteps.find((step) => step.status === "queued");
  if (next) {
    next.status = "running";
    return;
  }

  if (!entry.buildSteps.some((step) => step.status !== "completed")) {
    setStatus(entry, "SETTLED");
    return;
  }

  setStatus(entry, "RUNNING");
}

function startProgression(entry: StoreEntry) {
  entry.buildSteps[0]!.status = "running";
  setStatus(entry, "RUNNING");

  const timer = setInterval(() => {
    const current = store.get(entry.project.id);
    if (!current || current.project.status !== "RUNNING") {
      clearInterval(timer);
      return;
    }
    advance(current);
    if (current.project.status !== "RUNNING") {
      clearInterval(timer);
    }
  }, STEP_INTERVAL_MS);
}

function agentReplyFor(userText: string): string {
  const trimmed = userText.trim();
  if (!trimmed) {
    return "Let me know what you'd like to change.";
  }
  return `Got it — I'll work on that: "${trimmed}". I'll update the live preview as I go.`;
}

export const mockApi: WorkspaceApi = {
  async listProjects() {
    return Array.from(store.values())
      .map(toProjectView)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async createProject(input: CreateProjectInput) {
    const timestamp = now();
    const project: Project = {
      id: id(),
      name: input.name,
      slug: slugify(input.name),
      objective: input.objective,
      status: "CREATED",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const buildSteps: BuildStep[] = BUILD_STEP_TEMPLATE.map((label) => ({
      id: id(),
      label,
      status: "queued",
    }));

    const entry: StoreEntry = {
      project,
      buildSteps,
      budgetSpentMinor: 0,
      budgetMaxMinor: input.maxBudgetMinor,
      currency: input.currency,
      costPerStepMinor: Math.round(
        input.maxBudgetMinor / BUILD_STEP_TEMPLATE.length / 3,
      ),
      previewUrl: `https://preview.proto-col.app/${slugify(input.name)}`,
      messages: [
        {
          id: id(),
          role: "user",
          text: input.objective,
          createdAt: timestamp,
        },
        {
          id: id(),
          role: "agent",
          text: "I'm setting up your project and building the pages we scoped.",
          createdAt: timestamp,
        },
      ],
    };

    store.set(project.id, entry);
    startProgression(entry);

    return toProjectView(entry);
  },

  async getWorkspaceState(projectId: string) {
    const entry = store.get(projectId);
    if (!entry) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return toWorkspaceState(entry);
  },

  async sendChatMessage(projectId: string, text: string) {
    const entry = store.get(projectId);
    if (!entry) {
      throw new Error(`Unknown project: ${projectId}`);
    }

    entry.messages.push({
      id: id(),
      role: "user",
      text,
      createdAt: now(),
    });

    setTimeout(() => {
      const current = store.get(projectId);
      if (!current) return;
      current.messages.push({
        id: id(),
        role: "agent",
        text: agentReplyFor(text),
        createdAt: now(),
      });
    }, AGENT_REPLY_DELAY_MS);

    return toWorkspaceState(entry);
  },
};
