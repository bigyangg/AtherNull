import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResourceEstimate } from "@athernull/contracts";

import { priceEstimate } from "../src/pricing/engine.js";
import { RATE_CONFIG, RATE_VERSION, type RateConfig } from "../src/pricing/rates.js";

const RESOURCE_ESTIMATE_WITH_TOKENS: ResourceEstimate = {
  complexity: 0.6,
  estimatedDurationHours: { min: 10, max: 30 },
  inferenceRequirements: {
    estimatedTier: "standard",
    estimatedTokens: { min: 100_000, max: 400_000 },
  },
};

const RESOURCE_ESTIMATE_WITHOUT_TOKENS: ResourceEstimate = {
  complexity: 0.3,
  estimatedDurationHours: { min: 5, max: 12 },
  inferenceRequirements: {
    estimatedTier: "fast",
  },
};

const TEST_RATE_CONFIG: RateConfig = {
  currency: "usd",
  tiers: [
    { tier: "fast", minorPerThousandTokens: 5 },
    { tier: "standard", minorPerThousandTokens: 20 },
  ],
  minorPerEstimatedHour: 500,
  budgetCapBufferRatio: 0.2,
};

test("no rate config configured (today's real default) always returns UNPRICED", () => {
  // This is the actual production default today — no real rate card exists
  // yet (apps/api/src/pricing/rates.ts). Pinning this here means the pricing
  // engine's real-world behavior is covered, not just its hypothetical
  // PRICED branch below.
  assert.equal(RATE_CONFIG, null);
  const result = priceEstimate(RESOURCE_ESTIMATE_WITH_TOKENS, RATE_CONFIG);
  assert.deepEqual(result, { status: "UNPRICED" });
});

test("null rate config always returns UNPRICED regardless of resourceEstimate shape", () => {
  const result = priceEstimate(RESOURCE_ESTIMATE_WITHOUT_TOKENS, null);
  assert.deepEqual(result, { status: "UNPRICED" });
});

test("priced by token volume when the tier and estimatedTokens are both known", () => {
  const result = priceEstimate(RESOURCE_ESTIMATE_WITH_TOKENS, TEST_RATE_CONFIG);
  assert.equal(result.status, "PRICED");
  if (result.status !== "PRICED") return;
  assert.equal(result.currency, "usd");
  // 100_000 / 1000 * 20 = 2000; 400_000 / 1000 * 20 = 8000
  assert.equal(result.estimatedMinMinor, 2000);
  assert.equal(result.estimatedMaxMinor, 8000);
  assert.equal(result.rateVersion, RATE_VERSION);
  assert.equal(result.breakdown.method, "token-volume");
});

test("proposedBudgetCapMinor is a fixed buffer over estimatedMaxMinor, never LLM-derived", () => {
  const result = priceEstimate(RESOURCE_ESTIMATE_WITH_TOKENS, TEST_RATE_CONFIG);
  assert.equal(result.status, "PRICED");
  if (result.status !== "PRICED") return;
  // ceil(8000 * 1.2) = 9600
  assert.equal(result.proposedBudgetCapMinor, 9600);
  assert.ok(result.proposedBudgetCapMinor >= result.estimatedMaxMinor);
});

test("falls back to duration-hours pricing when estimatedTokens is absent", () => {
  const result = priceEstimate(RESOURCE_ESTIMATE_WITHOUT_TOKENS, TEST_RATE_CONFIG);
  assert.equal(result.status, "PRICED");
  if (result.status !== "PRICED") return;
  // 5 * 500 = 2500; 12 * 500 = 6000
  assert.equal(result.estimatedMinMinor, 2500);
  assert.equal(result.estimatedMaxMinor, 6000);
  assert.equal(result.breakdown.method, "duration-hours");
});

test("falls back to duration-hours pricing when the estimated tier isn't in the rate card", () => {
  const unknownTierEstimate: ResourceEstimate = {
    ...RESOURCE_ESTIMATE_WITH_TOKENS,
    inferenceRequirements: {
      estimatedTier: "nonexistent-tier",
      estimatedTokens: { min: 100_000, max: 400_000 },
    },
  };
  const result = priceEstimate(unknownTierEstimate, TEST_RATE_CONFIG);
  assert.equal(result.status, "PRICED");
  if (result.status !== "PRICED") return;
  assert.equal(result.breakdown.method, "duration-hours");
});

test("estimatedMinMinor is never negative and estimatedMaxMinor never falls below estimatedMinMinor", () => {
  const zeroEstimate: ResourceEstimate = {
    complexity: 0,
    estimatedDurationHours: { min: 0, max: 0 },
    inferenceRequirements: { estimatedTier: "fast", estimatedTokens: { min: 0, max: 0 } },
  };
  const result = priceEstimate(zeroEstimate, TEST_RATE_CONFIG);
  assert.equal(result.status, "PRICED");
  if (result.status !== "PRICED") return;
  assert.equal(result.estimatedMinMinor, 0);
  assert.equal(result.estimatedMaxMinor, 0);
  assert.ok(result.proposedBudgetCapMinor >= 0);
});

test("is a pure function: same inputs always produce the same output, no I/O", () => {
  const a = priceEstimate(RESOURCE_ESTIMATE_WITH_TOKENS, TEST_RATE_CONFIG);
  const b = priceEstimate(RESOURCE_ESTIMATE_WITH_TOKENS, TEST_RATE_CONFIG);
  assert.deepEqual(a, b);
});
