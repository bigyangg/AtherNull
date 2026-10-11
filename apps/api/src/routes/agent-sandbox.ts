import type { FastifyInstance } from "fastify";

import { db } from "../db.js";
import { requireOrgSession, sendHttpError } from "../session.js";

export type SandboxState = "READY" | "PENDING" | "PROVISIONING" | "FAILED" | "NONE";

async function sandboxState(organizationId: string): Promise<{ status: SandboxState; error: string | null }> {
  const server = await db
    .selectFrom("org_agent_servers")
    .select("organization_id")
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  if (server) return { status: "READY", error: null };
  const request = await db
    .selectFrom("agent_sandbox_requests")
    .select(["status", "error"])
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  if (!request) return { status: "NONE", error: null };
  return { status: request.status as SandboxState, error: request.status === "FAILED" ? request.error : null };
}

// ADR-0018 — the organization's agent workspace: its state, and a request to
// create it. Creating it is the sandbox provisioner's job (a separate,
// privileged process); this API never touches Docker.
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
      await db
        .insertInto("agent_sandbox_requests")
        .values({ organization_id: organizationId, requested_by: userId })
        .onConflict((oc) =>
          oc
            .column("organization_id")
            .doUpdateSet({ status: "PENDING", error: null, updated_at: new Date() })
            .where("agent_sandbox_requests.status", "=", "FAILED"),
        )
        .execute();
      reply.status(202).send(await sandboxState(organizationId));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
