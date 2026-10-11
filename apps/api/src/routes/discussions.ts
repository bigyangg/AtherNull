import type { FastifyInstance } from "fastify";

import { listDiscussions } from "../agent-gateway/discussions.js";
import { requireOrgSession, sendHttpError } from "../session.js";

// ADR-0016 — the org's pre-funding canvas discussions, so one can be turned
// into a plan ("Turn into a build").
export async function discussionRoutes(app: FastifyInstance) {
  app.get("/v1/discussions", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      reply.send(await listDiscussions(organizationId));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
