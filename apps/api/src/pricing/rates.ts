// Phase 4A — static, versioned rate config for turning a PlannerOutput's
// resourceEstimate into a dollar figure.
//
// No real pricing/rate data exists anywhere in this codebase today (audited
// before writing this file: the only dollar-shaped concept anywhere is
// ModelTierSchema.costCeilingMinor, a per-tier spend *ceiling* used for
// routing affordability, not a rate card — see
// packages/contracts/src/agentProfiles.ts and packages/model-router). This
// module is deliberately structured so "pricing is unconfigured" is the
// obvious, honest default: RATE_CONFIG is `null` until a real rate card
// exists, and nothing in this file invents a plausible-looking placeholder
// dollar amount to fill that gap.
//
// When real rates are ready, populate a RateConfig object (bump
// RATE_VERSION alongside it — every PRICED estimate records the rate_version
// it was priced under, so a later rate change never silently reinterprets
// history) and export it in place of `null` below. Nothing else in this
// module's shape needs to change.

export interface RateTierConfig {
  tier: string;
  // Minor-currency-unit cost per 1,000 tokens, used only as a coarse
  // per-tier multiplier until real usage-based metering exists.
  minorPerThousandTokens: number;
}

export interface RateConfig {
  currency: string;
  tiers: RateTierConfig[];
  // Fallback per-hour rate (minor units) for engagements the planner sizes
  // by duration rather than token volume (e.g. no estimatedTokens given).
  minorPerEstimatedHour: number;
  // Fixed buffer applied on top of estimatedMaxMinor to get
  // proposedBudgetCapMinor (see apps/api/src/pricing/engine.ts) — e.g. 0.2
  // for a 20% buffer. Policy-owned here, never computed by the LLM.
  budgetCapBufferRatio: number;
}

// Bump this string whenever RATE_CONFIG changes shape or values. Every
// PRICED project_estimates row stores the rate_version it was priced under
// (0008_project_estimates.sql's rate_version column) so historical estimates
// stay interpretable after a future rate change.
export const RATE_VERSION = "unconfigured";

// No real rate card exists yet — see module comment above. Keep this `null`
// until Phase 4B (or later) supplies real numbers; priceEstimate() treats a
// null RateConfig as "pricing unavailable" and returns an honest UNPRICED
// result rather than fabricating one.
export const RATE_CONFIG: RateConfig | null = null;
