import { randomUUID } from "node:crypto";

import {
  assertTransition,
  CreateUsagePolicyRequestSchema,
  ExtendUsagePolicyRequestSchema,
} from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { MAX_EXECUTION_ATTEMPTS } from "./internal.js";
import { relayRegistry } from "../realtime/relay-registry.js";
import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";
import {
  cumulativeTaskUsage,
  toUsagePauseResponse,
  toUsagePolicyResponse,
} from "../usage-policies.js";

// Phase 4D.2A — Operational Usage Limits + Pause/Resume.
//
// SOFT, POST-RESPONSE operational token limit — never a hard limit, spend
// limit, monetary budget enforcement, dollar ceiling, or funded balance. See
// docs/adr/0012-operational-usage-limits.md and
// packages/contracts/src/usage-policies.ts's header comment for the full
// framing this file must never contradict.
//
// This file is the ONLY code path allowed to insert into
// task_usage_policies, and the ONLY code path that decides how a
// PAUSED_USAGE_LIMIT task resumes. It never writes task.max_budget_minor,
// project_budget_authorizations, cost_minor, or payment_intents (correction
// 23) — pricing stays UNPRICED everywhere, completely untouched by this
// feature.

async function loadOwnedTask(taskId: string, projectId: string, organizationId: string) {
  return db
    .selectFrom("tasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("project_id", "=", projectId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export async function usagePolicyRoutes(app: FastifyInstance) {
  // Privileged-only (same risk tier as fund/verify/accept/reject/estimate
  // approve/budget-authorize — reused verbatim per this phase's own approved
  // authorization precedent). Creates the task's FIRST ACTIVE policy; a task
  // that already has one must use /extend instead (409).
  app.post(
    "/v1/projects/:projectId/tasks/:taskId/usage-policy",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);
        const { projectId, taskId } = z
          .object({ projectId: z.string(), taskId: z.string() })
          .parse(request.params);
        const body = CreateUsagePolicyRequestSchema.parse(request.body);

        const task = await loadOwnedTask(taskId, projectId, organizationId);
        if (!task) {
          reply.status(404).send({ error: "Not found" });
          return;
        }

        try {
          const inserted = await db.transaction().execute(async (trx) => {
            await trx.selectFrom("tasks").select("id").where("id", "=", taskId).forUpdate().executeTakeFirstOrThrow();
            const running = await trx.selectFrom("executions").select("id")
              .where("task_id", "=", taskId).where("status", "=", "RUNNING").executeTakeFirst();
            if (running) throw new HttpError(409, "Set the initial usage limit before execution starts");
            return trx
            .insertInto("task_usage_policies")
            .values({
              organization_id: organizationId,
              project_id: projectId,
              task_id: taskId,
              lineage_id: randomUUID(),
              version: 1,
              metric: body.metric,
              limit_quantity: String(body.limitQuantity),
              status: "ACTIVE",
              authorized_by: userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          });
          reply.status(201).send(toUsagePolicyResponse(inserted));
        } catch (err) {
          if (isUniqueViolation(err)) {
            reply.status(409).send({
              error: "An ACTIVE usage policy already exists for this task — use the /extend endpoint instead",
            });
            return;
          }
          throw err;
        }
      } catch (err) {
        if (sendHttpError(reply, err)) return;
        if (err instanceof z.ZodError) {
          reply.status(400).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // Correction 5/6: strictly increases only, guarded-transaction/optimistic
  // lock so two concurrent extension attempts never silently lose one
  // another — mirrors routes/budget-authorizations.ts's own correction
  // pattern exactly (forUpdate row-lock, then a conditional UPDATE whose
  // numUpdatedRows is checked before proceeding).
  app.post(
    "/v1/projects/:projectId/tasks/:taskId/usage-policy/extend",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);
        const { projectId, taskId } = z
          .object({ projectId: z.string(), taskId: z.string() })
          .parse(request.params);
        const body = ExtendUsagePolicyRequestSchema.parse(request.body);

        const task = await loadOwnedTask(taskId, projectId, organizationId);
        if (!task) {
          reply.status(404).send({ error: "Not found" });
          return;
        }

        const result = await db.transaction().execute(async (trx) => {
          const currentActive = await trx
            .selectFrom("task_usage_policies")
            .selectAll()
            .where("task_id", "=", taskId)
            .where("status", "=", "ACTIVE")
            .forUpdate()
            .executeTakeFirst();

          if (!currentActive) {
            throw new HttpError(404, "No ACTIVE usage policy exists for this task — create one first");
          }

          if (currentActive.version !== body.expectedVersion) {
            throw new HttpError(409, "Usage policy changed; refresh before extending");
          }

          if (body.limitQuantity <= Number(currentActive.limit_quantity)) {
            throw new HttpError(
              409,
              `New limitQuantity (${body.limitQuantity}) must be strictly greater than the current ACTIVE limit (${Number(currentActive.limit_quantity)}) — decreases are not permitted in this phase`,
            );
          }

          const supersedeResult = await trx
            .updateTable("task_usage_policies")
            .set({ status: "SUPERSEDED" })
            .where("id", "=", currentActive.id)
            .where("status", "=", "ACTIVE")
            .executeTakeFirst();
          if (Number(supersedeResult.numUpdatedRows) !== 1) {
            throw new HttpError(409, "Usage policy changed concurrently — retry");
          }

          return trx
            .insertInto("task_usage_policies")
            .values({
              organization_id: organizationId,
              project_id: projectId,
              task_id: taskId,
              lineage_id: currentActive.lineage_id,
              version: currentActive.version + 1,
              metric: currentActive.metric,
              limit_quantity: String(body.limitQuantity),
              status: "ACTIVE",
              supersedes_id: currentActive.id,
              authorized_by: userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        });

        reply.status(201).send(toUsagePolicyResponse(result));
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.status(409).send({ error: "Usage policy changed concurrently — retry" });
          return;
        }
        if (sendHttpError(reply, err)) return;
        if (err instanceof z.ZodError) {
          reply.status(400).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // Reads: plain org membership is enough (same tier as reading an
  // estimate/budget authorization).
  app.get("/v1/projects/:projectId/tasks/:taskId/usage-policy", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { projectId, taskId } = z
        .object({ projectId: z.string(), taskId: z.string() })
        .parse(request.params);

      const task = await loadOwnedTask(taskId, projectId, organizationId);
      if (!task) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      const rows = await db
        .selectFrom("task_usage_policies")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("organization_id", "=", organizationId)
        .orderBy("version", "asc")
        .execute();

      const cumulativeUsage = await cumulativeTaskUsage(taskId);

      reply.send({
        active: rows.find((r) => r.status === "ACTIVE") ? toUsagePolicyResponse(rows.find((r) => r.status === "ACTIVE")!) : null,
        history: rows.map(toUsagePolicyResponse),
        cumulativeUsage,
      });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get("/v1/projects/:projectId/tasks/:taskId/usage-pauses", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { projectId, taskId } = z
        .object({ projectId: z.string(), taskId: z.string() })
        .parse(request.params);

      const task = await loadOwnedTask(taskId, projectId, organizationId);
      if (!task) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      const rows = await db
        .selectFrom("task_usage_pauses")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("organization_id", "=", organizationId)
        .orderBy("paused_at", "asc")
        .execute();

      reply.send(rows.map(toUsagePauseResponse));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Commit authorization before waking the worker. The worker also polls
  // this durable decision, so a dropped relay message cannot lose a resume.
  app.post("/v1/projects/:projectId/tasks/:taskId/usage-limit/resume", async (request, reply) => {
    try {
      const { role, organizationId } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { projectId, taskId } = z.object({ projectId: z.string(), taskId: z.string() }).parse(request.params);
      const result = await db.transaction().execute(async (trx) => {
        const task = await trx.selectFrom("tasks").selectAll()
          .where("id", "=", taskId).where("project_id", "=", projectId)
          .where("organization_id", "=", organizationId).forUpdate().executeTakeFirst();
        if (!task) throw new HttpError(404, "Not found");
        if (task.status !== "PAUSED_USAGE_LIMIT") throw new HttpError(409, "Task is not PAUSED_USAGE_LIMIT");
        const pause = await trx.selectFrom("task_usage_pauses").selectAll()
          .where("task_id", "=", taskId).where("resumed_at", "is", null)
          .orderBy("paused_at", "desc").executeTakeFirst();
        if (!pause) throw new HttpError(409, "No open usage-limit pause found");
        const policy = await trx.selectFrom("task_usage_policies").selectAll()
          .where("task_id", "=", taskId).where("status", "=", "ACTIVE").executeTakeFirst();
        const usage = await cumulativeTaskUsage(taskId);
        if (!policy || Number(policy.limit_quantity) <= Math.max(usage, Number(pause.observed_usage))) {
          throw new HttpError(409, "Extend the limit above observed cumulative task usage before resuming");
        }
        const execution = await trx.selectFrom("executions").selectAll()
          .where("id", "=", pause.execution_id).forUpdate().executeTakeFirstOrThrow();
        const live = execution.status === "RUNNING" && !!execution.lease_owner &&
          !!execution.lease_expires_at && new Date(execution.lease_expires_at).getTime() > Date.now();
        const same = pause.resume_mode === "SAME_EXECUTION" && live;
        if (same) {
          const relay = relayRegistry.get(execution.id);
          if (!relay || relay.workerId !== execution.lease_owner || relay.socket.readyState !== 1) {
            throw new HttpError(409, "Worker lease is live but relay is disconnected; retry after reconnect");
          }
        } else {
          const count = await trx.selectFrom("executions")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("task_id", "=", taskId).executeTakeFirstOrThrow();
          if (Number(count.count) >= MAX_EXECUTION_ATTEMPTS) throw new HttpError(409, "MAX_EXECUTION_ATTEMPTS already reached");
          await trx.updateTable("executions")
            .set({ status: "LEASE_EXPIRED", ended_at: new Date(), lease_owner: null, lease_expires_at: null })
            .where("id", "=", execution.id).execute();
        }
        const mode = same ? "SAME_EXECUTION" as const : "NEW_ATTEMPT" as const;
        assertTransition("PAUSED_USAGE_LIMIT", same ? "RUNNING" : "QUEUED");
        await trx.updateTable("tasks").set({ status: same ? "RUNNING" : "QUEUED", updated_at: new Date() })
          .where("id", "=", taskId).execute();
        await trx.updateTable("task_usage_pauses")
          .set({ resumed_at: new Date(), resume_mode: mode, resume_execution_id: same ? execution.id : null })
          .where("id", "=", pause.id).execute();
        return { mode, executionId: same ? execution.id : null, oldExecutionId: execution.id, policy };
      });
      if (result.mode === "SAME_EXECUTION") {
        relayRegistry.sendCommand(result.oldExecutionId, {
          version: 1, type: "gateway.command", executionId: result.oldExecutionId, eventId: null,
          payload: { commandId: randomUUID(), command: {
            type: "execution.resume_same_conversation",
            payload: { limitQuantity: Number(result.policy.limit_quantity), policyId: result.policy.id },
          } },
        });
      } else {
        relayRegistry.closeAndRemove(result.oldExecutionId, "lease-expired");
      }
      reply.send({ mode: result.mode, taskId, executionId: result.executionId });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) { reply.status(400).send({ error: err.message }); return; }
      throw err;
    }
  });
}
