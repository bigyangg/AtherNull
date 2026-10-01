import type { TaskUsagePausesTable, TaskUsagePoliciesTable } from "@athernull/database";
import type { UsagePauseResponse, UsagePolicyResponse } from "@athernull/contracts";
import { sql } from "kysely";
import type { Selectable } from "kysely";

import { db } from "./db.js";

// Phase 4D.2A — Operational Usage Limits + Pause/Resume. Shared business
// logic used by both routes/usage-policies.ts (the privileged HTTP surface)
// and routes/internal.ts (the worker-facing claim/pause endpoints) — kept in
// one place so "what counts as cumulative task usage" and "what a policy/
// pause row looks like on the wire" each have exactly one implementation.

export function toUsagePolicyResponse(
  row: Selectable<TaskUsagePoliciesTable>,
): UsagePolicyResponse {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    taskId: row.task_id,
    lineageId: row.lineage_id,
    version: row.version,
    metric: row.metric as UsagePolicyResponse["metric"],
    limitQuantity: Number(row.limit_quantity),
    status: row.status as UsagePolicyResponse["status"],
    supersedesId: row.supersedes_id,
    authorizedBy: row.authorized_by,
    authorizedAt: row.authorized_at instanceof Date ? row.authorized_at.toISOString() : String(row.authorized_at),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export function toUsagePauseResponse(row: Selectable<TaskUsagePausesTable>): UsagePauseResponse {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    policyId: row.policy_id,
    metric: row.metric as UsagePauseResponse["metric"],
    configuredLimit: Number(row.configured_limit),
    observedUsage: Number(row.observed_usage),
    enforcementAction: row.enforcement_action as UsagePauseResponse["enforcementAction"],
    resumeMode: row.resume_mode as UsagePauseResponse["resumeMode"],
    pausedAt: row.paused_at instanceof Date ? row.paused_at.toISOString() : String(row.paused_at),
    resumedAt: row.resumed_at
      ? row.resumed_at instanceof Date
        ? row.resumed_at.toISOString()
        : String(row.resumed_at)
      : null,
    resumeExecutionId: row.resume_execution_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function getActivePolicy(
  taskId: string,
): Promise<Selectable<TaskUsagePoliciesTable> | undefined> {
  return db
    .selectFrom("task_usage_policies")
    .selectAll()
    .where("task_id", "=", taskId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
}

// TOTAL_LLM_TOKENS, task-level, summed across EVERY execution under the task
// (not just the latest) — same aggregation shape as jobs.ts's own
// budgetSpentMinor/usage query (routes/jobs.ts), and the exact durable
// number the worker's fast-path baseline (correction 2) must agree with.
// Never trusts worker-supplied numbers — always a fresh sum over
// usage_events, the durable source of truth (correction 2/21).
export async function cumulativeTaskUsage(taskId: string): Promise<number> {
  const row = await db
    .selectFrom("usage_events")
    .select(({ fn }) => [fn.coalesce(fn.sum<string>("total_tokens"), sql<string>`0`).as("totalTokens")])
    .where("task_id", "=", taskId)
    .executeTakeFirstOrThrow();
  return Number(row.totalTokens);
}

// The most recent still-open (unresolved) pause for a task, if any — at most
// one can ever exist at a time in practice (a task can only be
// PAUSED_USAGE_LIMIT once at a time), but this reads by recency rather than
// assuming uniqueness at the query layer, since the DB's own
// task_usage_pauses_one_open_per_execution index is scoped to execution_id,
// not task_id (a task could in principle have paused executions from two
// different, non-overlapping attempts in its history — only ever one OPEN
// at a time in the current FSM, but this query stays honest either way).
export async function latestOpenPause(
  taskId: string,
): Promise<Selectable<TaskUsagePausesTable> | undefined> {
  return db
    .selectFrom("task_usage_pauses")
    .selectAll()
    .where("task_id", "=", taskId)
    .where("resumed_at", "is", null)
    .orderBy("paused_at", "desc")
    .executeTakeFirst();
}
