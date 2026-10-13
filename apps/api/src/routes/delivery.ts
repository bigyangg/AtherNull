// Delivery: the accepted build's complete project, as a zip of the result
// commit in the project's hosted repository (ADR-0019).
//
// Only once the customer has accepted the build (ACCEPTED / SETTLING /
// SETTLED): before that they get the verified preview, not the code, so the
// work cannot be taken and then rejected for a refund.

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { archiveOf, repoPath } from "../repos/index.js";
import { HttpError, requireOrgSession, sendHttpError } from "../session.js";

export const DOWNLOADABLE_STATUSES = new Set(["ACCEPTED", "SETTLING", "SETTLED"]);

function fileName(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "athernull-build"}-${taskId.slice(0, 8)}.zip`;
}

export async function deliveryRoutes(app: FastifyInstance) {
  app.get("/v1/jobs/:id/download", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const task = await db
        .selectFrom("tasks")
        .innerJoin("projects", "projects.id", "tasks.project_id")
        .select(["tasks.id", "tasks.status", "tasks.result_commit", "tasks.organization_id", "tasks.project_id", "tasks.requirements", "projects.repo_kind"])
        .where("tasks.id", "=", id)
        .where("tasks.organization_id", "=", organizationId)
        .executeTakeFirst();
      if (!task) throw new HttpError(404, "Not found");
      if (!DOWNLOADABLE_STATUSES.has(task.status)) {
        throw new HttpError(409, "The code can be downloaded once you have accepted the build");
      }
      if (task.repo_kind !== "hosted" || !task.result_commit) {
        throw new HttpError(409, "This build has no downloadable code");
      }
      const zip = await archiveOf(repoPath(task.organization_id, task.project_id), task.result_commit);
      reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${fileName(task.requirements, task.id)}"`)
        .header("cache-control", "private, no-store")
        .send(zip);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
