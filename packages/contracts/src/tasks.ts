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
  // Phase 4D.2A — a SOFT, POST-RESPONSE operational token-usage pause (never
  // a monetary/hard limit — see docs/adr/0012-operational-usage-limits.md).
  // Reached only from RUNNING, when the worker's fast-path usage check
  // crosses an ACTIVE task_usage_policies row's limit_quantity and
  // conversation.pause()/interrupt() genuinely stopped the agent (confirmed
  // by re-checking the conversation's real execution_status — never assumed
  // from a 200 response alone).
  "PAUSED_USAGE_LIMIT",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// A worker reports results; it cannot self-approve or release funds
// (PLAN.md §1) — reflected here by RUNNING only ever reaching VERIFYING,
// never ACCEPTED/SETTLED directly. FAILED can loop back to QUEUED (capped
// retry, apps/api's execution-complete handler owns the cap) since ADR-0003
// flags retry as a natural extension of Phase 1's lease logic.
//
// PAUSED_USAGE_LIMIT (Phase 4D.2A) has exactly two legal exits, corresponding
// to the two distinct resume architectures apps/api/src/routes/usage-policies.ts
// implements — never conflated:
//   - -> RUNNING: a genuine SAME-conversation resume (the original worker
//     process/container is still alive and holding the paused conversation).
//     This must NEVER be used to paper over a new execution attempt.
//   - -> QUEUED: the original execution is unrecoverable (worker/container
//     lost, or the pause's own resume_mode was NEW_ATTEMPT because the
//     fallback interrupt() path was used) — goes through the EXISTING
//     claim/retry architecture to create exactly one new execution attempt,
//     respecting MAX_EXECUTION_ATTEMPTS, never reusing the dead execution id.
// There is deliberately no PAUSED_USAGE_LIMIT -> FAILED transition: the
// fail-closed "both pause() and interrupt() failed" case never reaches
// PAUSED_USAGE_LIMIT at all — it goes straight from RUNNING to FAILED using
// the existing failure semantics, tagged with executions.failure_reason =
// 'USAGE_ENFORCEMENT_FAILED' (see 0012_task_usage_policies.sql).
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  CREATED: ["AWAITING_FUNDING", "CANCELLED"],
  AWAITING_FUNDING: ["FUNDED", "CANCELLED"],
  FUNDED: ["QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "PAUSED_USAGE_LIMIT"],
  PAUSED_USAGE_LIMIT: ["RUNNING", "QUEUED"],
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
