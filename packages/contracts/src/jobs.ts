import { z } from "zod";

// POST /v1/jobs request body (spec §7 "Create job request")
export const CreateJobRequestSchema = z.object({
  projectId: z.string(),
  repositoryRevision: z.string(), // immutable commit
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  agentProfileId: z.string(),
  budgetMinor: z.number().int().nonnegative(),
  currency: z.string(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

// Internal work dispatch sent to the OpenHands worker (spec §7).
// resolvedModel is decided by the orchestrator's model router (ADR-0003)
// before dispatch — the worker never chooses its own model.
export const InternalWorkDispatchSchema = z.object({
  jobId: z.string(),
  executionId: z.string(),
  organizationId: z.string(),
  repositorySnapshot: z.string(), // artifact://...
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  agentProfileVersion: z.number().int(),
  resolvedModel: z.string(),
  routingTier: z.string(),
  routingScore: z.number().min(0).max(1),
  routingReason: z.string(),
  budgetMinor: z.number().int().nonnegative(),
  deadline: z.string(), // ISO-8601 UTC
  policyVersion: z.string(),
});
export type InternalWorkDispatch = z.infer<typeof InternalWorkDispatchSchema>;

// POST /v1/jobs/estimate — pre-funding cost quote. Mirrors the fields of
// CreateJobRequestSchema that actually feed routing (no projectId/
// repositoryRevision/currency: those don't affect model choice or cost).
export const EstimateJobRequestSchema = z.object({
  agentProfileId: z.string(),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  budgetMinor: z.number().int().nonnegative(),
});
export type EstimateJobRequest = z.infer<typeof EstimateJobRequestSchema>;

export const EstimateJobResponseSchema = z.object({
  tier: z.string(),
  model: z.string(),
  score: z.number(),
  reason: z.string(),
  costCeilingMinor: z.number().int().nullable(),
});
export type EstimateJobResponse = z.infer<typeof EstimateJobResponseSchema>;

// POST /v1/jobs/:id/verify — a manual, privileged-reviewer gate standing in
// for Phase 4's independent verifier (services/verifier has no
// implementation yet). Recording who/what verified separately from the
// worker's own completion claim is what PLAN.md's "a worker reports
// results; it cannot self-approve" non-negotiable requires.
export const VerifyJobRequestSchema = z.object({
  outcome: z.enum(["PASS", "FAIL"]),
  verifierVersion: z.string().default("manual-v1"),
  tests: z.array(z.object({ name: z.string(), passed: z.boolean() })).default([]),
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type VerifyJobRequest = z.infer<typeof VerifyJobRequestSchema>;

// POST /v1/jobs/:id/reject
export const RejectJobRequestSchema = z.object({
  reason: z.string().optional(),
});
export type RejectJobRequest = z.infer<typeof RejectJobRequestSchema>;
