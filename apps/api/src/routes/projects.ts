import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { requireOrgSession, sendHttpError } from "../session.js";

const CreateProjectSchema = z.object({
  permittedRepository: z.string().min(1),
  revision: z.string().optional(),
  scope: z.string().optional(),
});

export async function projectRoutes(app: FastifyInstance) {
  app.post("/v1/projects", async (request, reply) => {
    try {
      const { userId, organizationId } = await requireOrgSession(request);
      const body = CreateProjectSchema.parse(request.body);

      const project = await db
        .insertInto("projects")
        .values({
          organization_id: organizationId,
          permitted_repository: body.permittedRepository,
          revision: body.revision ?? null,
          scope: body.scope ?? null,
          owner_user_id: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      reply.status(201).send(project);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get("/v1/projects", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const projects = await db
        .selectFrom("projects")
        .selectAll()
        .where("organization_id", "=", organizationId)
        .orderBy("created_at", "desc")
        .execute();
      reply.send(projects);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
