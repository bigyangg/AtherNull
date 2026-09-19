import type { ModelTier } from "@athernull/contracts";

export interface ComplexitySignals {
  objective: string;
  acceptanceCriteriaCount: number;
}

export interface RoutingDecision {
  tier: string;
  model: string;
  score: number;
  reason: string;
}

// v1 rule-based heuristic (ADR-0003) — not ML. Keep the keyword lists and
// weights easy to find and tune; don't dress this up as more principled than
// it is.
const COMPLEX_KEYWORDS = [
  "migrate",
  "migration",
  "refactor",
  "rewrite",
  "architecture",
  "redesign",
  "overhaul",
  "rearchitect",
];
const SIMPLE_KEYWORDS = ["typo", "rename", "wording", "comment", "changelog", "bump version"];

const WEIGHTS = { length: 0.3, keywords: 0.4, acceptanceCriteria: 0.3 } as const;
const LENGTH_NORMALIZATION_CHARS = 400;
const ACCEPTANCE_CRITERIA_NORMALIZATION_COUNT = 6;

function clip01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function scoreComplexity(signals: ComplexitySignals): number {
  const text = signals.objective.toLowerCase();

  const lengthScore = clip01(signals.objective.length / LENGTH_NORMALIZATION_CHARS);

  const complexHits = COMPLEX_KEYWORDS.filter((kw) => text.includes(kw)).length;
  const simpleHits = SIMPLE_KEYWORDS.filter((kw) => text.includes(kw)).length;
  const keywordScore = clip01(0.5 + 0.25 * complexHits - 0.25 * simpleHits);

  const acceptanceScore = clip01(
    signals.acceptanceCriteriaCount / ACCEPTANCE_CRITERIA_NORMALIZATION_COUNT,
  );

  return clip01(
    WEIGHTS.length * lengthScore +
      WEIGHTS.keywords * keywordScore +
      WEIGHTS.acceptanceCriteria * acceptanceScore,
  );
}

/**
 * Picks the cheapest tier whose maxComplexity covers the task's score,
 * restricted to tiers the task's budget can afford. Always returns a
 * decision (never throws on a bad fit) — budget enforcement is a separate,
 * earlier control (spec §8); this function's job is to explain its choice,
 * not to gate admission.
 */
export function chooseTier(
  signals: ComplexitySignals & { budgetMinor: number },
  tiers: ModelTier[],
): RoutingDecision {
  if (tiers.length === 0) {
    throw new Error("chooseTier requires at least one model tier");
  }

  const score = scoreComplexity(signals);
  const sorted = [...tiers].sort((a, b) => a.maxComplexity - b.maxComplexity);
  const affordable = sorted.filter(
    (t) => t.costCeilingMinor == null || t.costCeilingMinor <= signals.budgetMinor,
  );

  if (affordable.length === 0) {
    const cheapest = sorted[0]!;
    return {
      tier: cheapest.tier,
      model: cheapest.model,
      score,
      reason:
        `No tier fits budgetMinor=${signals.budgetMinor}; dispatching cheapest tier ` +
        `'${cheapest.tier}' anyway — expect the spend cap to stop the job early.`,
    };
  }

  const adequate = affordable.find((t) => t.maxComplexity >= score);
  if (adequate) {
    return {
      tier: adequate.tier,
      model: adequate.model,
      score,
      reason:
        `complexity score ${score.toFixed(2)} fits tier '${adequate.tier}' ` +
        `(maxComplexity ${adequate.maxComplexity}) within budgetMinor=${signals.budgetMinor}.`,
    };
  }

  const bestAffordable = affordable[affordable.length - 1]!;
  return {
    tier: bestAffordable.tier,
    model: bestAffordable.model,
    score,
    reason:
      `complexity score ${score.toFixed(2)} exceeds every affordable tier's maxComplexity; ` +
      `capped at '${bestAffordable.tier}' by budgetMinor=${signals.budgetMinor}.`,
  };
}
