import type { Request, Response, Router } from "express";
import { Router as makeRouter } from "express";

import { getExecutionEvents, getTaskDetail } from "../athernull-client.js";
import { mapExecutionEventsToOpenHandsEventPage } from "../mapping.js";
import type { ExecutionEvent } from "../athernull-types.js";

export const eventsRouter: Router = makeRouter();

// Both endpoints below key off the task's *latest* execution
// (executions[0], since GET /v1/jobs/:id orders them created_at desc -
// jobs.ts) - AtherNull's TaskDetail has no single "the" execution field, a
// task can have several attempts (MAX_EXECUTION_ATTEMPTS retries,
// internal.ts), so "the conversation's events" is defined here as "the most
// recent attempt's events." A task with zero executions yet (still
// QUEUED/AWAITING_FUNDING) has no events at all.
async function latestExecutionEvents(taskId: string): Promise<ExecutionEvent[]> {
  const detail = await getTaskDetail(taskId);
  if (!detail || detail.executions.length === 0) return [];
  const latest = detail.executions[0];
  return getExecutionEvents(taskId, latest.id);
}

// GET /api/conversations/:id/events/count -> bare number
eventsRouter.get("/:id/events/count", async (req: Request, res: Response) => {
  try {
    const events = await latestExecutionEvents(req.params.id);
    res.json(events.length);
  } catch (err) {
    console.error("[events/count]", err);
    res.status(502).json({ error: String(err) });
  }
});

// GET /api/conversations/:id/events/search -> {items: OpenHandsEvent[], next_page_id}
eventsRouter.get("/:id/events/search", async (req: Request, res: Response) => {
  try {
    const events = await latestExecutionEvents(req.params.id);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const sortOrder = req.query.sort_order === "TIMESTAMP_DESC" ? "TIMESTAMP_DESC" : "TIMESTAMP_ASC";
    res.json(mapExecutionEventsToOpenHandsEventPage(events, { limit, sortOrder }));
  } catch (err) {
    console.error("[events/search]", err);
    res.status(502).json({ error: String(err) });
  }
});
