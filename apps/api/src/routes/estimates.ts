import { randomUUID } from "node:crypto";

import {
  ApproveEstimateRequestSchema,
  GenerateEstimateRequestSchema,
  ReviseEstimateRequestSchema,
  type EstimateResponse,
} from "@athernull/contracts";
import type { ProjectEstimatesTable } from "@athernull/database";
import type { FastifyInstance } from "fastify";
import type { Selectable } from "kysely";
import { z } from "zod";

import { db } from "../db.js";
import { PlannerError, generatePlannerOutput } from "../planner.js";
import { priceEstimate } from "../pricing/engine.js";
import { RATE_CONFIG } from "../pricing/rates.js";
import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";

// Phase 4A — Project Scope, Build Plan and Cost Estimate.
//
// Hard invariant for this file (verified by a static grep test,
// apps/api/test/estimates-no-execution-path.test.ts): generating, revising,
// or approving an estimate must NEVER write a task's status, call the
// funding endpoint, insert an execution row, or otherwise reach dispatch.
// Nothing in this file selects, inserts, or updates the tasks/executions
// tables, and it never imports anything from routes/jobs.ts. Estimates are
// a pre-task planning/pricing artifact — reaching QUEUED only ever happens
// through the privileged fund transition those other route files own.

function toEstimateResponse(row: Selectable<ProjectEstimatesTable>): EstimateResponse {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    version: row.version,
    status: row.status as EstimateResponse["status"],
    organizationId: row.organization_id,
    projectId: row.project_id,
    sourcePrompt: row.source_prompt,
    plannerOutput: row.planner_output as EstimateResponse["plannerOutput"],
    plannerModel: row.planner_model,
    pricingStatus: row.pricing_status as EstimateResponse["pricingStatus"],
    currency: row.currency,
    estimatedMinMinor: row.estimated_min_minor === null ? null : Number(row.estimated_min_minor),
    estimatedMaxMinor: row.estimated_max_minor === null ? null : Number(row.estimated_max_minor),
    proposedBudgetCapMinor:
      row.proposed_budget_cap_minor === null ? null : Number(row.proposed_budget_cap_minor),
    pricingBreakdown: row.pricing_breakdown ?? null,
    rateVersion: row.rate_version,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    approvedBy: row.approved_by,
    approvedAt:
      row.approved_at === null
        ? null
        : row.approved_at instanceof Date
          ? row.approved_at.toISOString()
          : String(row.approved_at),
  };
}

// Turns a priced/unpriced PricingResult into the row-insertion fields.
// priceEstimate() (apps/api/src/pricing/engine.ts) is the ONLY function in
// this codebase allowed to compute these values — this helper never derives
// them any other way, and the planner's own output (packages/contracts's
// PlannerOutputSchema) has no price-shaped field for it to read even if it
// wanted to.
function pricingColumns(pricing: ReturnType<typeof priceEstimate>) {
  if (pricing.status === "UNPRICED") {
    return {
      pricing_status: "UNPRICED" as const,
      currency: null,
      estimated_min_minor: null,
      estimated_max_minor: null,
      proposed_budget_cap_minor: null,
      pricing_breakdown: null,
      rate_version: null,
    };
  }
  return {
    pricing_status: "PRICED" as const,
    currency: pricing.currency,
    estimated_min_minor: String(pricing.estimatedMinMinor),
    estimated_max_minor: String(pricing.estimatedMaxMinor),
    proposed_budget_cap_minor: String(pricing.proposedBudgetCapMinor),
    pricing_breakdown: JSON.stringify(pricing.breakdown),
    rate_version: pricing.rateVersion,
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

async function loadOwnedEstimate(estimateId: string, projectId: string, organizationId: string) {
  return db
    .selectFrom("project_estimates")
    .selectAll()
    .where("id", "=", estimateId)
    .where("project_id", "=", projectId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

async function currentHead(lineageId: string) {
  return db
    .selectFrom("project_estimates")
    .select(["id", "version", "status"])
    .where("lineage_id", "=", lineageId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
}

// Postgres unique_violation — a last-resort safety net around the DB-level
// constraints (project_estimates_lineage_version_unique,
// project_estimates_one_approved_per_lineage) in case two requests somehow
// race past the application-level guards above. Translated to 409 rather
// than an uncaught 500, mirroring how routes/jobs.ts turns a lost
// optimistic-lock race into 409 rather than surfacing the raw DB error.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export async function estimateRoutes(app: FastifyInstance) {
  // Generate v1 of a new estimate lineage. Any authorized org member may do
  // this (same permission level as creating a task/job) — it is
  // read/plan-only from the business's perspective: no money moves, no
  // execution starts, and privileged approval is a separate, later step.
  app.post("/v1/projects/:projectId/estimates", async (request, reply) => {
    try {
      const { userId, organizationId } = await requireOrgSession(request);
      const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
      const body = GenerateEstimateRequestSchema.parse(request.body);

      const project = await loadOwnedProject(projectId, organizationId);
      if (!project) {
        reply.status(400).send({ error: "Unknown projectId for this organization" });
        return;
      }

      let plannerOutput;
      let plannerModel: string;
      try {
        ({ plannerOutput, plannerModel } = await generatePlannerOutput(body.prompt));
      } catch (err) {
        if (err instanceof PlannerError) {
          reply.status(502).send({ error: err.message });
          return;
        }
        if (err instanceof z.ZodError) {
          reply.status(502).send({ error: `Planner produced invalid output: ${err.message}` });
          return;
        }
        throw err;
      }

      const pricing = priceEstimate(plannerOutput.resourceEstimate, RATE_CONFIG);

      const inserted = await db
        .insertInto("project_estimates")
        .values({
          lineage_id: randomUUID(),
          version: 1,
          // Generated output is fully formed and ready for a privileged
          // reviewer immediately — this phase has no separate "save as
          // draft, keep editing before submitting" authoring step, so DRAFT
          // (retained in the status enum/DB check constraint for future use)
          // is never produced by this endpoint today.
          status: "READY_FOR_REVIEW",
          organization_id: organizationId,
          project_id: projectId,
          source_prompt: body.prompt,
          planner_output: JSON.stringify(plannerOutput),
          planner_model: plannerModel,
          created_by: userId,
          ...pricingColumns(pricing),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      reply.status(201).send(toEstimateResponse(inserted));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get("/v1/projects/:projectId/estimates", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { projectId } = z.object({ projectId: z.string() }).parse(request.params);

      const project = await loadOwnedProject(projectId, organizationId);
      if (!project) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      // All lineages for this project — one call to POST .../estimates
      // starts a fresh lineage each time (a new planning conversation), so a
      // project can accumulate more than one over time.
      const rows = await db
        .selectFrom("project_estimates")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("organization_id", "=", organizationId)
        .orderBy("lineage_id", "asc")
        .orderBy("version", "asc")
        .execute();

      reply.send(rows.map(toEstimateResponse));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.get("/v1/projects/:projectId/estimates/:estimateId", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { projectId, estimateId } = z
        .object({ projectId: z.string(), estimateId: z.string() })
        .parse(request.params);

      const estimate = await loadOwnedEstimate(estimateId, projectId, organizationId);
      if (!estimate) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      reply.send(toEstimateResponse(estimate));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Creates version N+1 in the same lineage as :estimateId and supersedes
  // the previous head in one transaction. :estimateId must name the
  // lineage's current head (the highest version not yet superseded) —
  // revising from a stale version would otherwise leave two live heads in
  // the same lineage, which the DB schema doesn't model.
  //
  // The planner LLM call happens BEFORE the transaction opens (network I/O
  // has no business holding a DB transaction/row lock open), then the
  // supersede-and-insert step locks the target row (`SELECT ... FOR
  // UPDATE`) so a concurrent approve() on the same row and a concurrent
  // revise() on the same row both resolve deterministically via normal
  // Postgres row-lock queuing, mirroring the guarded-update idiom
  // routes/jobs.ts uses for its own state transitions.
  app.post("/v1/projects/:projectId/estimates/:estimateId/revise", async (request, reply) => {
    try {
      const { userId, organizationId } = await requireOrgSession(request);
      const { projectId, estimateId } = z
        .object({ projectId: z.string(), estimateId: z.string() })
        .parse(request.params);
      const body = ReviseEstimateRequestSchema.parse(request.body);

      const project = await loadOwnedProject(projectId, organizationId);
      if (!project) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      let plannerOutput;
      let plannerModel: string;
      try {
        ({ plannerOutput, plannerModel } = await generatePlannerOutput(body.prompt));
      } catch (err) {
        if (err instanceof PlannerError) {
          reply.status(502).send({ error: err.message });
          return;
        }
        if (err instanceof z.ZodError) {
          reply.status(502).send({ error: `Planner produced invalid output: ${err.message}` });
          return;
        }
        throw err;
      }
      const pricing = priceEstimate(plannerOutput.resourceEstimate, RATE_CONFIG);

      const result = await db.transaction().execute(async (trx) => {
        const target = await trx
          .selectFrom("project_estimates")
          .selectAll()
          .where("id", "=", estimateId)
          .where("project_id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .forUpdate()
          .executeTakeFirst();
        if (!target) {
          throw new HttpError(404, "Not found");
        }

        if (target.status === "SUPERSEDED") {
          const head = await currentHead(target.lineage_id);
          throw new HttpError(
            409,
            `Estimate ${estimateId} is superseded — the current head is version ${head.version} (id ${head.id})`,
          );
        }

        // Defensive: with the invariant that revise/approve always keep
        // exactly one non-SUPERSEDED row per lineage, target.status !==
        // SUPERSEDED already implies target is the head. Checked explicitly
        // anyway rather than assumed.
        const head = await currentHead(target.lineage_id);
        if (head.id !== target.id) {
          throw new HttpError(
            409,
            `Estimate ${estimateId} is not the current head — the current head is version ${head.version} (id ${head.id})`,
          );
        }

        const supersedeResult = await trx
          .updateTable("project_estimates")
          .set({ status: "SUPERSEDED" })
          .where("id", "=", target.id)
          .where("status", "=", target.status)
          .executeTakeFirst();
        if (Number(supersedeResult.numUpdatedRows) !== 1) {
          throw new HttpError(409, "Estimate changed concurrently — retry");
        }

        return trx
          .insertInto("project_estimates")
          .values({
            lineage_id: target.lineage_id,
            version: target.version + 1,
            status: "READY_FOR_REVIEW",
            organization_id: organizationId,
            project_id: projectId,
            source_prompt: body.prompt,
            planner_output: JSON.stringify(plannerOutput),
            planner_model: plannerModel,
            created_by: userId,
            ...pricingColumns(pricing),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });

      reply.status(201).send(toEstimateResponse(result));
    } catch (err) {
      if (isUniqueViolation(err)) {
        reply.status(409).send({ error: "Estimate changed concurrently — retry" });
        return;
      }
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Privileged-only (same risk tier as fund/verify/accept/reject). Targets
  // an EXACT estimate id/version — never "current"/"latest". Idempotent:
  // approving an already-APPROVED estimate returns the same success with
  // the original approval metadata, never a duplicate transition or error.
  app.post("/v1/projects/:projectId/estimates/:estimateId/approve", async (request, reply) => {
    try {
      const { userId, organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { projectId, estimateId } = z
        .object({ projectId: z.string(), estimateId: z.string() })
        .parse(request.params);
      ApproveEstimateRequestSchema.parse(request.body ?? {});

      const result = await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("project_estimates")
          .set({ status: "APPROVED", approved_by: userId, approved_at: new Date() })
          .where("id", "=", estimateId)
          .where("project_id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .where("status", "=", "READY_FOR_REVIEW")
          .returningAll()
          .executeTakeFirst();
        if (updated) {
          return updated;
        }

        const current = await trx
          .selectFrom("project_estimates")
          .selectAll()
          .where("id", "=", estimateId)
          .where("project_id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!current) {
          throw new HttpError(404, "Not found");
        }
        if (current.status === "APPROVED") {
          // Idempotent success: already approved (by this or another
          // actor) — return the existing approval, never a duplicate
          // transition, never an error.
          return current;
        }
        if (current.status === "SUPERSEDED") {
          const head = await currentHead(current.lineage_id);
          throw new HttpError(
            409,
            `Estimate ${estimateId} is superseded — approve the current head instead (version ${head.version}, id ${head.id})`,
          );
        }
        // DRAFT (or any other non-terminal status).
        throw new HttpError(409, "Estimate is not ready for review");
      });

      reply.send(toEstimateResponse(result));
    } catch (err) {
      if (isUniqueViolation(err)) {
        reply.status(409).send({ error: "Another version in this lineage is already approved" });
        return;
      }
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
