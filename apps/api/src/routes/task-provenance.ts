import { assertTransition, PrepareBuildRequestSchema, type PlannerOutput } from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";

// Phase 4C — Provenance-Bound Task Creation and Execution Activation Gate.
//
// This is the ONLY canonical way to create a task in this codebase. Legacy
// POST /v1/jobs (routes/jobs.ts) remains a compatibility-only path, gated
// behind ALLOW_LEGACY_JOB_CREATION and fail-closed in production; it never
// produces provenance, and a task it creates can never pass the hardened
// funding-eligibility preconditions in routes/jobs.ts's funding handler.
//
// Canonical flow (see docs/adr/0010-provenance-bound-task-creation.md):
//   APPROVED estimate + ACTIVE budget authorization
//     -> atomic consumption
//     -> task created with source_estimate_id + source_budget_authorization_id
//     -> authorization becomes CONSUMED
//     -> task = AWAITING_FUNDING
//     -> STOP.
// No execution, no conversation, no worker claim, no payment intent, no
// blockchain activity happens here or anywhere downstream of this handler —
// see apps/api/test/task-provenance-no-execution-path.test.ts for the static
// invariant check mirroring the 4A/4B precedent.
//
// One authorization can produce at most one task, ever (retries are
// execution attempts under that one task, not new tasks — see
// executions.unique(task_id, attempt_id)). This is enforced in three
// independent layers:
//   1. This handler's own row-locked (`SELECT ... FOR UPDATE`) transaction,
//      which branches deterministically on the authorization's current
//      status before ever inserting a task.
//   2. The guarded UPDATE at the end of the transaction
//      (`WHERE id = :id AND status = 'ACTIVE'`), which loses cleanly (409)
//      if the authorization was consumed by a concurrent request between
//      the initial read and this update.
//   3. The DB-level partial unique index
//      (tasks_one_per_source_budget_authorization), the final backstop if
//      application-level locking somehow fails.

async function loadOwnedProject(projectId: string, organizationId: string) {
  return db
    .selectFrom("projects")
    .select(["id"])
    .where("id", "=", projectId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

// Postgres unique_violation — last-resort safety net around
// tasks_one_per_source_budget_authorization, mirroring
// routes/{estimates,budget-authorizations}.ts's isUniqueViolation helper
// exactly.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export async function taskProvenanceRoutes(app: FastifyInstance) {
  app.post(
    "/v1/projects/:projectId/tasks/from-budget-authorization",
    async (request, reply) => {
      try {
        const { organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);
        const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
        const body = PrepareBuildRequestSchema.parse(request.body);

        const project = await loadOwnedProject(projectId, organizationId);
        if (!project) {
          reply.status(404).send({ error: "Not found" });
          return;
        }

        // agentProfileId/repositoryRevision are caller-supplied (same as
        // legacy CreateJobRequestSchema) — nothing upstream (planner/
        // estimate/authorization) produces either of them yet. Validated
        // outside the transaction, same as routes/jobs.ts's POST /v1/jobs.
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

        assertTransition("CREATED", "AWAITING_FUNDING");

        const result = await db.transaction().execute(async (trx) => {
          const authorization = await trx
            .selectFrom("project_budget_authorizations")
            .selectAll()
            .where("id", "=", body.budgetAuthorizationId)
            .where("organization_id", "=", organizationId)
            .forUpdate()
            .executeTakeFirst();
          if (!authorization) {
            throw new HttpError(404, "Not found");
          }
          if (authorization.project_id !== projectId) {
            throw new HttpError(404, "Not found");
          }

          if (authorization.status === "CONSUMED") {
            // Idempotent replay: a real task already exists for this exact
            // authorization — return it (200, not 201), never a second task.
            const existingTask = await trx
              .selectFrom("tasks")
              .selectAll()
              .where("source_budget_authorization_id", "=", authorization.id)
              .executeTakeFirst();
            if (existingTask) {
              return { task: existingTask, isNew: false };
            }
            // Integrity anomaly: a CONSUMED authorization with NO linked
            // task should be structurally impossible (this handler only
            // ever sets CONSUMED in the same transaction it inserts the
            // task). Never silently create a second task, never revert the
            // authorization back to ACTIVE — surface this loudly instead.
            request.log.error(
              { budgetAuthorizationId: authorization.id, organizationId, projectId },
              "integrity anomaly: CONSUMED budget authorization has no linked task",
            );
            throw new HttpError(
              500,
              `Integrity anomaly: budget authorization ${authorization.id} is CONSUMED but no task references it — this must be investigated, not retried`,
            );
          }

          if (authorization.status === "SUPERSEDED") {
            throw new HttpError(
              409,
              `Budget authorization ${authorization.id} has been superseded and can no longer be used to create a task`,
            );
          }

          // authorization.status === "ACTIVE" from here on.
          const estimate = await trx
            .selectFrom("project_estimates")
            .selectAll()
            .where("id", "=", authorization.estimate_id)
            .forUpdate()
            .executeTakeFirst();
          if (!estimate) {
            // Should be structurally impossible given the composite FK
            // chain — defensive only.
            throw new HttpError(
              500,
              `Integrity anomaly: budget authorization ${authorization.id} references a nonexistent estimate`,
            );
          }
          if (estimate.status !== "APPROVED") {
            throw new HttpError(
              409,
              `Estimate ${estimate.id} is ${estimate.status}, not APPROVED — only an APPROVED estimate's authorization may create a task`,
            );
          }
          // Defense in depth on top of the DB's own composite FKs — these
          // should be structurally guaranteed already.
          if (estimate.project_id !== projectId || estimate.organization_id !== organizationId) {
            throw new HttpError(409, "Estimate/authorization/project relationship mismatch");
          }
          if (authorization.estimate_id !== estimate.id) {
            throw new HttpError(409, "Authorization does not reference this estimate");
          }

          const plannerOutput = estimate.planner_output as PlannerOutput;

          // repositoryRevision and the agent profile's config_revision/
          // policy_version are snapshotted here, not re-read later — same
          // reproducibility-snapshot rationale as
          // 0004_task_reproducibility_snapshot.sql and routes/jobs.ts.
          const insertedTask = await trx
            .insertInto("tasks")
            .values({
              organization_id: organizationId,
              project_id: projectId,
              agent_profile_id: agentProfile.id,
              repository_revision: body.repositoryRevision,
              agent_profile_config_revision: agentProfile.config_revision,
              agent_policy_version: agentProfile.policy_version,
              requirements: plannerOutput.goal,
              acceptance_criteria: JSON.stringify(plannerOutput.acceptanceCriteria),
              // Deliberate Phase 4C policy decision: max_budget_minor is
              // snapshotted verbatim from the authorized amount, immutably,
              // at task-creation time — the authorized amount IS the
              // natural source of truth for what routing should treat as
              // affordable (chooseTier()'s only use of this field today).
              // This is a considered choice, not an accidental overload of
              // two different meanings under one column — see
              // docs/adr/0010-provenance-bound-task-creation.md.
              max_budget_minor: authorization.amount_minor,
              currency: authorization.currency,
              status: "AWAITING_FUNDING",
              source_estimate_id: estimate.id,
              source_budget_authorization_id: authorization.id,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          const consumeResult = await trx
            .updateTable("project_budget_authorizations")
            .set({ status: "CONSUMED" })
            .where("id", "=", authorization.id)
            .where("status", "=", "ACTIVE")
            .executeTakeFirst();
          if (Number(consumeResult.numUpdatedRows) !== 1) {
            // Lost a race against a concurrent consumer between our initial
            // read and this update — roll back (the task insert above rolls
            // back with it) and report 409, never a partially-applied state.
            throw new HttpError(409, "Budget authorization changed concurrently — retry");
          }

          return { task: insertedTask, isNew: true };
        });

        reply.status(result.isNew ? 201 : 200).send(result.task);
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply
            .status(409)
            .send({ error: "This budget authorization has already been consumed by another task" });
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
}
