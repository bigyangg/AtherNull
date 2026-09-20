import {
  assertTransition,
  CreateJobRequestSchema,
  type TaskStatus,
} from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import {
  HttpError,
  requireOrgSession,
  requirePrivilegedRole,
  sendHttpError,
} from "../session.js";

async function loadOwnedTask(taskId: string, organizationId: string) {
  return db
    .selectFrom("tasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

export async function jobRoutes(app: FastifyInstance) {
  app.post("/v1/jobs", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const body = CreateJobRequestSchema.parse(request.body);

      const project = await db
        .selectFrom("projects")
        .select(["id"])
        .where("id", "=", body.projectId)
        .where("organization_id", "=", organizationId)
        .executeTakeFirst();
      if (!project) {
        reply.status(400).send({ error: "Unknown projectId for this organization" });
        return;
      }

      const agentProfile = await db
        .selectFrom("agent_profiles")
        .select(["id", "config_revision", "policy_version"])
        .where("id", "=", body.agentProfileId)
        .where("organization_id", "=", organizationId)
        .executeTakeFirst();
      if (!agentProfile) {
        reply.status(400).send({ error: "Unknown agentProfileId for this organization" });
        return;
      }

      // CREATED -> AWAITING_FUNDING immediately: a budget was specified but
      // nothing's confirmed paid yet (see POST /v1/jobs/:id/fund).
      assertTransition("CREATED", "AWAITING_FUNDING");

      // repositoryRevision and the agent profile's config_revision/policy_version
      // are snapshotted here, not re-read from their source tables later — a
      // task must stay reproducible against what was actually approved, even
      // if the project's default revision or the agent profile changes
      // afterward (0004_task_reproducibility_snapshot.sql).
      const task = await db
        .insertInto("tasks")
        .values({
          organization_id: organizationId,
          project_id: body.projectId,
          agent_profile_id: body.agentProfileId,
          repository_revision: body.repositoryRevision,
          agent_profile_config_revision: agentProfile.config_revision,
          agent_policy_version: agentProfile.policy_version,
          requirements: body.objective,
          acceptance_criteria: JSON.stringify(body.acceptanceCriteria),
          max_budget_minor: String(body.budgetMinor),
          currency: body.currency,
          status: "AWAITING_FUNDING",
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      reply.status(201).send(task);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Phase 1 stand-in for Phase 5's real Solana escrow confirmation. Writes
  // a payment_intents row and advances AWAITING_FUNDING -> FUNDED -> QUEUED
  // in one call so tasks can reach QUEUED at all before real chain
  // confirmation exists. Replace the body of this handler, not its route,
  // when Phase 5 lands.
  //
  // The read, the payment-intent insert, and the task update all happen
  // inside one transaction: the closing update is guarded by both
  // `status = 'AWAITING_FUNDING'` and `version = <the row we just read>`
  // (optimistic locking), so a concurrent call or a crash between writes
  // can't leave a CONFIRMED payment intent pointing at a task that never
  // actually reached QUEUED. If the guarded update matches no row, the
  // transition didn't happen — throwing rolls back the payment-intent
  // insert too, rather than leaving it orphaned.
  app.post("/v1/jobs/:id/fund", async (request, reply) => {
    try {
      const { organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const updated = await db.transaction().execute(async (trx) => {
        const task = await trx
          .selectFrom("tasks")
          .selectAll()
          .where("id", "=", id)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!task) {
          throw new HttpError(404, "Not found");
        }

        const current = task.status as TaskStatus;
        try {
          assertTransition(current, "FUNDED");
          assertTransition("FUNDED", "QUEUED");
        } catch {
          // A concurrent call can commit between this read and ours, so
          // `current` may legitimately already be past AWAITING_FUNDING by
          // the time we see it — that's the same "someone else already
          // funded this" outcome as the guarded update below matching no
          // rows, not a server bug, and must report the same 409, not an
          // uncaught 500 from assertTransition's raw Error.
          throw new HttpError(409, "Task is no longer awaiting funding");
        }

        await trx
          .insertInto("payment_intents")
          .values({
            job_id: id,
            chain: "stub",
            asset: task.currency,
            amount_minor: task.max_budget_minor,
            actor: "customer",
            idempotency_key: `fund:${id}`,
            status: "CONFIRMED",
          })
          .onConflict((oc) => oc.column("idempotency_key").doNothing())
          .execute();

        const result = await trx
          .updateTable("tasks")
          .set({ status: "QUEUED", version: task.version + 1, updated_at: new Date() })
          .where("id", "=", id)
          .where("organization_id", "=", organizationId)
          .where("status", "=", "AWAITING_FUNDING")
          .where("version", "=", task.version)
          .returningAll()
          .executeTakeFirst();

        if (!result) {
          throw new HttpError(409, "Task is no longer awaiting funding");
        }

        return result;
      });

      reply.send(updated);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get("/v1/jobs", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const tasks = await db
        .selectFrom("tasks")
        .selectAll()
        .where("organization_id", "=", organizationId)
        .orderBy("created_at", "desc")
        .execute();
      reply.send(tasks);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  app.get("/v1/jobs/:id", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const task = await loadOwnedTask(id, organizationId);
      if (!task) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      const executions = await db
        .selectFrom("executions")
        .selectAll()
        .where("task_id", "=", id)
        .orderBy("created_at", "desc")
        .execute();

      reply.send({ ...task, executions });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
