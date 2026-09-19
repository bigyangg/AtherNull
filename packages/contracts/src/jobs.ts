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
