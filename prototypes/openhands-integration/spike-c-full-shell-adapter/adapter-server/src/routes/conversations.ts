import type { Request, Response, Router } from "express";
import { Router as makeRouter } from "express";

import { getProjects, getTaskDetail, getTasks } from "../athernull-client.js";
import { mapTaskToAppConversation, mapExecutionToAppConversation, mapTaskExecutionsToAppConversationPage } from "../mapping.js";
import type { AppConversation } from "../mapping.js";
import type { RepoProject, TaskDetail } from "../athernull-types.js";
import { resolveExecutionOwner } from "./events.js";

export const conversationsRouter: Router = makeRouter();

async function projectsById(): Promise<Map<string, RepoProject>> {
  const projects = await getProjects();
  return new Map(projects.map((p) => [p.id, p]));
}

// Spike F fix: both of this router's per-id lookups below (single-detail and
// batch) used to resolve `:id`/`ids[]=` as a TASK id only - correct while
// /search emitted one AppConversation per task, but stale now that /search
// emits one per EXECUTION (`execution.conversationId ?? execution.id`, see
// mapping.ts's mapExecutionToAppConversation). That broke Spike C's own
// smoke test (clicking a sidebar card now navigates on an execution-derived
// id the still-task-keyed batch endpoint couldn't resolve) without touching
// Spike D's hardcoded task-id env var, which still needs the ORIGINAL
// task-keyed shape (id = task.id, no attempt suffix) to keep working
// unmodified.
//
// Fixed by trying execution-id resolution first, via events.ts's
// resolveExecutionOwner (reused, not reimplemented - both routers now agree
// on what "which task owns this execution" means); if that scan finds no
// owning task, falls back to the exact pre-Spike-F behavior: treat the id as
// a task id directly and build a task-keyed AppConversation via
// mapTaskToAppConversation.
async function resolveConversationById(
  id: string,
  projects: Map<string, RepoProject>,
): Promise<AppConversation | null> {
  const owner = await resolveExecutionOwner(id);
  if (owner) {
    return mapExecutionToAppConversation(owner.execution, owner.task, projects.get(owner.task.projectId) ?? null);
  }
  const detail = await getTaskDetail(id);
  if (!detail) return null;
  return mapTaskToAppConversation(detail, projects.get(detail.projectId) ?? null);
}

// GET /api/conversations/search -> {items: AppConversation[], next_page_id}
// Spike F change: was GET /v1/jobs (bare Task[], no executions) + one
// AppConversation per TASK; now fetches each task's full TaskDetail
// (executions[] included) and emits one AppConversation per EXECUTION, via
// mapExecutionToAppConversation - so OpenHands' real, already-working
// sidebar lists every retry attempt as its own card ("attempt-switching for
// free", see service-contract.md). This costs one GET /v1/jobs/:id per task
// (N+1 calls total: 1 for GET /v1/jobs + N for each task's detail) instead
// of the previous single GET /v1/jobs - fine at this prototype's scale (1-2
// seeded tasks); documented as a scaling limitation in service-contract.md,
// not solved here. A task with zero executions yet (still
// QUEUED/AWAITING_FUNDING) contributes zero cards, same as before.
conversationsRouter.get("/search", async (req: Request, res: Response) => {
  try {
    const [tasks, projects] = await Promise.all([getTasks(), projectsById()]);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const details = (
      await Promise.all(tasks.map((task) => getTaskDetail(task.id)))
    ).filter((detail): detail is TaskDetail => detail !== null);
    const page = mapTaskExecutionsToAppConversationPage(details, projects);
    if (limit && limit < page.items.length) {
      page.items = page.items.slice(0, limit);
    }
    res.json(page);
  } catch (err) {
    console.error("[conversations/search]", err);
    res.status(502).json({ error: String(err) });
  }
});

// GET /api/conversations (plural, no :id) -> (AppConversation | null)[]
// NOT one of the plan's originally-scoped 4 endpoints. Discovered while
// debugging the Playwright smoke test's click-through step: the single-
// conversation detail view does NOT call GET /api/conversations/:id at all -
// upstream/src/hooks/query/use-user-conversation.ts calls
// AgentServerConversationService.batchGetAppConversations([cid]), which hits
// this plural, query-string `ids[]`-based endpoint (also present in
// upstream's own mocks/conversation-handlers.ts, just not listed in the
// plan's 4-endpoint contract - that contract was drawn from the *mock
// module's* shape, but the real frontend code path for this exact view uses
// this endpoint, not the singular one). Without it, useActiveConversation()
// resolves `conversation` to undefined once isFetched flips true, which
// routes/conversation.tsx reads as "not found" and redirects back to
// /conversations with a toast - measured directly: the smoke test's
// click-through initially "succeeded" only in the sense of navigating,
// then silently bounced back before the detail view ever rendered.
conversationsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const idsParam = req.query["ids[]"] ?? req.query.ids;
    const ids = Array.isArray(idsParam) ? idsParam.map(String) : idsParam ? [String(idsParam)] : [];
    if (ids.length === 0) {
      res.json([]);
      return;
    }
    const projects = await projectsById();
    const conversations = await Promise.all(ids.map((id) => resolveConversationById(id, projects)));
    res.json(conversations);
  } catch (err) {
    console.error("[conversations (batch)]", err);
    res.status(502).json({ error: String(err) });
  }
});

// GET /api/conversations/:id -> one AppConversation
// Backed by GET /v1/jobs/:id (TaskDetail, includes executions - needed for
// llm_model) + GET /v1/projects (for repository enrichment). Spike F fix:
// `:id` may be either an execution id or a task id - see
// resolveConversationById above.
conversationsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const projects = await projectsById();
    const conversation = await resolveConversationById(req.params.id, projects);
    if (!conversation) {
      res.status(404).json(null);
      return;
    }
    res.json(conversation);
  } catch (err) {
    console.error("[conversations/:id]", err);
    res.status(502).json({ error: String(err) });
  }
});
