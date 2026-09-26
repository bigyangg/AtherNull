import {
  AuthorizeBudgetRequestSchema,
  type BudgetAuthorizationResponse,
} from "@athernull/contracts";
import type { ProjectBudgetAuthorizationsTable } from "@athernull/database";
import type { FastifyInstance } from "fastify";
import type { Selectable } from "kysely";
import { z } from "zod";

import { db } from "../db.js";
import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";

// Phase 4B — Authorized Project Budget and Build Activation Boundary.
//
// Hard invariant for this file (verified by a static grep test,
// apps/api/test/budget-authorizations-no-execution-path.test.ts): this file
// must NEVER write a task's status, call the funding endpoint, insert an
// execution/payment_intents row, or otherwise reach dispatch. A budget
// authorization is a pre-task commitment of intent-to-spend against an
// APPROVED estimate — it is not funding, not settlement, and (per the
// explicitly approved Phase 4B decision) it creates ZERO task rows. Turning
// an authorization into a real task/funding/execution flow is entirely
// Phase 4C's job — see docs/adr/0009-authorized-project-budget.md.
//
// This route file is also the ONLY code path in this codebase allowed to
// insert into project_budget_authorizations. Nothing here ever re-asks the
// planner/LLM for a monetary value — pricing amounts either come verbatim
// from project_estimates.proposed_budget_cap_minor (already computed once,
// deterministically, by apps/api/src/pricing/engine.ts) or from an explicit
// amount the privileged caller supplies (source: 'USER_SET').

function toResponse(
  row: Selectable<ProjectBudgetAuthorizationsTable>,
): BudgetAuthorizationResponse {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    estimateId: row.estimate_id,
    estimateLineageId: row.estimate_lineage_id,
    estimateVersion: row.estimate_version,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    source: row.source as BudgetAuthorizationResponse["source"],
    status: row.status as BudgetAuthorizationResponse["status"],
    supersedesId: row.supersedes_id,
    authorizedBy: row.authorized_by,
    authorizedAt:
      row.authorized_at instanceof Date ? row.authorized_at.toISOString() : String(row.authorized_at),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

async function loadOwnedProject(projectId: string, organizationId: string) {
  return db
    .selectFrom("projects")
    .select(["id"])
    .where("id", "=", projectId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

// Postgres unique_violation — last-resort safety net around
// project_budget_authorizations_one_active_per_estimate, in case two
// concurrent authorize requests somehow both pass the application-level
// guard (see the transaction below). Mirrors routes/estimates.ts's
// isUniqueViolation helper exactly.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export async function budgetAuthorizationRoutes(app: FastifyInstance) {
  // Privileged-only (same risk tier as fund/verify/accept/reject/estimate
  // approve) — committing a real money amount is at least as sensitive as
  // any of those. Targets an EXACT :estimateId, never "current/latest".
  //
  // Idempotent: a request that exactly matches the current ACTIVE row's
  // estimate_id + amount_minor + currency + source returns that existing
  // ACTIVE row unchanged (no new row, no supersede). A request that differs
  // in amount/currency/source supersedes the old ACTIVE row and inserts a
  // new one, in the same transaction, mirroring routes/estimates.ts's
  // /revise supersede-in-transaction idiom.
  app.post(
    "/v1/projects/:projectId/estimates/:estimateId/budget-authorization",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);
        const { projectId, estimateId } = z
          .object({ projectId: z.string(), estimateId: z.string() })
          .parse(request.params);
        const body = AuthorizeBudgetRequestSchema.parse(request.body);

        const project = await loadOwnedProject(projectId, organizationId);
        if (!project) {
          reply.status(404).send({ error: "Not found" });
          return;
        }

        const result = await db.transaction().execute(async (trx) => {
          // Row-lock the target estimate for the duration of this
          // transaction — mirrors routes/estimates.ts's /revise pattern —
          // so a concurrent revise() superseding this exact estimate id
          // (which never happens today: revise targets the head, and an
          // APPROVED row can still be revised into a new head, but the
          // APPROVED row itself is never mutated by revise) can't race with
          // this authorize() in a way that reads stale eligibility.
          const estimate = await trx
            .selectFrom("project_estimates")
            .selectAll()
            .where("id", "=", estimateId)
            .where("project_id", "=", projectId)
            .where("organization_id", "=", organizationId)
            .forUpdate()
            .executeTakeFirst();
          if (!estimate) {
            throw new HttpError(404, "Not found");
          }
          if (estimate.status !== "APPROVED") {
            throw new HttpError(
              409,
              `Estimate ${estimateId} is ${estimate.status}, not APPROVED — only an APPROVED estimate may receive a budget authorization`,
            );
          }

          // Pricing semantics (approved decision #8): ESTIMATE_PROPOSED_CAP
          // is only valid when the estimate is genuinely PRICED with a real
          // persisted cap; the server always uses that persisted value
          // verbatim, and rejects rather than silently substitutes if the
          // caller supplied a mismatched amount alongside it. USER_SET is
          // the only valid source for an UNPRICED estimate, and always uses
          // the caller-supplied amount — nothing here ever computes or
          // re-requests a monetary value from the planner/LLM.
          let amountMinor: number;
          if (body.source === "ESTIMATE_PROPOSED_CAP") {
            if (estimate.pricing_status !== "PRICED" || estimate.proposed_budget_cap_minor === null) {
              throw new HttpError(
                400,
                "This estimate is UNPRICED — source must be USER_SET with an explicit amountMinor",
              );
            }
            const persistedCap = Number(estimate.proposed_budget_cap_minor);
            if (body.amountMinor !== undefined && body.amountMinor !== persistedCap) {
              throw new HttpError(
                400,
                `amountMinor (${body.amountMinor}) does not match this estimate's persisted proposed_budget_cap_minor (${persistedCap}) — omit amountMinor to use the persisted cap, or use source: USER_SET for a different amount`,
              );
            }
            if (estimate.currency !== null && body.currency !== estimate.currency) {
              throw new HttpError(
                400,
                `currency (${body.currency}) does not match this estimate's own currency (${estimate.currency})`,
              );
            }
            amountMinor = persistedCap;
          } else {
            if (body.amountMinor === undefined) {
              throw new HttpError(400, "amountMinor is required when source is USER_SET");
            }
            amountMinor = body.amountMinor;
          }
          const currency = body.currency;

          const currentActive = await trx
            .selectFrom("project_budget_authorizations")
            .selectAll()
            .where("estimate_id", "=", estimateId)
            .where("status", "=", "ACTIVE")
            .forUpdate()
            .executeTakeFirst();

          if (
            currentActive &&
            Number(currentActive.amount_minor) === amountMinor &&
            currentActive.currency === currency &&
            currentActive.source === body.source
          ) {
            // Idempotent success: identical request, no new row, no
            // supersede.
            return { row: currentActive, isNew: false };
          }

          if (currentActive) {
            const supersedeResult = await trx
              .updateTable("project_budget_authorizations")
              .set({ status: "SUPERSEDED" })
              .where("id", "=", currentActive.id)
              .where("status", "=", "ACTIVE")
              .executeTakeFirst();
            if (Number(supersedeResult.numUpdatedRows) !== 1) {
              throw new HttpError(409, "Budget authorization changed concurrently — retry");
            }
          }

          const inserted = await trx
            .insertInto("project_budget_authorizations")
            .values({
              organization_id: organizationId,
              project_id: projectId,
              estimate_id: estimate.id,
              estimate_lineage_id: estimate.lineage_id,
              estimate_version: estimate.version,
              amount_minor: String(amountMinor),
              currency,
              source: body.source,
              status: "ACTIVE",
              supersedes_id: currentActive?.id ?? null,
              authorized_by: userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return { row: inserted, isNew: true };
        });

        reply.status(result.isNew ? 201 : 200).send(toResponse(result.row));
      } catch (err) {
        if (isUniqueViolation(err)) {
          reply.status(409).send({ error: "Budget authorization changed concurrently — retry" });
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

  // Reads: current ACTIVE authorization (if any) plus full history for an
  // exact estimate. Plain org membership is enough to read — same tier as
  // reading an estimate.
  app.get(
    "/v1/projects/:projectId/estimates/:estimateId/budget-authorizations",
    async (request, reply) => {
      try {
        const { organizationId } = await requireOrgSession(request);
        const { projectId, estimateId } = z
          .object({ projectId: z.string(), estimateId: z.string() })
          .parse(request.params);

        const estimate = await db
          .selectFrom("project_estimates")
          .select(["id"])
          .where("id", "=", estimateId)
          .where("project_id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!estimate) {
          reply.status(404).send({ error: "Not found" });
          return;
        }

        const rows = await db
          .selectFrom("project_budget_authorizations")
          .selectAll()
          .where("estimate_id", "=", estimateId)
          .where("organization_id", "=", organizationId)
          .orderBy("created_at", "asc")
          .execute();

        reply.send(rows.map(toResponse));
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

  // Reads: every budget authorization across every estimate in a project
  // (current + superseded), newest first within each estimate.
  app.get("/v1/projects/:projectId/budget-authorizations", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { projectId } = z.object({ projectId: z.string() }).parse(request.params);

      const project = await loadOwnedProject(projectId, organizationId);
      if (!project) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      const rows = await db
        .selectFrom("project_budget_authorizations")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("organization_id", "=", organizationId)
        .orderBy("created_at", "asc")
        .execute();

      reply.send(rows.map(toResponse));
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
