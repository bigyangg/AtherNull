import type { Transaction } from "kysely";
import type { Database } from "@athernull/database";

import { HttpError } from "./session.js";

type Task = {
  id: string;
  organization_id: string;
  project_id: string;
  source_estimate_id: string | null;
  source_budget_authorization_id: string | null;
};

// Phase 4C provenance chain, extracted verbatim from POST /v1/jobs/:id/fund so
// that BOTH the funding-account creation (Phase 4E.1) and the activation gate
// enforce the exact same rule: the task must carry fully-chained provenance
// back to an APPROVED estimate and a CONSUMED budget authorization that
// exists solely for this one task. Throws HttpError(409/500) otherwise.
export async function assertTaskProvenanceChain(trx: Transaction<Database>, task: Task): Promise<void> {
  // Phase 4C hardening: /fund now requires the task to carry valid,
  // fully-chained provenance all the way back to an APPROVED estimate
  // and a CONSUMED authorization that exists solely to fund this one
  // task. This is always active, independent of
  // ALLOW_LEGACY_JOB_CREATION's state — a provenance-less task (any
  // task created via the legacy path, or a fabricated fixture) can be
  // created but can never reach QUEUED. There are zero historical
  // AWAITING_FUNDING tasks affected by this (confirmed by the Phase 4C
  // preflight), so this has zero blast radius on existing data.
  if (!task.source_estimate_id || !task.source_budget_authorization_id) {
    throw new HttpError(
      409,
      "Task has no provenance (source_estimate_id/source_budget_authorization_id) — only a task created via POST /v1/projects/:projectId/tasks/from-budget-authorization can be funded",
    );
  }

  const sourceEstimate = await trx
    .selectFrom("project_estimates")
    .selectAll()
    .where("id", "=", task.source_estimate_id)
    .executeTakeFirst();
  if (
    !sourceEstimate ||
    sourceEstimate.project_id !== task.project_id ||
    sourceEstimate.organization_id !== task.organization_id
  ) {
    throw new HttpError(
      409,
      "Task's source estimate is missing or does not match this task's project/organization",
    );
  }
  if (sourceEstimate.status !== "APPROVED") {
    throw new HttpError(
      409,
      `Task's source estimate ${sourceEstimate.id} is ${sourceEstimate.status}, not APPROVED`,
    );
  }

  const sourceAuthorization = await trx
    .selectFrom("project_budget_authorizations")
    .selectAll()
    .where("id", "=", task.source_budget_authorization_id)
    .executeTakeFirst();
  if (
    !sourceAuthorization ||
    sourceAuthorization.organization_id !== task.organization_id ||
    sourceAuthorization.project_id !== task.project_id
  ) {
    throw new HttpError(
      409,
      "Task's source budget authorization is missing or does not match this task's project/organization",
    );
  }
  if (sourceAuthorization.estimate_id !== task.source_estimate_id) {
    throw new HttpError(
      409,
      "Task's source budget authorization does not reference the task's own source estimate",
    );
  }
  if (sourceAuthorization.status !== "CONSUMED") {
    throw new HttpError(
      409,
      `Task's source budget authorization ${sourceAuthorization.id} is ${sourceAuthorization.status}, not CONSUMED`,
    );
  }

  // Defensive: should be structurally guaranteed by
  // tasks_one_per_source_budget_authorization already — confirmed
  // here rather than assumed.
  const linkedTaskCount = await trx
    .selectFrom("tasks")
    .select(({ fn }) => [fn.count<string>("id").as("n")])
    .where("source_budget_authorization_id", "=", sourceAuthorization.id)
    .executeTakeFirstOrThrow();
  if (Number(linkedTaskCount.n) !== 1) {
    throw new HttpError(
      500,
      `Integrity anomaly: budget authorization ${sourceAuthorization.id} is referenced by ${linkedTaskCount.n} tasks, expected exactly 1`,
    );
  }
}
