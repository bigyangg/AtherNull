import type { ResourceEstimate } from "@athernull/contracts";

import { RATE_VERSION, type RateConfig } from "./rates.js";

// Phase 4A — pure pricing function. No I/O, no LLM call, no DB access — same
// shape/testing convention as packages/model-router's pure chooseTier().
//
// This is deliberately the ONLY code path in apps/api allowed to compute
// currency/estimatedMinMinor/estimatedMaxMinor/proposedBudgetCapMinor.
// routes/estimates.ts must never assign those fields from anywhere else
// (e.g. the planner's own output, which is untrusted and has no business
// producing a price — see packages/contracts/src/estimates.ts's
// PlannerOutputSchema, which has no price-shaped field at all for the LLM to
// even populate).
export type PricingResult =
  | { status: "UNPRICED" }
  | {
      status: "PRICED";
      currency: string;
      estimatedMinMinor: number;
      estimatedMaxMinor: number;
      proposedBudgetCapMinor: number;
      breakdown: Record<string, unknown>;
      rateVersion: string;
    };

function roundToMinorUnit(value: number): number {
  return Math.max(0, Math.round(value));
}

// proposedBudgetCapMinor policy: a fixed buffer over estimatedMaxMinor,
// rounded up to the nearest whole minor unit. Never computed by the LLM —
// resourceEstimate only ever describes *effort* (duration/complexity/token
// volume), and this function is what turns that into money, under a single
// documented policy (rateConfig.budgetCapBufferRatio), so the same
// resourceEstimate always prices identically regardless of prompt wording.
function computeBudgetCap(estimatedMaxMinor: number, bufferRatio: number): number {
  return Math.ceil(estimatedMaxMinor * (1 + bufferRatio));
}

export function priceEstimate(
  resourceEstimate: ResourceEstimate,
  rateConfig: RateConfig | null,
): PricingResult {
  if (!rateConfig) {
    // Honest default: no rate card configured, so this estimate stays
    // UNPRICED rather than reporting a fabricated dollar figure. See
    // apps/api/src/pricing/rates.ts's module comment.
    return { status: "UNPRICED" };
  }

  const { estimatedDurationHours, inferenceRequirements } = resourceEstimate;

  const tierRate = rateConfig.tiers.find(
    (t) => t.tier === inferenceRequirements.estimatedTier,
  );

  let minMinor: number;
  let maxMinor: number;
  const breakdown: Record<string, unknown> = {
    method: null as string | null,
    durationHours: estimatedDurationHours,
  };

  if (tierRate && inferenceRequirements.estimatedTokens) {
    const { min: minTokens, max: maxTokens } = inferenceRequirements.estimatedTokens;
    minMinor = (minTokens / 1000) * tierRate.minorPerThousandTokens;
    maxMinor = (maxTokens / 1000) * tierRate.minorPerThousandTokens;
    breakdown.method = "token-volume";
    breakdown.tier = tierRate.tier;
    breakdown.minorPerThousandTokens = tierRate.minorPerThousandTokens;
    breakdown.estimatedTokens = inferenceRequirements.estimatedTokens;
  } else {
    // Fall back to a coarse duration-based estimate when the planner didn't
    // (or couldn't) size token volume, or the estimated tier isn't in the
    // rate card.
    minMinor = estimatedDurationHours.min * rateConfig.minorPerEstimatedHour;
    maxMinor = estimatedDurationHours.max * rateConfig.minorPerEstimatedHour;
    breakdown.method = "duration-hours";
    breakdown.minorPerEstimatedHour = rateConfig.minorPerEstimatedHour;
  }

  const estimatedMinMinor = roundToMinorUnit(minMinor);
  const estimatedMaxMinor = Math.max(estimatedMinMinor, roundToMinorUnit(maxMinor));
  const proposedBudgetCapMinor = computeBudgetCap(
    estimatedMaxMinor,
    rateConfig.budgetCapBufferRatio,
  );

  return {
    status: "PRICED",
    currency: rateConfig.currency,
    estimatedMinMinor,
    estimatedMaxMinor,
    proposedBudgetCapMinor,
    breakdown,
    rateVersion: RATE_VERSION,
  };
}
