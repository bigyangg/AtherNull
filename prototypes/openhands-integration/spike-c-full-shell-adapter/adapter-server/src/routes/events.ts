import type { Request, Response, Router } from "express";
import { Router as makeRouter } from "express";

import { getExecutionEvents, getTaskDetail, getTasks } from "../athernull-client.js";
import { mapExecutionEventsToOpenHandsEventPage } from "../mapping.js";
import type { Execution, ExecutionEvent, TaskDetail } from "../athernull-types.js";

export const eventsRouter: Router = makeRouter();

// Spike F change: the requested `:id` used to always be a task id (one
// AppConversation per task, "the conversation's events" == "the latest
// execution's events", executions[0]). Now that mapping.ts's
// mapExecutionToAppConversation keys AppConversation.id on
// `execution.conversationId ?? execution.id` (one AppConversation per
// EXECUTION, so the real sidebar can list every attempt as its own card),
// the id this endpoint receives identifies a specific EXECUTION, not a task
// - and AtherNull's real per-execution events endpoint (GET
// /v1/jobs/:taskId/executions/:executionId/events, jobs.ts) still needs the
// owning task id. This resolves "which task owns this execution" first: a
// linear scan across the org's tasks (GET /v1/jobs, then one GET
// /v1/jobs/:id per task), matching each execution's own
// `conversationId ?? id` against the requested id. O(tasks) per request,
// fine at this prototype's scale (1-2 seeded tasks); a production adapter
// would persist an execution-id -> task-id index instead of scanning on
// every call - see service-contract.md's scaling-limitations section
// (same documented category as /search's N+1).
//
// Exported (Spike F fix) so routes/conversations.ts's single-detail and
// batch handlers can reuse this exact "which task owns this execution"
// lookup, instead of a second, divergent scan living there.
export async function resolveExecutionOwner(
  requestedId: string,
): Promise<{ task: TaskDetail; execution: Execution } | null> {
  const tasks = await getTasks();
  for (const task of tasks) {
    const detail = await getTaskDetail(task.id);
    if (!detail) continue;
    const match = detail.executions.find((e) => (e.conversationId ?? e.id) === requestedId);
    if (match) return { task: detail, execution: match };
  }
  return null;
}

// Spike F fix: the requested `:id` on every one of this adapter's
// per-conversation endpoints must now accept EITHER an execution id (the
// new per-execution card id /search returns, `execution.conversationId ??
// execution.id`) OR a task id (the original, still-relied-upon id shape -
// Spike D's hardcoded NEXT_PUBLIC_CONVERSATION_ID env var, and Spike C's own
// original task-keyed conversation card, both predate /search's per-
// execution change and only ever knew task ids). Tries execution-id
// resolution first via resolveExecutionOwner(); if that scan finds no
// owning task, falls back to treating the id as a task id directly and
// using that task's latest execution (`executions[0]`, the exact pre-Spike-F
// "the conversation's events == the latest execution's events" behavior) -
// `execution: null` only when the resolved task itself has zero executions
// yet (still QUEUED/AWAITING_FUNDING), same edge case as before this fix.
export async function resolveConversationTarget(
  requestedId: string,
): Promise<{ task: TaskDetail; execution: Execution | null } | null> {
  const byExecution = await resolveExecutionOwner(requestedId);
  if (byExecution) return byExecution;
  const task = await getTaskDetail(requestedId);
  if (!task) return null;
  return { task, execution: task.executions[0] ?? null };
}

// A requested id that resolves to no known task or execution at all (never
// seeded, or a stale/garbage-collected conversation card) returns an empty
// event list - same "honest empty, not an error" behavior the old
// task-not-found path had, not a 404, since GET .../events/search callers
// treat an empty page as "no events yet" rather than "conversation doesn't
// exist." A resolved task with zero executions yet also yields an empty
// list (nothing to fetch events for).
async function requestedExecutionEvents(requestedId: string): Promise<ExecutionEvent[]> {
  const target = await resolveConversationTarget(requestedId);
  if (!target || !target.execution) return [];
  return getExecutionEvents(target.task.id, target.execution.id);
}

// GET /api/conversations/:id/events/count -> bare number
eventsRouter.get("/:id/events/count", async (req: Request, res: Response) => {
  try {
    const events = await requestedExecutionEvents(req.params.id);
    res.json(events.length);
  } catch (err) {
    console.error("[events/count]", err);
    res.status(502).json({ error: String(err) });
  }
});

// GET /api/conversations/:id/events/search -> {items: OpenHandsEvent[], next_page_id}
eventsRouter.get("/:id/events/search", async (req: Request, res: Response) => {
  try {
    const events = await requestedExecutionEvents(req.params.id);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const sortOrder = req.query.sort_order === "TIMESTAMP_DESC" ? "TIMESTAMP_DESC" : "TIMESTAMP_ASC";
    res.json(mapExecutionEventsToOpenHandsEventPage(events, { limit, sortOrder }));
  } catch (err) {
    console.error("[events/search]", err);
    res.status(502).json({ error: String(err) });
  }
});
