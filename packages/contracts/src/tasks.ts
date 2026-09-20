import { z } from "zod";

// The task FSM (PLAN.md §2 "Phase 1 — Core job engine"). Single source of
// truth for legal status transitions — apps/api imports assertTransition()
// rather than re-deriving this table, and anything else that needs to
// validate a status change (a future worker, the verifier) should too.
export const TaskStatusSchema = z.enum([
  "CREATED",
  "AWAITING_FUNDING",
  "FUNDED",
  "QUEUED",
  "RUNNING",
  "VERIFYING",
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
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// A worker reports results; it cannot self-approve or release funds
// (PLAN.md §1) — reflected here by RUNNING only ever reaching VERIFYING,
// never ACCEPTED/SETTLED directly. FAILED can loop back to QUEUED (capped
// retry, apps/api's execution-complete handler owns the cap) since ADR-0003
// flags retry as a natural extension of Phase 1's lease logic.
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  CREATED: ["AWAITING_FUNDING", "CANCELLED"],
  AWAITING_FUNDING: ["FUNDED", "CANCELLED"],
  FUNDED: ["QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED"],
  VERIFYING: ["AWAITING_ACCEPTANCE", "FAILED"],
  AWAITING_ACCEPTANCE: ["ACCEPTED", "REJECTED"],
  ACCEPTED: ["SETTLING"],
  SETTLING: ["SETTLED", "FAILED"],
  SETTLED: [],
  FAILED: ["QUEUED", "REFUNDING"],
  CANCELLED: ["REFUNDING"],
  REJECTED: ["REFUNDING"],
  DISPUTED: ["REFUNDING", "SETTLING"],
  REFUNDING: ["REFUNDED"],
  REFUNDED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}
