import { assertTransition, type TaskStatus } from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";

import { db } from "../db.js";
import { persistExecutionEvents } from "../execution-events.js";
import { requireInternalToken } from "../internal-auth.js";
import { executionBroadcaster } from "../realtime/execution-broadcaster.js";
import { relayRegistry } from "../realtime/relay-registry.js";
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

      let reclaimedExecutionId: string | null = null;
      if (task.status === "RUNNING" && task.latest_execution_id) {
        // Orphaned lease from a crashed/restarted worker — the task stays
        // RUNNING (no FSM transition happens), only the stale execution
        // attempt is closed out before a new one is opened below.
        await trx
          .updateTable("executions")
          .set({ status: "LEASE_EXPIRED" })
          .where("id", "=", task.latest_execution_id)
          .execute();
        reclaimedExecutionId = task.latest_execution_id;
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

      return { task, execution, reclaimedExecutionId };
    });

    if (!claimed) {
      reply.status(204).send();
      return;
    }

    const { task, execution, reclaimedExecutionId } = claimed;

    // ADR-0007 Phase 3B: if this claim reclaimed an orphaned (lease-expired)
    // execution, that execution id's relay registration (if a zombie worker
    // somehow still holds one open) is no longer current — close it
    // proactively rather than leaving it registered indefinitely. This
    // narrows, but does not fully close, the "lease reassigned while a relay
    // is open" race documented in relay-registry.ts and the ADR's Phase 3B
    // status section: between the actual lease timeout and this reclaim,
    // a still-alive zombie worker's relay keeps working undetected.
    if (reclaimedExecutionId) {
      relayRegistry.closeAndRemove(reclaimedExecutionId, "lease-expired");
    }
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

  // Agent Server integration §2: the worker's agent_server_adapter.py calls
  // this right after creating the OpenHands conversation, before .run()
  // starts — so the mapping exists even if the run later fails.
  app.post("/internal/executions/:id/conversation", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId, conversationId } = z
      .object({ workerId: z.string().min(1), conversationId: z.string().min(1) })
      .parse(request.body);

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
      .set({ conversation_id: conversationId })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    reply.send(updated);
  });

  // Agent Server integration §3: the worker forwards Agent Server events here
  // via a callback registered on the OpenHands Conversation, batched. `id` is
  // the Agent Server's own event uuid (not generated here) — ON CONFLICT DO
  // NOTHING makes both normal forwarding and resync_events's gap-recovery
  // replay (§4) idempotent without separate dedupe bookkeeping.
  app.post("/internal/executions/:id/events", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId, events } = z
      .object({
        workerId: z.string().min(1),
        events: z
          .array(
            z.object({
              id: z.string(),
              kind: z.string(),
              occurredAt: z.string(),
              payload: z.unknown(),
            }),
          )
          .min(1),
      })
      .parse(request.body);

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

    const normalizedEvents = events.map((event) => ({
      id: event.id,
      kind: event.kind,
      occurredAt: event.occurredAt,
      payload: event.payload,
    }));
    await persistExecutionEvents(id, normalizedEvents);

    // ADR-0007 Phase 3C fan-out: this is the *authoritative* HTTP batch
    // ingestion path (EventForwarder's own periodic flush, plus the
    // worker's post-run resync_events() gap-fill) — publishing here too
    // (not just from routes/relay.ts's opportunistic relay path) means a
    // subscribed browser still gets live pushes for events delivered this
    // way even when no Phase 3B relay is registered at all (worker running
    // EXECUTION_ADAPTER=direct, or a relay that has already disconnected).
    // Safe to publish unconditionally: an eventId already delivered via the
    // relay path is deduped client-side (and again gateway-side) by its own
    // id, per this protocol's stated invariant — publishing it twice is
    // never incorrect, only occasionally redundant.
    for (const event of normalizedEvents) {
      executionBroadcaster.publishEvent(id, event);
    }

    reply.status(204).send();
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

    // ADR-0007 Phase 3B: execution completion is server-driven and must
    // close any relay registered for it — a relay must never outlive the
    // execution it was relaying, regardless of whether the worker's own
    // relay-side "execution.completed" lifecycle message already arrived.
    relayRegistry.closeAndRemove(id, "execution-completed");
    // ADR-0007 Phase 3C: this is also the single authoritative signal any
    // subscribed browser gateway connection uses to close out its
    // subscription (server-driven completion, never client-inferred, per
    // the ADR). Deliberately the same call site as the relay teardown line
    // above, not a duplicated/independent status check.
    executionBroadcaster.publishCompletion(id, outcome);

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
