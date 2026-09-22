// Locally-duplicated subset of AtherNull's real wire types, copied from
// apps/web/lib/types.ts - same "selective reuse across a repo boundary" move
// Spike B's fixtures made (see that file's own header comment), for the same
// reason: this adapter is a fully standalone Node package outside the pnpm
// workspace (per the spike's isolation rule), so it cannot `import` from
// apps/web without pulling that package into its dependency graph.
//
// DO NOT edit apps/web/lib/types.ts to keep this in sync - if that shape
// changes, this file needs a manual update. Only the fields this adapter
// actually reads are included.

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

export interface TaskDetail extends Task {
  executions: Execution[];
  verificationRuns: VerificationRun[];
  budgetSpentMinor: number;
}

export interface ExecutionEvent {
  id: string;
  executionId: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
  createdAt: string;
}
