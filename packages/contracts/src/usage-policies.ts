import { z } from "zod";

// Phase 4D.2A — Operational Usage Limits + Pause/Resume.
//
// SOFT, POST-RESPONSE operational token limit — never a hard limit, spend
// limit, monetary budget enforcement, dollar ceiling, or funded balance. The
// correct statement, verbatim, everywhere this concept is described: "After
// observed cumulative token usage reaches or exceeds the configured usage
// limit, AtherNull pauses the execution at the next safe OpenHands step
// boundary." One already-in-flight response/step may cause overshoot; the
// real observed value is always shown, never clamped down to the configured
// limit. See docs/adr/0012-operational-usage-limits.md.
//
// TOTAL_LLM_TOKENS is the only metric this phase implements, defined
// identically everywhere (worker fast-path check, API aggregates, frontend
// display, tests) as input_tokens + output_tokens — exactly
// usage_events.total_tokens's own existing derivation
// (apps/api/src/usage-events.ts, 0011_usage_metering.sql). Cache/reasoning
// token categories are documented sub-categories already counted inside
// input/output, never additive — see 0011's own comment for the full
// reasoning.
export const UsageMetricSchema = z.enum(["TOTAL_LLM_TOKENS"]);
export type UsageMetric = z.infer<typeof UsageMetricSchema>;

export const UsagePolicyStatusSchema = z.enum(["ACTIVE", "SUPERSEDED"]);
export type UsagePolicyStatus = z.infer<typeof UsagePolicyStatusSchema>;

// Distinguishes exactly how an execution was stopped (correction 8) — never
// used by the UI to imply resumability the system doesn't structurally have.
export const EnforcementActionSchema = z.enum(["PAUSE", "INTERRUPT"]);
export type EnforcementAction = z.infer<typeof EnforcementActionSchema>;

// SAME_EXECUTION: the same worker process/container/conversation is still
// alive and can be resumed via a second conversation.run() call.
// NEW_ATTEMPT: the original execution is unrecoverable (interrupt() fallback
// was used, or the worker/container was later confirmed lost) — resume must
// go through the existing claim/retry architecture for a brand-new execution.
export const ResumeModeSchema = z.enum(["SAME_EXECUTION", "NEW_ATTEMPT"]);
export type ResumeMode = z.infer<typeof ResumeModeSchema>;

// limit_quantity is a plain positive integer count of tokens — never a
// currency amount, never fractional, never zero (a zero-token limit is not a
// meaningful operational policy and would pause before any work could ever
// happen).
const LimitQuantitySchema = z.number().int().positive();

// POST /v1/projects/:projectId/tasks/:taskId/usage-policy — creates the
// task's first ACTIVE policy. Rejected with 409 if one already exists (use
// the /extend endpoint instead — correction 5's "only increases allowed"
// framing only makes sense relative to an existing policy).
export const CreateUsagePolicyRequestSchema = z.object({
  metric: UsageMetricSchema.default("TOTAL_LLM_TOKENS"),
  limitQuantity: LimitQuantitySchema,
});
export type CreateUsagePolicyRequest = z.infer<typeof CreateUsagePolicyRequestSchema>;

// POST /v1/projects/:projectId/tasks/:taskId/usage-policy/extend — correction
// 5: strictly increases only (newLimit > currentActive.limitQuantity), never
// a decrease. A decrease is rejected outright (400/409) — this is a
// deliberate simplification, not an oversight: a stale worker's cached limit
// can only cause an early-ish pause after an extension, never running past a
// newly-lowered limit it hasn't learned about yet.
export const ExtendUsagePolicyRequestSchema = z.object({
  limitQuantity: LimitQuantitySchema,
  expectedVersion: z.number().int().positive(),
});
export type ExtendUsagePolicyRequest = z.infer<typeof ExtendUsagePolicyRequestSchema>;

// Wire shape for GET/create/extend responses — camelCase, mirrors
// TaskUsagePoliciesTable (packages/database/src/schema.ts).
export const UsagePolicyResponseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  lineageId: z.string(),
  version: z.number().int(),
  metric: UsageMetricSchema,
  limitQuantity: z.number().int(),
  status: UsagePolicyStatusSchema,
  supersedesId: z.string().nullable(),
  authorizedBy: z.string(),
  authorizedAt: z.string(),
  createdAt: z.string(),
});
export type UsagePolicyResponse = z.infer<typeof UsagePolicyResponseSchema>;

// Wire shape for GET .../usage-pauses — mirrors TaskUsagePausesTable.
// observed_usage is deliberately never clamped: it can genuinely exceed
// configured_limit (soft, post-response enforcement — see this file's header
// comment), and this schema must never coerce that into looking otherwise.
export const UsagePauseResponseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  executionId: z.string(),
  policyId: z.string(),
  metric: UsageMetricSchema,
  configuredLimit: z.number().int(),
  observedUsage: z.number().int(),
  enforcementAction: EnforcementActionSchema,
  resumeMode: ResumeModeSchema,
  pausedAt: z.string(),
  resumedAt: z.string().nullable(),
  resumeExecutionId: z.string().nullable(),
  createdAt: z.string(),
});
export type UsagePauseResponse = z.infer<typeof UsagePauseResponseSchema>;

// POST /v1/projects/:projectId/tasks/:taskId/usage-limit/resume — takes no
// body: which resume architecture is used (SAME_EXECUTION vs NEW_ATTEMPT) is
// derived server-side from the task's own most recent open pause record,
// never chosen by the caller (correction 16/17: the caller only ever
// expresses intent to resume — "extend then resume are two explicit, separate
// user actions" per correction 18, and which mechanism applies is a fact
// about system state, not a client choice).
export const ResumeUsageLimitResponseSchema = z.object({
  mode: ResumeModeSchema,
  taskId: z.string(),
  // Set only for mode: "SAME_EXECUTION" — the same execution id continues.
  executionId: z.string().nullable(),
});
export type ResumeUsageLimitResponse = z.infer<typeof ResumeUsageLimitResponseSchema>;
