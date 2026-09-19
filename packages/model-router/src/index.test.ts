import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelTier } from "@athernull/contracts";
import { chooseTier, scoreComplexity } from "./index.js";

const TIERS: ModelTier[] = [
  { tier: "fast", model: "anthropic/claude-haiku-4-5-20251001", maxComplexity: 0.33 },
  { tier: "standard", model: "anthropic/claude-sonnet-5", maxComplexity: 0.66, costCeilingMinor: 100 },
  { tier: "deep", model: "anthropic/claude-opus-5", maxComplexity: 1, costCeilingMinor: 1000 },
];

test("a short, simple objective scores low", () => {
  const score = scoreComplexity({ objective: "Fix a typo in the README.", acceptanceCriteriaCount: 1 });
  assert.ok(score < 0.4, `expected low score, got ${score}`);
});

test("a long objective with migration keywords and many acceptance criteria scores high", () => {
  const score = scoreComplexity({
    objective:
      "Migrate the legacy authentication module to the new architecture, rewrite the session " +
      "handling, and overhaul the permission model across every service boundary in the monorepo.",
    acceptanceCriteriaCount: 8,
  });
  assert.ok(score > 0.6, `expected high score, got ${score}`);
});

test("chooseTier picks the cheapest adequate tier within budget", () => {
  const decision = chooseTier(
    { objective: "Fix a typo in the README.", acceptanceCriteriaCount: 1, budgetMinor: 5000 },
    TIERS,
  );
  assert.equal(decision.tier, "fast");
});

test("chooseTier escalates tier for a complex task with enough budget", () => {
  const decision = chooseTier(
    {
      objective: "Migrate and rewrite the architecture of the billing service end to end.",
      acceptanceCriteriaCount: 8,
      budgetMinor: 5000,
    },
    TIERS,
  );
  assert.equal(decision.tier, "deep");
});

test("chooseTier caps at the best affordable tier when budget is too low for the ideal tier", () => {
  const decision = chooseTier(
    {
      objective: "Migrate and rewrite the architecture of the billing service end to end.",
      acceptanceCriteriaCount: 8,
      budgetMinor: 100,
    },
    TIERS,
  );
  assert.equal(decision.tier, "standard");
  assert.match(decision.reason, /capped/);
});

test("chooseTier falls back to the cheapest tier when nothing is affordable", () => {
  const decision = chooseTier(
    { objective: "Do something.", acceptanceCriteriaCount: 1, budgetMinor: 0 },
    TIERS,
  );
  assert.equal(decision.tier, "fast");
});

test("chooseTier throws on an empty tier list", () => {
  assert.throws(() => chooseTier({ objective: "x", acceptanceCriteriaCount: 0, budgetMinor: 100 }, []));
});
