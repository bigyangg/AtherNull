import { z } from "zod";

// Phase 4B — Authorized Project Budget and Build Activation Boundary.
//
// A budget authorization commits a real money amount against an EXACT,
// APPROVED project_estimates row (never a lineage, never "current/latest").
// This is deliberately NOT funding, not settlement, and does not create a
// task — see apps/api/src/routes/budget-authorizations.ts's header comment
// and docs/adr/0009-authorized-project-budget.md for the full boundary.

export const BudgetAuthorizationSourceSchema = z.enum([
  // The estimate's own persisted, model-independent proposed_budget_cap_minor
  // (only valid when the target estimate is pricing_status='PRICED').
  "ESTIMATE_PROPOSED_CAP",
  // An explicit amount the privileged user typed in — the only valid source
  // when the target estimate is UNPRICED.
  "USER_SET",
]);
export type BudgetAuthorizationSource = z.infer<typeof BudgetAuthorizationSourceSchema>;

export const BudgetAuthorizationStatusSchema = z.enum(["ACTIVE", "SUPERSEDED"]);
export type BudgetAuthorizationStatus = z.infer<typeof BudgetAuthorizationStatusSchema>;

// Upper bound mirrors the DB check constraint
// (project_budget_authorizations.amount_minor <= 100000000000) — kept in
// sync deliberately so a malformed/out-of-bound amount is rejected with a
// clear 400 at the contract layer instead of surfacing as a raw Postgres
// constraint-violation 500.
const MAX_AMOUNT_MINOR = 100_000_000_000;

// amount_minor must be a whole number of minor currency units (e.g. cents) —
// never a float, never a numeric string, never NaN/Infinity. z.number().int()
// already rejects floats/NaN/Infinity; the explicit .safe() bound plus the
// max below reject anything a client could otherwise sneak past
// Number.MAX_SAFE_INTEGER before it reaches the bigint column.
const AmountMinorSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_AMOUNT_MINOR);

// POST /v1/projects/:projectId/estimates/:estimateId/budget-authorization
//
// source: "USER_SET" requires amountMinor + currency. source:
// "ESTIMATE_PROPOSED_CAP" requires currency (validated server-side to match
// the estimate's own persisted currency) and, if amountMinor is supplied at
// all, it must exactly equal the estimate's persisted
// proposed_budget_cap_minor — the server never substitutes a mismatched
// client-supplied amount, it rejects it (see the route's own comment).
export const AuthorizeBudgetRequestSchema = z.object({
  source: BudgetAuthorizationSourceSchema,
  amountMinor: AmountMinorSchema.optional(),
  currency: z.string().min(1),
});
export type AuthorizeBudgetRequest = z.infer<typeof AuthorizeBudgetRequestSchema>;

// Wire shape for GET/authorize responses — camelCase, mirrors
// ProjectBudgetAuthorizationsTable (packages/database/src/schema.ts).
export const BudgetAuthorizationResponseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  estimateId: z.string(),
  estimateLineageId: z.string(),
  estimateVersion: z.number().int(),
  amountMinor: z.number().int(),
  currency: z.string(),
  source: BudgetAuthorizationSourceSchema,
  status: BudgetAuthorizationStatusSchema,
  supersedesId: z.string().nullable(),
  authorizedBy: z.string(),
  authorizedAt: z.string(),
  createdAt: z.string(),
});
export type BudgetAuthorizationResponse = z.infer<typeof BudgetAuthorizationResponseSchema>;
