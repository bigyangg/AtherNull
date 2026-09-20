import type { FastifyInstance } from "fastify";

import { db } from "../db.js";
import { requireOrgSession, sendHttpError } from "../session.js";

export async function agentProfileRoutes(app: FastifyInstance) {
  app.get("/v1/agent-profiles", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const profiles = await db
        .selectFrom("agent_profiles")
        .selectAll()
        .where("organization_id", "=", organizationId)
        .orderBy("created_at", "asc")
        .execute();
      reply.send(profiles);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
