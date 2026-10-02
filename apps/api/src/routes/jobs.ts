import {
  assertTransition,
  CreateJobRequestSchema,
  EstimateJobRequestSchema,
  RejectJobRequestSchema,
  VerifyJobRequestSchema,
  type TaskStatus,
} from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";

import { db } from "../db.js";
import { resolveRouting } from "../routing.js";
import { assertDevnetNetworkPolicy } from "../solana/config.js";
import { FundingError, toHttpError } from "../solana/errors.js";
import { loadFundingByTask, MAX_VERIFICATION_AGE_MS, refreshFundingForGate } from "../solana/funding-service.js";
import { getFundingRuntime } from "../solana/runtime.js";
import { assertTaskProvenanceChain } from "../task-provenance-check.js";
import { getActivePolicy, latestOpenPause, toUsagePauseResponse, toUsagePolicyResponse } from "../usage-policies.js";
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

// Phase 4C — legacy task-creation compatibility gate.
//
// POST /v1/jobs is no longer the canonical way to create a task (that's now
// POST /v1/projects/:projectId/tasks/from-budget-authorization,
// routes/task-provenance.ts) — it's a compatibility-only path that never
// produces provenance, and a task it creates can never pass the hardened
// /fund preconditions below regardless of this flag's state.
//
// Fail-closed by default: the flag must be the EXACT string "true" (not
// "1", not "TRUE", not any other truthy-looking value) or legacy creation is
// rejected with 403. A production deployment simply never sets this
// variable. Test/dev processes that still exercise the legacy path (see
// apps/api/test/{job-lifecycle,tenant-authorization}.test.ts and the Phase 3
// realtime test files) set it explicitly near the top of the file, the same
// way they already set AUTH_TEST_RATE_LIMIT_MAX.
function legacyJobCreationEnabled(): boolean {
  return process.env.ALLOW_LEGACY_JOB_CREATION === "true";
}

export async function jobRoutes(app: FastifyInstance) {
  // Read-only cost quote, no task row created. Any org member can price a
  // task before asking an admin to fund it — reuses the exact same
  // agent_profiles.model_tiers -> chooseTier() lookup the internal claim
  // handler uses at dispatch time (apps/api/src/routing.ts), just without a
  // task to read the signals off of yet.
  app.post("/v1/jobs/estimate", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const body = EstimateJobRequestSchema.parse(request.body);

      const routing = await resolveRouting(body.agentProfileId, organizationId, {
        objective: body.objective,
        acceptanceCriteriaCount: body.acceptanceCriteria.length,
        budgetMinor: body.budgetMinor,
      });

      reply.send({
        tier: routing.routingTier,
        model: routing.resolvedModel,
        score: routing.routingScore,
        reason: routing.routingReason,
        // resolveRouting()/RoutingResult don't carry the chosen tier's own
        // costCeilingMinor (ModelTierSchema has it, chooseTier()'s decision
        // shape doesn't) — always null until that's threaded through.
        costCeilingMinor: null,
      });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.startsWith("Unknown agent profile")) {
        reply.status(400).send({ error: "Unknown agentProfileId for this organization" });
        return;
      }
      throw err;
    }
  });

  // Legacy, compatibility-only task creation — see legacyJobCreationEnabled()'s
  // comment above. Narrowed to requirePrivilegedRole even when enabled: this
  // closes "any org member can self-serve a task" in the compatibility path,
  // matching the canonical endpoint's own privileged-only gate.
  app.post("/v1/jobs", async (request, reply) => {
    try {
      if (!legacyJobCreationEnabled()) {
        reply.status(403).send({
          error:
            "Legacy task creation is disabled. Use POST /v1/projects/:projectId/tasks/from-budget-authorization instead.",
        });
        return;
      }
      const { organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
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

  // "Activate Build" (Phase 4E.1 ADR-0013). The historical route name is kept
  // for compatibility; it is now the activation gate behind REAL Solana
  // devnet funding: AWAITING_FUNDING -> QUEUED only after (a) every Phase 4C
  // provenance check, AND (b) a project_funding_accounts row that is
  // devnet, FUNDED (finalized, program-decoded deposits), >= the DEMO_FIXED
  // requirement, bound to exactly this task/org/project/budget
  // authorization, and recently verified against the finalized chain.
  // There is no env/flag bypass: a direct API call without verified devnet
  // funding can never reach QUEUED. The obsolete stub payment_intents insert
  // is gone (that table is historical legacy state, never used for Solana).
  //
  // The closing update is guarded by both `status = 'AWAITING_FUNDING'` and
  // `version = <the row we just read>` (optimistic locking) and runs in the
  // same transaction as the funding-row lock, so concurrent activations
  // produce exactly one transition. If the guarded update matches no row,
  // the transition didn't happen.
  app.post("/v1/jobs/:id/fund", async (request, reply) => {
    try {
      const { organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      // Phase 4E.1 network policy: fail closed unless SOLANA_NETWORK is
      // exactly "devnet" (mainnet/testnet/unknown/unset are all rejected).
      assertDevnetNetworkPolicy();

      // Freshness: if the funding row exists but its last finalized-chain
      // verification is stale, re-verify against the chain BEFORE the
      // transaction (RPC calls never run inside the DB transaction). An RPC
      // fault here fails closed with 503 — the task is never queued.
      const preFunding = await loadFundingByTask(id, organizationId);
      if (
        preFunding &&
        preFunding.status === "FUNDED" &&
        (!preFunding.verified_at || Date.now() - preFunding.verified_at.getTime() > MAX_VERIFICATION_AGE_MS)
      ) {
        await refreshFundingForGate(getFundingRuntime(), preFunding);
      }

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

        // Phase 4C hardening (extracted to task-provenance-check.ts so Phase 4E.1
        // funding-account creation enforces the identical chain).
        await assertTaskProvenanceChain(trx, task);

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

        // Phase 4E.1 funding gate. Lock the exact funding row; every
        // condition is re-checked here, inside the transaction that performs
        // the AWAITING_FUNDING -> QUEUED transition.
        const funding = await trx
          .selectFrom("project_funding_accounts")
          .selectAll()
          .where("task_id", "=", task.id)
          .forUpdate()
          .executeTakeFirst();
        if (!funding) {
          throw new FundingError("NO_FUNDING_ACCOUNT", "Task has no devnet project funding account; create and fund one first");
        }
        if (
          funding.network !== "devnet" ||
          funding.organization_id !== task.organization_id ||
          funding.project_id !== task.project_id ||
          funding.task_id !== task.id ||
          funding.budget_authorization_id !== task.source_budget_authorization_id
        ) {
          throw new FundingError("INCONSISTENT_STATE", "Funding account does not match this task's network/org/project/budget authorization");
        }
        if (funding.status !== "FUNDED" || BigInt(funding.confirmed_amount_base_units) < BigInt(funding.required_amount_base_units)) {
          throw new FundingError(
            "NOT_FUNDED",
            `Funding is ${funding.status}: ${funding.confirmed_amount_base_units} of ${funding.required_amount_base_units} lamports confirmed (finalized) on Solana devnet`,
          );
        }
        if (!funding.verified_at || Date.now() - funding.verified_at.getTime() > MAX_VERIFICATION_AGE_MS) {
          throw new FundingError("FUNDING_STALE", "Funding verification is stale; verify funding again, then activate");
        }

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
      if (sendHttpError(reply, toHttpError(err))) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Manual, privileged-reviewer gate standing in for Phase 4's independent
  // verifier (services/verifier has no implementation yet). Deliberately
  // NOT called from the internal /complete handler — trusting the worker's
  // own success claim one hop later would still be the worker self-
  // approving, just relabeled. A distinct actor (org admin) recording the
  // outcome here is what PLAN.md's "a worker reports results; it cannot
  // self-approve" non-negotiable actually requires until a real automated
  // verifier exists.
  app.post("/v1/jobs/:id/verify", async (request, reply) => {
    try {
      const { organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = VerifyJobRequestSchema.parse(request.body);
      const nextStatus: TaskStatus = body.outcome === "PASS" ? "AWAITING_ACCEPTANCE" : "FAILED";

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

        try {
          assertTransition(task.status as TaskStatus, nextStatus);
        } catch {
          // Same "someone/something else already moved this task" race as
          // fund's guard below — report 409, not an uncaught 500.
          throw new HttpError(409, "Task is not awaiting verification");
        }

        const execution = await trx
          .selectFrom("executions")
          .select(["id"])
          .where("task_id", "=", id)
          .orderBy("created_at", "desc")
          .executeTakeFirst();

        await trx
          .insertInto("verification_runs")
          .values({
            task_id: id,
            execution_id: execution?.id ?? null,
            verifier_version: body.verifierVersion,
            tests: JSON.stringify(body.tests),
            outcome: body.outcome,
            evidence: JSON.stringify(body.evidence),
          })
          .execute();

        const result = await trx
          .updateTable("tasks")
          .set({ status: nextStatus, version: task.version + 1, updated_at: new Date() })
          .where("id", "=", id)
          .where("organization_id", "=", organizationId)
          .where("status", "=", "VERIFYING")
          .where("version", "=", task.version)
          .returningAll()
          .executeTakeFirst();

        if (!result) {
          throw new HttpError(409, "Task is not awaiting verification");
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

  // Collapses AWAITING_ACCEPTANCE -> ACCEPTED -> SETTLING -> SETTLED in one
  // guarded update, same collapse style `fund` uses for FUNDED -> QUEUED.
  // Settlement stays DB-only here (a payment_intents row, not a real chain
  // call): contracts/solana/plansol.md's locked-in sequencing decision
  // blocks wiring the Solana escrow into apps/api until Phases 1-4 exist.
  // Replace the body of this handler, not its route, when that lands.
  app.post("/v1/jobs/:id/accept", async (request, reply) => {
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

        try {
          assertTransition(task.status as TaskStatus, "ACCEPTED");
          assertTransition("ACCEPTED", "SETTLING");
          assertTransition("SETTLING", "SETTLED");
        } catch {
          throw new HttpError(409, "Task is not awaiting acceptance");
        }

        await trx
          .insertInto("payment_intents")
          .values({
            job_id: id,
            chain: "stub",
            asset: task.currency,
            amount_minor: task.max_budget_minor,
            actor: "platform",
            idempotency_key: `settle:${id}`,
            status: "CONFIRMED",
          })
          .onConflict((oc) => oc.column("idempotency_key").doNothing())
          .execute();

        const result = await trx
          .updateTable("tasks")
          .set({ status: "SETTLED", version: task.version + 1, updated_at: new Date() })
          .where("id", "=", id)
          .where("organization_id", "=", organizationId)
          .where("status", "=", "AWAITING_ACCEPTANCE")
          .where("version", "=", task.version)
          .returningAll()
          .executeTakeFirst();

        if (!result) {
          throw new HttpError(409, "Task is not awaiting acceptance");
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

  // Collapses AWAITING_ACCEPTANCE -> REJECTED -> REFUNDING -> REFUNDED,
  // mirroring accept's structure. Same DB-only settlement scope as accept.
  app.post("/v1/jobs/:id/reject", async (request, reply) => {
    try {
      const { organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      RejectJobRequestSchema.parse(request.body ?? {});

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

        try {
          assertTransition(task.status as TaskStatus, "REJECTED");
          assertTransition("REJECTED", "REFUNDING");
          assertTransition("REFUNDING", "REFUNDED");
        } catch {
          throw new HttpError(409, "Task is not awaiting acceptance");
        }

        await trx
          .insertInto("payment_intents")
          .values({
            job_id: id,
            chain: "stub",
            asset: task.currency,
            amount_minor: task.max_budget_minor,
            actor: "platform",
            idempotency_key: `refund:${id}`,
            status: "CONFIRMED",
          })
          .onConflict((oc) => oc.column("idempotency_key").doNothing())
          .execute();

        const result = await trx
          .updateTable("tasks")
          .set({ status: "REFUNDED", version: task.version + 1, updated_at: new Date() })
          .where("id", "=", id)
          .where("organization_id", "=", organizationId)
          .where("status", "=", "AWAITING_ACCEPTANCE")
          .where("version", "=", task.version)
          .returningAll()
          .executeTakeFirst();

        if (!result) {
          throw new HttpError(409, "Task is not awaiting acceptance");
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

  // Agent Server integration §3/§5: the browser reads persisted events from
  // here, never from an Agent Server container directly — the container's
  // host/api_key (agent_server_adapter.py) never leave the worker process.
  app.get("/v1/jobs/:id/executions/:executionId/events", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id, executionId } = z
        .object({ id: z.string(), executionId: z.string() })
        .parse(request.params);

      const task = await loadOwnedTask(id, organizationId);
      if (!task) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      const execution = await db
        .selectFrom("executions")
        .select(["id"])
        .where("id", "=", executionId)
        .where("task_id", "=", id)
        .executeTakeFirst();
      if (!execution) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      // Replayed events can arrive after newer events have already been read.
      // Return a snapshot until a cursor based on ingestion order is available.
      const events = await db
        .selectFrom("execution_events")
        .selectAll()
        .where("execution_id", "=", executionId)
        .orderBy("occurred_at", "asc")
        .orderBy("id", "asc")
        .execute();

      reply.send(events);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
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

      const verificationRuns = await db
        .selectFrom("verification_runs")
        .selectAll()
        .where("task_id", "=", id)
        .orderBy("created_at", "desc")
        .execute();

      // Phase 4D.1 — real usage metering. budgetSpentMinor must never
      // silently render a fabricated $0.00: it is a genuine 0 only when no
      // usage_events row exists at all for this task's executions (nothing
      // has run yet, so nothing could have cost anything); it becomes null
      // the moment ANY row exists with pricing_status = 'UNPRICED' (which is
      // every row this phase's worker ever writes — no rate card exists yet,
      // see apps/api/src/pricing/rates.ts), because a real dollar total
      // cannot be truthfully computed while part of the underlying usage is
      // of genuinely unknown price. Summing across ALL executions under the
      // task (not just the latest) preserves the pre-existing behavior of
      // adding a retried attempt's usage to the task-level total rather than
      // resetting it.
      const spend = await db
        .selectFrom("executions")
        .leftJoin("usage_events", "usage_events.execution_id", "executions.id")
        .select(({ fn }) => [
          fn.coalesce(
            fn.sum<string>("usage_events.cost_minor"),
            sql<string>`0`,
          ).as("pricedTotal"),
          fn
            .count<string>(
              sql`case when usage_events.pricing_status = 'UNPRICED' then 1 end`,
            )
            .as("unpricedCount"),
          fn.count<string>("usage_events.id").as("usageRowCount"),
          fn.coalesce(fn.sum<string>("usage_events.input_tokens"), sql<string>`0`).as("inputTokens"),
          fn.coalesce(fn.sum<string>("usage_events.output_tokens"), sql<string>`0`).as("outputTokens"),
          fn.coalesce(fn.sum<string>("usage_events.cache_read_tokens"), sql<string>`0`).as("cacheReadTokens"),
          fn.coalesce(fn.sum<string>("usage_events.cache_write_tokens"), sql<string>`0`).as("cacheWriteTokens"),
          fn.coalesce(fn.sum<string>("usage_events.reasoning_tokens"), sql<string>`0`).as("reasoningTokens"),
          fn.coalesce(fn.sum<string>("usage_events.total_tokens"), sql<string>`0`).as("totalTokens"),
        ])
        .where("executions.task_id", "=", id)
        .executeTakeFirstOrThrow();

      const hasUnpricedUsage = Number(spend.unpricedCount) > 0;
      const budgetSpentMinor = hasUnpricedUsage ? null : Number(spend.pricedTotal);

      // Phase 4D.2A — SOFT, POST-RESPONSE token-usage limit surfaced
      // alongside the existing (monetary) budget fields, never merged into
      // them: `usageLimit` is null when no ACTIVE task_usage_policies row
      // exists for this task (correction 19 — no policy, no new behavior).
      // `openPause` is the task's current unresolved pause record, if any
      // (correction 20: always the REAL observed usage, never clamped to
      // configuredLimit).
      const activeUsagePolicy = await getActivePolicy(id);
      const openPause = await latestOpenPause(id);
      const usageLimit = activeUsagePolicy
        ? {
            policy: toUsagePolicyResponse(activeUsagePolicy),
            cumulativeUsage: Number(spend.totalTokens),
            openPause: openPause ? toUsagePauseResponse(openPause) : null,
          }
        : null;

      reply.send({
        ...task,
        executions,
        verificationRuns,
        budgetSpentMinor,
        usage: {
          inputTokens: Number(spend.inputTokens),
          outputTokens: Number(spend.outputTokens),
          cacheReadTokens: Number(spend.cacheReadTokens),
          cacheWriteTokens: Number(spend.cacheWriteTokens),
          reasoningTokens: Number(spend.reasoningTokens),
          totalTokens: Number(spend.totalTokens),
        },
        // Always UNPRICED in this phase — no rate card exists yet
        // (apps/api/src/pricing/rates.ts's RATE_CONFIG is null), so nothing
        // anywhere in this codebase can currently produce a PRICED
        // usage_events row. This field exists so the API is future-proof
        // for Phase 4D.2 without another shape change, and so today's
        // clients never have to infer "unpriced" from an absent field.
        pricing: { status: "UNPRICED", amountMinor: null, currency: null },
        usageLimit,
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
}
