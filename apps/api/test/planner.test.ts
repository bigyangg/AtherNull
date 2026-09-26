// Unit coverage for Phase 4A.1's planner retry policy
// (apps/api/src/planner.ts). No Postgres, no Fastify app — generatePlannerOutput()
// is a pure function of an injectable PlannerClient, so these tests exercise
// the retry/classification logic directly and fast. Persistence-level
// guarantees (zero rows on failure, exactly one row on a successful retry)
// are covered separately in estimates-lifecycle.test.ts, which already has
// the real app+DB harness these tests deliberately don't need.
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import type { PlannerOutput } from "@athernull/contracts";
import { z } from "zod";

const { generatePlannerOutput, setPlannerClientForTests, PlannerError } = await import("../src/planner.js");

after(() => setPlannerClientForTests(null));
afterEach(() => setPlannerClientForTests(null));

function validOutput(goal: string): PlannerOutput {
  return {
    goal,
    scope: { included: ["core feature set"], excluded: ["mobile app"] },
    deliverables: ["A deployed web application"],
    implementationPlan: ["Set up auth", "Build core CRUD"],
    assumptions: ["PostgreSQL is available"],
    acceptanceCriteria: ["Users can sign up and log in"],
    infrastructureRequirements: ["PostgreSQL database"],
    risks: ["Auth edge cases under load"],
    resourceEstimate: {
      complexity: 0.5,
      estimatedDurationHours: { min: 10, max: 30 },
      inferenceRequirements: { estimatedTier: "standard" },
    },
  };
}

test("1. valid first response: one provider call, valid output returned", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    return validOutput("first try");
  });

  const { plannerOutput } = await generatePlannerOutput("build me a thing");
  assert.equal(calls, 1);
  assert.equal(plannerOutput.goal, "first try");
});

test("2. malformed JSON then valid JSON: exactly two calls, second result accepted", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    if (calls === 1) throw new PlannerError("Planner LLM response was not valid JSON", "malformed_output");
    return validOutput("recovered");
  });

  const { plannerOutput } = await generatePlannerOutput("prompt");
  assert.equal(calls, 2);
  assert.equal(plannerOutput.goal, "recovered");
});

test("3. schema-invalid JSON then valid output: exactly two calls", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    if (calls === 1) return { goal: "missing everything else" }; // fails PlannerOutputSchema
    return validOutput("schema-fixed");
  });

  const { plannerOutput } = await generatePlannerOutput("prompt");
  assert.equal(calls, 2);
  assert.equal(plannerOutput.goal, "schema-fixed");
});

test("4. prose/non-JSON then valid response: retry occurs, and the retry carries a repair instruction", async () => {
  let calls = 0;
  let secondPrompt = "";
  setPlannerClientForTests(async (prompt, repair) => {
    calls++;
    if (calls === 1) throw new PlannerError("Planner LLM response was not valid JSON", "malformed_output");
    secondPrompt = prompt;
    assert.ok(repair, "the retry must carry a repair context after malformed output");
    return validOutput("recovered-from-prose");
  });

  await generatePlannerOutput("original prompt");
  assert.equal(calls, 2);
  assert.equal(secondPrompt, "original prompt", "the retry must reuse the original source prompt");
});

test("5. malformed first + malformed second: PlannerError, exactly two calls", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    throw new PlannerError("Planner LLM response was not valid JSON", "malformed_output");
  });

  await assert.rejects(generatePlannerOutput("prompt"), PlannerError);
  assert.equal(calls, 2, "must not exceed the bounded 2-attempt budget");
});

test("6. transient 503 then success: exactly one retry, success", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    if (calls === 1) throw new PlannerError("Planner LLM call failed with 503: overloaded", "transient_provider");
    return validOutput("recovered-from-503");
  });

  const started = Date.now();
  const { plannerOutput } = await generatePlannerOutput("prompt");
  const elapsed = Date.now() - started;
  assert.equal(calls, 2);
  assert.equal(plannerOutput.goal, "recovered-from-503");
  assert.ok(elapsed >= 250, "a transient retry must wait a bounded backoff, not fire immediately back-to-back");
});

test("7. transient failure twice: PlannerError, no third call", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    throw new PlannerError("Planner LLM call failed with 503: overloaded", "transient_provider");
  });

  await assert.rejects(generatePlannerOutput("prompt"), PlannerError);
  assert.equal(calls, 2, "must not exceed the bounded 2-attempt budget");
});

test("8. 401/403-style terminal failure: no retry", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    throw new PlannerError("Planner LLM call failed with 401: invalid credentials", "terminal_provider");
  });

  await assert.rejects(generatePlannerOutput("prompt"), PlannerError);
  assert.equal(calls, 1, "a terminal failure must never be retried");
});

test("callAnthropicPlanner classifies a network/fetch failure as transient, not terminal", async () => {
  const { callAnthropicPlanner } = await import("../src/planner.js");
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed: ECONNRESET");
  }) as typeof fetch;
  try {
    await assert.rejects(callAnthropicPlanner("prompt"), (err: unknown) => {
      assert.ok(err instanceof PlannerError);
      assert.equal(err.kind, "transient_provider", "a network failure must be classified transient, not terminal");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("callAnthropicPlanner classifies an abort (timeout) error as transient, not terminal", async () => {
  // Exercises the same classification branch a real REQUEST_TIMEOUT_MS
  // firing would hit, without waiting out the real 30s budget: the fetch
  // stub rejects immediately with the same AbortError shape the real
  // AbortController-triggered fetch abort produces.
  const { callAnthropicPlanner } = await import("../src/planner.js");
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;
  try {
    await assert.rejects(callAnthropicPlanner("prompt"), (err: unknown) => {
      assert.ok(err instanceof PlannerError);
      assert.equal(err.kind, "transient_provider", "a timeout must be classified transient, not terminal");
      assert.match(err.message, /timed out/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("an unexpected, unclassified throw is treated as terminal (never retried blind)", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    throw new RangeError("something in our own code is broken");
  });

  await assert.rejects(generatePlannerOutput("prompt"));
  assert.equal(calls, 1);
});

test("12. price-shaped model fields remain unable to become financial truth, even after a repair retry", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    if (calls === 1) return { goal: "bad shape" }; // triggers a schema-failure retry
    return { ...validOutput("priced attempt"), price: 999, estimatedCostMinor: 12_345 } as unknown;
  });

  const { plannerOutput } = await generatePlannerOutput("prompt");
  assert.equal(calls, 2);
  assert.ok(!("price" in plannerOutput), "an injected price field must be stripped, retry or not");
  assert.ok(!("estimatedCostMinor" in plannerOutput), "an injected estimatedCostMinor field must be stripped, retry or not");
});

test("a repair retry never persists or reuses the first, invalid raw output — the retry's own output is what's returned", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    if (calls === 1) return "not even an object, just a bare string" as unknown;
    return validOutput("only-the-second-attempt-counts");
  });

  const { plannerOutput } = await generatePlannerOutput("prompt");
  assert.equal(plannerOutput.goal, "only-the-second-attempt-counts");
});

test("a genuine z.ZodError thrown by schema validation is classified the same as malformed client output", async () => {
  let calls = 0;
  setPlannerClientForTests(async () => {
    calls++;
    if (calls === 1) return { goal: 123 }; // wrong type -> real ZodError from PlannerOutputSchema.parse
    return validOutput("recovered-from-zod-error");
  });

  const { plannerOutput } = await generatePlannerOutput("prompt");
  assert.equal(calls, 2);
  assert.equal(plannerOutput.goal, "recovered-from-zod-error");
});

test("the production callAnthropicPlanner classifies a missing ANTHROPIC_API_KEY as terminal (no network call, no retry)", async () => {
  const { callAnthropicPlanner } = await import("../src/planner.js");
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(callAnthropicPlanner("prompt"), (err: unknown) => {
      assert.ok(err instanceof PlannerError);
      assert.equal(err.kind, "terminal_provider");
      return true;
    });
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});
