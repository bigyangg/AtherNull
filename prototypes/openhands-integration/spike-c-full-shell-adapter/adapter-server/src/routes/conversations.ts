import type { Request, Response, Router } from "express";
import { Router as makeRouter } from "express";

import { getProjects, getTaskDetail, getTasks } from "../athernull-client.js";
import { mapTaskToAppConversation, mapTasksToAppConversationPage } from "../mapping.js";
import type { RepoProject } from "../athernull-types.js";

export const conversationsRouter: Router = makeRouter();

async function projectsById(): Promise<Map<string, RepoProject>> {
  const projects = await getProjects();
  return new Map(projects.map((p) => [p.id, p]));
}

// GET /api/conversations/search -> {items: AppConversation[], next_page_id}
// Backed by GET /v1/jobs (list of Task, organization-scoped by the adapter's
// own held session) + GET /v1/projects (for selected_repository/git_provider
// enrichment). No pagination against AtherNull is attempted here since
// GET /v1/jobs itself returns the full org-scoped list unpaginated; the
// `limit` query param (if present) is honored client-side.
conversationsRouter.get("/search", async (req: Request, res: Response) => {
  try {
    const [tasks, projects] = await Promise.all([getTasks(), projectsById()]);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const page = mapTasksToAppConversationPage(tasks, projects);
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
    const [details, projects] = await Promise.all([
      Promise.all(ids.map((id) => getTaskDetail(id))),
      projectsById(),
    ]);
    res.json(
      details.map((detail) =>
        detail ? mapTaskToAppConversation(detail, projects.get(detail.projectId) ?? null) : null,
      ),
    );
  } catch (err) {
    console.error("[conversations (batch)]", err);
    res.status(502).json({ error: String(err) });
  }
});

// GET /api/conversations/:id -> one AppConversation
// Backed by GET /v1/jobs/:id (TaskDetail, includes executions - needed for
// llm_model) + GET /v1/projects (for repository enrichment).
conversationsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const [detail, projects] = await Promise.all([getTaskDetail(req.params.id), projectsById()]);
    if (!detail) {
      res.status(404).json(null);
      return;
    }
    res.json(mapTaskToAppConversation(detail, projects.get(detail.projectId) ?? null));
  } catch (err) {
    console.error("[conversations/:id]", err);
    res.status(502).json({ error: String(err) });
  }
});
