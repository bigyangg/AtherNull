import type { FastifyInstance } from "fastify";
import { sql } from "kysely";

import { db } from "../db.js";
import { requireOrgSession, sendHttpError } from "../session.js";

// One list of everything in flight for the org (ADR-0018 Builds page):
// drafts (a plan with no build yet) and builds (tasks), newest first. Read
// only — every action still goes through its own guarded endpoint.
export interface BuildListItem {
  kind: "draft" | "build";
  id: string; // lineage id for drafts, task id for builds
  projectId: string;
  repository: string;
  title: string;
  status: string; // estimate status for drafts, task status for builds
  updatedAt: string;
}

const MARKER = "[Planned from a canvas discussion]";

export async function buildRoutes(app: FastifyInstance) {
  app.get("/v1/builds", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);

      const tasks = await db
        .selectFrom("tasks")
        .innerJoin("projects", "projects.id", "tasks.project_id")
        .select(["tasks.id", "tasks.project_id", "tasks.requirements", "tasks.status", "tasks.updated_at", "projects.permitted_repository"])
        .where("tasks.organization_id", "=", organizationId)
        .orderBy("tasks.updated_at", "desc")
        .limit(50)
        .execute();

      // Latest version of each lineage that never produced a task.
      const drafts = await sql<{
        lineage_id: string;
        project_id: string;
        status: string;
        source_prompt: string;
        goal: string | null;
        created_at: Date;
        permitted_repository: string;
      }>`
        select distinct on (e.lineage_id)
               e.lineage_id, e.project_id, e.status, e.source_prompt,
               e.planner_output->>'goal' as goal, e.created_at, p.permitted_repository
          from project_estimates e
          join projects p on p.id = e.project_id
         where e.organization_id = ${organizationId}
           and not exists (
             select 1 from tasks t
               join project_estimates x on x.id = t.source_estimate_id
              where x.lineage_id = e.lineage_id
           )
         order by e.lineage_id, e.version desc
      `.execute(db);

      const items: BuildListItem[] = [
        ...tasks.map((t) => ({
          kind: "build" as const,
          id: t.id,
          projectId: t.project_id,
          repository: t.permitted_repository,
          title: t.requirements,
          status: t.status,
          updatedAt: t.updated_at.toISOString(),
        })),
        ...drafts.rows.map((d) => ({
          kind: "draft" as const,
          id: d.lineage_id,
          projectId: d.project_id,
          repository: d.permitted_repository,
          title: d.goal ?? (d.source_prompt.startsWith(MARKER) ? "Planned from a discussion" : d.source_prompt),
          status: d.status,
          updatedAt: d.created_at.toISOString(),
        })),
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      reply.send(items);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
