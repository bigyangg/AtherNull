import { z } from "zod";

// Phase 4A — Project Scope, Build Plan and Cost Estimate.
//
// PlannerOutputSchema is a plain z.object() (not .strict()) on purpose:
// Zod's default object behavior strips unrecognized keys on `.parse()`
// rather than rejecting them — so a hallucinated field the model invents
// (e.g. a "price"/"cost" field the planner has no business producing; see
// apps/api/src/pricing/engine.ts for the ONLY code path allowed to write
// money fields) is silently dropped, never persisted, without needing a
// separate allowlist step. Required fields missing or wrong-typed still
// fail `.parse()` outright — apps/api/src/planner.ts treats that failure as
// "reject, never persist raw", never as a partial save.
export const ResourceEstimateSchema = z.object({
  complexity: z.number().min(0).max(1),
  estimatedDurationHours: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
  inferenceRequirements: z.object({
    estimatedTier: z.string(),
    estimatedTokens: z
      .object({
        min: z.number().nonnegative(),
        max: z.number().nonnegative(),
      })
      .optional(),
  }),
  storageRequirements: z.string().optional(),
  computeRequirements: z.string().optional(),
  deploymentType: z.string().optional(),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;

export const PlannerOutputSchema = z.object({
  goal: z.string(),
  scope: z.object({
    included: z.array(z.string()),
    excluded: z.array(z.string()),
  }),
  deliverables: z.array(z.string()),
  implementationPlan: z.array(z.string()),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  infrastructureRequirements: z.array(z.string()),
  risks: z.array(z.string()),
  resourceEstimate: ResourceEstimateSchema,
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const EstimateStatusSchema = z.enum([
  "DRAFT",
  "READY_FOR_REVIEW",
  "APPROVED",
  "SUPERSEDED",
]);
export type EstimateStatus = z.infer<typeof EstimateStatusSchema>;

export const PricingStatusSchema = z.enum(["UNPRICED", "PRICED"]);
export type PricingStatus = z.infer<typeof PricingStatusSchema>;

// POST /v1/projects/:projectId/estimates (generate v1) and
// POST /v1/projects/:projectId/estimates/:estimateId/revise (generate vN+1)
// share the same request shape — a free-text prompt describing what to
// build. Nothing here is persisted directly; it only seeds the planner LLM
// call (apps/api/src/planner.ts), whose validated output is what actually
// gets written.
export const GenerateEstimateRequestSchema = z.object({
  prompt: z.string().min(1),
});
export type GenerateEstimateRequest = z.infer<typeof GenerateEstimateRequestSchema>;

export const ReviseEstimateRequestSchema = z.object({
  prompt: z.string().min(1),
});
export type ReviseEstimateRequest = z.infer<typeof ReviseEstimateRequestSchema>;

// POST /v1/projects/:projectId/estimates/:estimateId/approve takes no body
// today — approval targets the exact :estimateId in the URL, never
// "current"/"latest". Kept as an explicit (empty) schema so a future
// approval-note field has an obvious home without changing the route shape.
export const ApproveEstimateRequestSchema = z.object({});
export type ApproveEstimateRequest = z.infer<typeof ApproveEstimateRequestSchema>;

// Wire shape for GET/list/generate/revise/approve responses — camelCase,
// mirrors ProjectEstimatesTable (packages/database/src/schema.ts) but with
// bigint money fields as `number` (safe: minor-unit estimates fit well
// within Number.MAX_SAFE_INTEGER) and pricingStatus/status as their real
// enums instead of bare `string`.
export const EstimateResponseSchema = z.object({
  id: z.string(),
  lineageId: z.string(),
  version: z.number().int(),
  status: EstimateStatusSchema,
  organizationId: z.string(),
  projectId: z.string(),
  sourcePrompt: z.string(),
  plannerOutput: PlannerOutputSchema,
  plannerModel: z.string(),
  pricingStatus: PricingStatusSchema,
  currency: z.string().nullable(),
  estimatedMinMinor: z.number().int().nullable(),
  estimatedMaxMinor: z.number().int().nullable(),
  proposedBudgetCapMinor: z.number().int().nullable(),
  pricingBreakdown: z.unknown().nullable(),
  rateVersion: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
});
export type EstimateResponse = z.infer<typeof EstimateResponseSchema>;
