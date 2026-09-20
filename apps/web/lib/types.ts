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
  | "REFUNDED";

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
  SETTLING: { label: "Settling", tone: "muted" },
  SETTLED: { label: "Live", tone: "success" },
  FAILED: { label: "Failed", tone: "destructive" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  REJECTED: { label: "Rejected", tone: "destructive" },
  DISPUTED: { label: "Disputed", tone: "destructive" },
  REFUNDING: { label: "Refunding", tone: "warning" },
  REFUNDED: { label: "Refunded", tone: "muted" },
};

// A task status counts as "settled" once the workspace should stop polling
// for progress — either it reached a terminal outcome or it's waiting on the
// customer, not the agent.
const INACTIVE_STATUSES = new Set<TaskStatus>([
  "AWAITING_ACCEPTANCE",
  "ACCEPTED",
  "SETTLING",
  "SETTLED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "DISPUTED",
  "REFUNDING",
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

export function formatMinor(minor: number, currency: string): string {
  return (minor / 100).toLocaleString("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  });
}
