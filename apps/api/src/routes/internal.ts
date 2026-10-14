import { assertTransition, type TaskStatus } from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { reachableSandboxUrl } from "../agent-gateway/org-server.js";
import { db } from "../db.js";
import { persistExecutionEvents } from "../execution-events.js";
import { requireInternalToken } from "../internal-auth.js";
import { executionBroadcaster } from "../realtime/execution-broadcaster.js";
import { relayRegistry } from "../realtime/relay-registry.js";
import { pinBaseCommit } from "../repos/projects.js";
import { resolveRouting } from "../routing.js";
import { cumulativeTaskUsage, getActivePolicy, toUsagePauseResponse } from "../usage-policies.js";
import { persistUsageEvents } from "../usage-events.js";

// Exported so routes/usage-policies.ts's resume-to-NEW_ATTEMPT path can
// enforce the exact same cap before allowing PAUSED_USAGE_LIMIT -> QUEUED —
// one shared constant, never a second copy that could silently drift.
export const MAX_EXECUTION_ATTEMPTS = 3;

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
        -- Several workers run side by side; at most one build per
        -- organization runs at a time, so one customer's queue cannot take
        -- every worker, and two builds never edit one workspace at once.
        -- (Best effort: two claims racing for the same organization within
        -- one commit can both win; the next claim sees the RUNNING row.)
        WHERE (t.status = 'QUEUED'
               AND NOT EXISTS (
                 SELECT 1 FROM tasks r
                  WHERE r.organization_id = t.organization_id
                    AND r.status = 'RUNNING'
                    AND r.id <> t.id))
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

      const recoveryPause = await trx.selectFrom("task_usage_pauses").select("id")
        .where("task_id", "=", task.id).where("resume_mode", "=", "NEW_ATTEMPT")
        .where("resumed_at", "is not", null).where("resume_execution_id", "is", null)
        .orderBy("paused_at", "desc").executeTakeFirst();
      if (recoveryPause) {
        await trx.updateTable("task_usage_pauses").set({ resume_execution_id: execution.id })
          .where("id", "=", recoveryPause.id).execute();
      }

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
    // ADR-0019: the commit the build starts from in the project's hosted
    // repository; the worker fetches it as a bundle (repo-bundle route).
    const baseCommit = await pinBaseCommit(task, request.log);
    // Request changes (routes/change-requests.ts): the customer's feedback so
    // far, and the delivered version the latest round continues from.
    const changeRequests = await db
      .selectFrom("task_change_requests")
      .select(["round", "feedback", "from_commit", "source"])
      .where("task_id", "=", task.id)
      .orderBy("round", "asc")
      .execute();
    const startCommit = (baseCommit && changeRequests.at(-1)?.from_commit) || baseCommit;

    // Phase 4D.2A — correction 2/19: only present when an ACTIVE
    // task_usage_policies row genuinely exists for this task; a task with no
    // policy gets `usagePolicy: null` and the worker must trigger ZERO new
    // enforcement code paths for it — exactly the pre-existing behavior.
    // `usageBaseline` is the durable sum of usage_events.total_tokens across
    // every OTHER execution already recorded for this task (this brand-new
    // execution row has no usage_events rows yet, so "every other execution"
    // and "the task's cumulative usage right now" are the same query) — the
    // worker adds its own locally-observed current-attempt usage on top of
    // this fixed baseline for its fast-path check (correction 2), while
    // Postgres usage_events remains the durable source of truth throughout.
    const activePolicy = await getActivePolicy(task.id);
    const usageBaseline = await cumulativeTaskUsage(task.id);
    // ADR-0015: when the org has its own sandboxed Agent Server, the build
    // runs there as a conversation (visible live in the Agent Canvas). The
    // worker is trusted infrastructure, so it receives the sandbox key; the
    // browser never does.
    const orgAgentServer = await db
      .selectFrom("org_agent_servers")
      .select(["base_url", "session_api_key"])
      .where("organization_id", "=", task.organization_id)
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
      baseCommit,
      startCommit,
      changeRequests: changeRequests.map((c) => ({ round: c.round, feedback: c.feedback, source: c.source })),
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
      usagePolicy: activePolicy
        ? {
            policyId: activePolicy.id,
            metric: activePolicy.metric,
            limitQuantity: Number(activePolicy.limit_quantity),
          }
        : null,
      usageBaseline,
      orgAgentServer: orgAgentServer
        ? { url: await reachableSandboxUrl(orgAgentServer.base_url), sessionApiKey: orgAgentServer.session_api_key }
        : null,
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

  // Phase 4D.1 — real usage metering. The worker's agent_server_adapter.py
  // UsageForwarder posts here after every genuine conversation.stats REST
  // poll (triggered by the stats-update event, plus one final poll at
  // teardown) — never on the lossy ConversationStateUpdateEvent(key="stats")
  // payload itself. Same lease-ownership check as every other worker->API
  // route here. task_id/project_id/organization_id are deliberately never
  // accepted in this request body — persistUsageEvents derives them itself
  // from the trusted execution_id it already owns. No cost field exists on
  // this wire shape at all: this route can never write a price, by
  // construction, not just by convention.
  app.post("/internal/executions/:id/usage", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId, usageEvents } = z
      .object({
        workerId: z.string().min(1),
        usageEvents: z
          .array(
            z.object({
              providerRequestId: z.string().min(1),
              provider: z.string().min(1),
              model: z.string().min(1),
              inputTokens: z.number().int().min(0),
              outputTokens: z.number().int().min(0),
              cacheReadTokens: z.number().int().min(0),
              cacheWriteTokens: z.number().int().min(0),
              reasoningTokens: z.number().int().min(0),
              observedAt: z.string(),
            }),
          )
          .min(1),
      })
      .parse(request.body);

    const execution = await db
      .selectFrom("executions")
      .select(["id", "lease_owner", "task_id"])
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

    await persistUsageEvents(id, usageEvents);

    const policy = await getActivePolicy(execution.task_id);
    if (policy) {
      const prior = await db.selectFrom("usage_events")
        .select(({ fn }) => fn.coalesce(fn.sum<string>("total_tokens"), sql<string>`0`).as("total"))
        .where("task_id", "=", execution.task_id).where("execution_id", "!=", id).executeTakeFirstOrThrow();
      reply.header("x-task-prior-usage", String(prior.total));
    }
    reply.status(204).send();
  });

  // Phase 4D.2A — worker->API usage-limit pause persistence. Called from
  // agent_server_adapter.py's usage-monitor background thread (the same
  // thread that already calls conversation.pause()/interrupt() — see
  // CommandHandler's own docstring for why calling those REST methods from a
  // dedicated monitoring thread, distinct from the thread blocking on
  // .run(), is safe) after that thread has already confirmed, by re-polling
  // the conversation's real execution_status, that the agent genuinely
  // stopped (never trusted from a 200 response alone).
  //
  // Idempotency (correction 10a/11): a duplicate/replayed call for the same
  // execution — worker retry, relay/event replay, a second stats-update
  // trigger racing the first — must never re-run enforcement or double
  // transition the task. Guarded two ways: (1) task_usage_pauses_one_open_per
  // _execution (0012_task_usage_policies.sql) makes a second OPEN row for the
  // same execution_id impossible at the DB level; (2) this handler checks for
  // an existing open pause row for this exact execution first and, if found,
  // returns it unchanged (200) rather than erroring or re-transitioning —
  // structurally idempotent, not just "unlikely to duplicate."
  app.post("/internal/executions/:id/usage-pause", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        workerId: z.string().min(1),
        policyId: z.string().min(1),
        metric: z.enum(["TOTAL_LLM_TOKENS"]),
        configuredLimit: z.number().int().positive(),
        observedUsage: z.number().int().min(0),
        enforcementAction: z.enum(["PAUSE", "INTERRUPT"]),
        resumeMode: z.enum(["SAME_EXECUTION", "NEW_ATTEMPT"]),
      })
      .parse(request.body);

    const execution = await db
      .selectFrom("executions")
      .innerJoin("tasks", "tasks.id", "executions.task_id")
      .select([
        "executions.id as execution_id",
        "executions.lease_owner as lease_owner",
        "tasks.id as task_id",
        "tasks.project_id as project_id",
        "tasks.organization_id as organization_id",
        "tasks.status as task_status",
      ])
      .where("executions.id", "=", id)
      .executeTakeFirst();

    if (!execution) {
      reply.status(404).send({ error: "Not found" });
      return;
    }
    if (execution.lease_owner !== body.workerId) {
      reply.status(409).send({ error: "Lease no longer owned by this worker" });
      return;
    }

    const existingOpenPause = await db
      .selectFrom("task_usage_pauses")
      .selectAll()
      .where("execution_id", "=", id)
      .where("resumed_at", "is", null)
      .executeTakeFirst();
    if (existingOpenPause) {
      // Structurally idempotent replay — never re-enforce, never
      // re-transition. Same enforcement decision, same durable record.
      reply.status(200).send(toUsagePauseResponse(existingOpenPause));
      return;
    }

    if (execution.task_status !== "RUNNING") {
      // Not a genuine replay (no open pause row exists), yet the task isn't
      // RUNNING either — an anomalous state this handler must reject rather
      // than silently accept, since transitioning would violate the FSM.
      reply.status(409).send({ error: `Task is not RUNNING (currently ${execution.task_status})` });
      return;
    }

    const eventRecord = {
      id: randomUUID(),
      kind: "usage_limit_reached",
      occurredAt: new Date().toISOString(),
      payload: {
        executionId: id,
        taskId: execution.task_id,
        policyId: body.policyId,
        metric: body.metric,
        configuredLimit: body.configuredLimit,
        observedUsage: body.observedUsage,
        enforcementAction: body.enforcementAction,
        resumeMode: body.resumeMode,
        timestamp: new Date().toISOString(),
      },
    };
    const result = await db.transaction().execute(async (trx) => {
      const task = await trx.selectFrom("tasks").select("status")
        .where("id", "=", execution.task_id).forUpdate().executeTakeFirstOrThrow();
      const replay = await trx.selectFrom("task_usage_pauses").selectAll()
        .where("execution_id", "=", id).where("policy_id", "=", body.policyId)
        .orderBy("paused_at", "desc").executeTakeFirst();
      if (replay) return { pause: replay, created: false };
      if (task.status !== "RUNNING") return null;
      const policy = await trx.selectFrom("task_usage_policies").selectAll()
        .where("id", "=", body.policyId).where("task_id", "=", execution.task_id).executeTakeFirst();
      if (!policy || Number(policy.limit_quantity) !== body.configuredLimit ||
          (body.enforcementAction === "INTERRUPT" && body.resumeMode !== "NEW_ATTEMPT")) return null;
      const inserted = await trx
        .insertInto("task_usage_pauses")
        .values({
          organization_id: execution.organization_id,
          project_id: execution.project_id,
          task_id: execution.task_id,
          execution_id: id,
          policy_id: body.policyId,
          metric: body.metric,
          configured_limit: String(body.configuredLimit),
          observed_usage: String(body.observedUsage),
          enforcement_action: body.enforcementAction,
          resume_mode: body.resumeMode,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      assertTransition("RUNNING", "PAUSED_USAGE_LIMIT");
      await trx
        .updateTable("tasks")
        .set({ status: "PAUSED_USAGE_LIMIT", updated_at: new Date() })
        .where("id", "=", execution.task_id)
        .execute();

      // INTERRUPT/NEW_ATTEMPT: this execution row is done for good — it will
      // never be resumed, only ever superseded by a brand-new execution row
      // once the task is later re-queued (correction 17). PAUSE/
      // SAME_EXECUTION deliberately leaves executions.status untouched
      // ("RUNNING") — it is still, structurally, the live attempt.
      if (body.enforcementAction === "INTERRUPT") {
        await trx
          .updateTable("executions")
          .set({ status: "PAUSED_USAGE_LIMIT", ended_at: new Date() })
          .where("id", "=", id)
          .execute();
      }

      await persistExecutionEvents(id, [eventRecord], trx);
      return { pause: inserted, created: true };
    });

    // Correction 11: reuse the existing execution_events/executionBroadcaster
    // pipe — never a new realtime channel. Payload carries no
    // prompts/secrets/provider credentials.
    if (!result) { reply.status(409).send({ error: "Pause no longer matches the task or policy" }); return; }
    if (result.created) executionBroadcaster.publishEvent(id, eventRecord);
    reply.status(result.created ? 201 : 200).send(toUsagePauseResponse(result.pause));
  });

  // The relay is a wake-up signal; only this durable authorization lets a
  // paused worker run again. Polling also recovers a dropped relay command.
  app.post("/internal/executions/:id/usage-resume", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.body);
    const execution = await db.selectFrom("executions").selectAll().where("id", "=", id).executeTakeFirst();
    if (!execution) { reply.status(404).send({ error: "Not found" }); return; }
    if (execution.lease_owner !== workerId || execution.status !== "RUNNING" ||
        !execution.lease_expires_at || new Date(execution.lease_expires_at).getTime() <= Date.now()) {
      reply.status(409).send({ error: "Execution lease is no longer valid" }); return;
    }
    const task = await db.selectFrom("tasks").select("status").where("id", "=", execution.task_id).executeTakeFirstOrThrow();
    const pause = await db.selectFrom("task_usage_pauses").selectAll()
      .where("execution_id", "=", id).orderBy("paused_at", "desc").executeTakeFirst();
    if (task.status !== "RUNNING" || !pause?.resumed_at || pause.resume_execution_id !== id) {
      reply.status(204).send(); return;
    }
    const policy = await getActivePolicy(execution.task_id);
    const usage = await cumulativeTaskUsage(execution.task_id);
    if (!policy || Number(policy.limit_quantity) <= Math.max(usage, Number(pause.observed_usage))) {
      reply.status(204).send(); return;
    }
    reply.send({ policyId: policy.id, limitQuantity: Number(policy.limit_quantity) });
  });

  app.post("/internal/executions/:id/complete", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    // Phase 4D.2A correction 12 — `reason` is an optional machine-readable
    // string, deliberately NOT a new TaskStatus: the only value this
    // codebase's worker ever sends is the literal 'USAGE_ENFORCEMENT_FAILED',
    // set exclusively by agent_server_adapter.py's fail-closed path (both
    // conversation.pause() and conversation.interrupt() failed). Persisted
    // verbatim to executions.failure_reason; never interpreted or branched on
    // here — this route's own outcome/FSM handling is completely unchanged
    // by whether reason is present.
    const { workerId, outcome, reason } = z
      .object({
        workerId: z.string().min(1),
        outcome: z.enum(["success", "failure"]),
        reason: z.string().min(1).optional(),
      })
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
        failure_reason: outcome === "failure" ? (reason ?? null) : null,
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

    // Attempts since the latest change request: each round the customer asks
    // for gets the full retry allowance, not what earlier rounds left over.
    const latestChange = await db
      .selectFrom("task_change_requests")
      .select("created_at")
      .where("task_id", "=", task.id)
      .orderBy("round", "desc")
      .limit(1)
      .executeTakeFirst();
    let attempts = db
      .selectFrom("executions")
      .select(({ fn }) => [fn.countAll<string>().as("count")])
      .where("task_id", "=", task.id);
    if (latestChange) attempts = attempts.where("created_at", ">", latestChange.created_at);
    const { count } = await attempts.executeTakeFirstOrThrow();

    const willRetry = reason !== "USAGE_ENFORCEMENT_FAILED" && Number(count) < MAX_EXECUTION_ATTEMPTS;
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
