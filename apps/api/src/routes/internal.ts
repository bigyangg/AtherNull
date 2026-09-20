import { assertTransition, type TaskStatus } from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";

import { db } from "../db.js";
import { requireInternalToken } from "../internal-auth.js";
import { resolveRouting } from "../routing.js";

const MAX_EXECUTION_ATTEMPTS = 3;

function leaseSeconds(): number {
  return Number(process.env.EXECUTION_LEASE_SECONDS ?? 300);
}

interface ClaimCandidateRow {
  id: string;
  organization_id: string;
  project_id: string;
  agent_profile_id: string;
  repository_revision: string;
  agent_profile_config_revision: number;
  agent_policy_version: string;
  requirements: string;
  acceptance_criteria: unknown;
  max_budget_minor: string;
  status: string;
  latest_execution_id: string | null;
}

export async function internalRoutes(app: FastifyInstance) {
  // Claims the oldest task that's either freshly QUEUED, or RUNNING with an
  // orphaned (lease-expired) execution — FOR UPDATE SKIP LOCKED means two
  // concurrent claimers never pick the same task, and the lease-expiry
  // check means a crashed worker's task gets reclaimed rather than stuck
  // forever. This is the whole mechanism behind PLAN.md's Phase 1 exit
  // test ("job survives API/worker restart without duplicate execution") —
  // it depends only on Postgres row state, never in-memory process state.
  app.post("/internal/executions/claim", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.body);
    const seconds = leaseSeconds();

    const claimed = await db.transaction().execute(async (trx) => {
      const candidate = await sql<ClaimCandidateRow>`
        SELECT t.id, t.organization_id, t.project_id, t.agent_profile_id,
               t.repository_revision, t.agent_profile_config_revision,
               t.agent_policy_version, t.requirements, t.acceptance_criteria,
               t.max_budget_minor, t.status, latest.id AS latest_execution_id
        FROM tasks t
        LEFT JOIN LATERAL (
          SELECT e.id, e.lease_expires_at
          FROM executions e
          WHERE e.task_id = t.id
          ORDER BY e.created_at DESC
          LIMIT 1
        ) latest ON true
        WHERE t.status = 'QUEUED'
           OR (t.status = 'RUNNING' AND latest.lease_expires_at < now())
        ORDER BY t.created_at
        LIMIT 1
        FOR UPDATE OF t SKIP LOCKED
      `.execute(trx);

      const task = candidate.rows[0];
      if (!task) return null;

      if (task.status === "RUNNING" && task.latest_execution_id) {
        // Orphaned lease from a crashed/restarted worker — the task stays
        // RUNNING (no FSM transition happens), only the stale execution
        // attempt is closed out before a new one is opened below.
        await trx
          .updateTable("executions")
          .set({ status: "LEASE_EXPIRED" })
          .where("id", "=", task.latest_execution_id)
          .execute();
      } else {
        assertTransition(task.status as TaskStatus, "RUNNING");
        await trx
          .updateTable("tasks")
          .set({ status: "RUNNING", updated_at: new Date() })
          .where("id", "=", task.id)
          .execute();
      }

      const execution = await trx
        .insertInto("executions")
        .values({
          task_id: task.id,
          lease_owner: workerId,
          lease_expires_at: sql`now() + make_interval(secs => ${seconds})`,
          status: "RUNNING",
          started_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return { task, execution };
    });

    if (!claimed) {
      reply.status(204).send();
      return;
    }

    const { task, execution } = claimed;
    const acceptanceCriteriaCount = Array.isArray(task.acceptance_criteria)
      ? task.acceptance_criteria.length
      : 0;

    const routing = await resolveRouting(task.agent_profile_id, task.organization_id, {
      objective: task.requirements,
      acceptanceCriteriaCount,
      budgetMinor: Number(task.max_budget_minor),
    });

    await db
      .updateTable("executions")
      .set({
        routing_tier: routing.routingTier,
        routing_score: routing.routingScore,
        routing_reason: routing.routingReason,
        resolved_model: routing.resolvedModel,
      })
      .where("id", "=", execution.id)
      .execute();

    const project = await db
      .selectFrom("projects")
      .select(["permitted_repository"])
      .where("id", "=", task.project_id)
      .executeTakeFirst();

    // repositorySnapshot pairs the project's repo with the revision
    // snapshotted on the task at creation time (task.repository_revision,
    // 0004_task_reproducibility_snapshot.sql) — not the project's current
    // revision, which may have moved on since. Real artifact/content
    // snapshotting is still Phase 3's job; this is just "which commit was
    // approved."
    reply.send({
      jobId: task.id,
      executionId: execution.id,
      organizationId: task.organization_id,
      repositorySnapshot: `${project?.permitted_repository ?? "unknown"}@${task.repository_revision}`,
      objective: task.requirements,
      acceptanceCriteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [],
      agentProfileVersion: task.agent_profile_config_revision,
      resolvedModel: routing.resolvedModel,
      routingTier: routing.routingTier,
      routingScore: routing.routingScore,
      routingReason: routing.routingReason,
      budgetMinor: Number(task.max_budget_minor),
      deadline: new Date(Date.now() + seconds * 1000).toISOString(),
      policyVersion: task.agent_policy_version,
    });
  });

  app.post("/internal/executions/:id/heartbeat", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.body);

    const execution = await db
      .selectFrom("executions")
      .select(["id", "lease_owner"])
      .where("id", "=", id)
      .executeTakeFirst();

    if (!execution) {
      reply.status(404).send({ error: "Not found" });
      return;
    }
    if (execution.lease_owner !== workerId) {
      reply.status(409).send({ error: "Lease no longer owned by this worker" });
      return;
    }

    const updated = await db
      .updateTable("executions")
      .set({ lease_expires_at: sql`now() + make_interval(secs => ${leaseSeconds()})` })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    reply.send(updated);
  });

  app.post("/internal/executions/:id/complete", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId, outcome } = z
      .object({ workerId: z.string().min(1), outcome: z.enum(["success", "failure"]) })
      .parse(request.body);

    const execution = await db
      .selectFrom("executions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!execution) {
      reply.status(404).send({ error: "Not found" });
      return;
    }
    if (execution.lease_owner !== workerId) {
      reply.status(409).send({ error: "Lease no longer owned by this worker" });
      return;
    }

    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", execution.task_id)
      .executeTakeFirstOrThrow();

    if (task.status !== "RUNNING") {
      reply.status(409).send({ error: `Task is not RUNNING (currently ${task.status})` });
      return;
    }

    await db
      .updateTable("executions")
      .set({
        status: outcome === "success" ? "SUCCEEDED" : "FAILED",
        ended_at: new Date(),
      })
      .where("id", "=", id)
      .execute();

    if (outcome === "success") {
      // A worker reports results; it cannot self-approve or release funds
      // (PLAN.md §1) — success only ever reaches VERIFYING, never further.
      // Phase 4's verifier owns AWAITING_ACCEPTANCE.
      assertTransition("RUNNING", "VERIFYING");
      const updated = await db
        .updateTable("tasks")
        .set({ status: "VERIFYING", updated_at: new Date() })
        .where("id", "=", task.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      reply.send(updated);
      return;
    }

    // Failure: RUNNING -> FAILED is always legal; whether the task then
    // stays FAILED or loops back to QUEUED for another attempt (capped at
    // MAX_EXECUTION_ATTEMPTS) is Phase 1's retry policy — see ADR-0003,
    // which flags this as the natural extension of the lease/claim design.
    assertTransition("RUNNING", "FAILED");

    const { count } = await db
      .selectFrom("executions")
      .select(({ fn }) => [fn.countAll<string>().as("count")])
      .where("task_id", "=", task.id)
      .executeTakeFirstOrThrow();

    const willRetry = Number(count) < MAX_EXECUTION_ATTEMPTS;
    if (willRetry) {
      assertTransition("FAILED", "QUEUED");
    }
    const nextStatus: TaskStatus = willRetry ? "QUEUED" : "FAILED";

    const updated = await db
      .updateTable("tasks")
      .set({ status: nextStatus, updated_at: new Date() })
      .where("id", "=", task.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    reply.send(updated);
  });
}
