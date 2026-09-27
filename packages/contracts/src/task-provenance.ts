import { z } from "zod";

// Phase 4C — Provenance-Bound Task Creation and Execution Activation Gate.
//
// POST /v1/projects/:projectId/tasks/from-budget-authorization
//
// The canonical (non-legacy) way to create a task. Never trusts a
// client-supplied organizationId/estimateId/estimateVersion/amount/currency
// — all of that is derived server-side from the persisted, ACTIVE
// project_budget_authorizations row (and, transitively, its APPROVED
// project_estimates row). See apps/api/src/routes/task-provenance.ts's
// header comment for the full atomic-consumption algorithm.
//
// agentProfileId/repositoryRevision are NOT produced by the planner/
// estimate pipeline anywhere upstream — nothing in Phase 4A/4B's
// PlannerOutputSchema carries either of them, so (same as legacy
// CreateJobRequestSchema) the caller must still supply them explicitly.
// Fabricating a default for either would silently pick an agent
// profile/commit the caller never actually chose.
export const PrepareBuildRequestSchema = z.object({
  budgetAuthorizationId: z.string(),
  agentProfileId: z.string(),
  repositoryRevision: z.string(),
});
export type PrepareBuildRequest = z.infer<typeof PrepareBuildRequestSchema>;
