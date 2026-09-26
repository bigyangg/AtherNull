import assert from "node:assert/strict";
import { test } from "node:test";

import { PlannerOutputSchema } from "./estimates.js";

function validPlannerOutput() {
  return {
    goal: "Build a small SaaS issue tracker",
    scope: { included: ["issues", "comments"], excluded: ["billing"] },
    deliverables: ["A working web app"],
    implementationPlan: ["Set up auth", "Build issue CRUD"],
    assumptions: ["PostgreSQL is available"],
    acceptanceCriteria: ["Users can create issues"],
    infrastructureRequirements: ["PostgreSQL database"],
    risks: ["Auth edge cases"],
    resourceEstimate: {
      complexity: 0.5,
      estimatedDurationHours: { min: 10, max: 20 },
      inferenceRequirements: { estimatedTier: "standard" },
    },
  };
}

test("a well-formed planner output parses successfully", () => {
  const parsed = PlannerOutputSchema.parse(validPlannerOutput());
  assert.equal(parsed.goal, "Build a small SaaS issue tracker");
});

// This is the load-bearing security property: PlannerOutputSchema is a
// plain z.object(), not .strict(), so Zod's default behavior silently
// strips any key it doesn't recognize on .parse() — malformed/injected
// planner output (e.g. a hallucinated "price"/"cost" field) must never
// survive into what gets persisted. apps/api/src/pricing/engine.ts is the
// ONLY code path allowed to produce a price; this test proves the planner
// output shape itself can never smuggle one through.
test("an injected price-shaped field is stripped, never preserved", () => {
  const withInjectedPrice = {
    ...validPlannerOutput(),
    price: 999999,
    estimatedCostMinor: 42,
    resourceEstimate: {
      ...validPlannerOutput().resourceEstimate,
      priceMinor: 123,
    },
  };

  const parsed = PlannerOutputSchema.parse(withInjectedPrice);
  assert.equal((parsed as Record<string, unknown>).price, undefined);
  assert.equal((parsed as Record<string, unknown>).estimatedCostMinor, undefined);
  assert.equal((parsed.resourceEstimate as Record<string, unknown>).priceMinor, undefined);
});

test("missing a required field is rejected outright, never persisted as a partial row", () => {
  const missingGoal = validPlannerOutput() as Record<string, unknown>;
  delete missingGoal.goal;
  assert.throws(() => PlannerOutputSchema.parse(missingGoal));
});

test("a wrong-typed required field is rejected", () => {
  const wrongType = { ...validPlannerOutput(), scope: "not an object" };
  assert.throws(() => PlannerOutputSchema.parse(wrongType));
});

test("optional resourceEstimate sub-fields may be omitted", () => {
  const minimal = validPlannerOutput();
  const parsed = PlannerOutputSchema.parse(minimal);
  assert.equal(parsed.resourceEstimate.inferenceRequirements.estimatedTokens, undefined);
  assert.equal(parsed.resourceEstimate.storageRequirements, undefined);
});
