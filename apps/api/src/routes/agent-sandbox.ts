import type { FastifyInstance } from "fastify";

import { requestSandbox, sandboxState } from "../sandbox/requests.js";
import { requireOrgSession, sendHttpError } from "../session.js";

export type { SandboxState } from "../sandbox/requests.js";

// ADR-0018 — the organization's agent workspace: its state (with the
// provisioner's progress, for the canvas setup screen), and a request to
// create it. Creating it is the sandbox provisioner's job (a separate,
// privileged process); this API never touches Docker. Requests are also
// made automatically at a verified user's first sign-in (auth.ts).
export async function agentSandboxRoutes(app: FastifyInstance) {
  app.get("/v1/agent-sandbox", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      reply.send(await sandboxState(organizationId));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  // Idempotent. Any member may ask; a FAILED request is retried. It takes no
  // body: drop a stray JSON content-type on an empty one rather than 400.
  const allowEmptyJson = {
    onRequest: async (request: { headers: Record<string, unknown> }) => {
      if (Number(request.headers["content-length"] ?? 0) === 0) delete request.headers["content-type"];
    },
  };
  app.post("/v1/agent-sandbox", allowEmptyJson, async (request, reply) => {
    try {
      const { organizationId, userId } = await requireOrgSession(request);
      const current = await sandboxState(organizationId);
      if (current.status === "READY") return reply.send(current);
      await requestSandbox(organizationId, userId, { retryFailed: true });
      reply.status(202).send(await sandboxState(organizationId));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
