import { PlannerOutputSchema, type PlannerOutput } from "@athernull/contracts";

// Phase 4A — the LLM call boundary for turning a free-text build prompt into
// a structured PlannerOutput. This is the ONLY place in apps/api that talks
// to an LLM provider today (audited before writing this file: no existing
// apps/api code calls an LLM anywhere — the "anthropic/..." strings in
// auth.ts/agent_profiles seed data are model *identifiers* used for
// OpenHands dispatch routing, not an API call site).
//
// Deliberately minimal and isolated: a single fetch() against Anthropic's
// Messages API, no new SDK dependency, and no shared machinery with
// workers/coding-agent's SESSION_API_KEY-adjacent plumbing — that key
// belongs to a completely different trust boundary (sandboxed OpenHands
// execution), not a single structured-output request apps/api makes of its
// own accord.
export class PlannerError extends Error {}

export interface PlannerResult {
  plannerOutput: PlannerOutput;
  plannerModel: string;
}

// The model apps/api itself calls to produce a plan. Distinct from
// ModelTierSchema's routing tiers (packages/contracts/src/agentProfiles.ts)
// — those pick a model for *executing* a funded task; this one is fixed,
// since planning/estimation happens before any task or budget exists.
const PLANNER_MODEL = "claude-sonnet-5";

const PLANNER_SYSTEM_PROMPT = `You are a technical scoping assistant. Given a
plain-language build request, produce a structured project plan as a single
JSON object with exactly these top-level fields:

{
  "goal": string,
  "scope": { "included": string[], "excluded": string[] },
  "deliverables": string[],
  "implementationPlan": string[],
  "assumptions": string[],
  "acceptanceCriteria": string[],
  "infrastructureRequirements": string[],
  "risks": string[],
  "resourceEstimate": {
    "complexity": number between 0 and 1,
    "estimatedDurationHours": { "min": number, "max": number },
    "inferenceRequirements": {
      "estimatedTier": string,
      "estimatedTokens": { "min": number, "max": number } (optional)
    },
    "storageRequirements": string (optional),
    "computeRequirements": string (optional),
    "deploymentType": string (optional)
  }
}

Do not include any pricing, cost, or dollar-amount field anywhere in the
output — pricing is computed separately, outside your response, and any such
field you include will be discarded. Respond with ONLY the JSON object, no
surrounding prose or markdown fences.`;

// Injectable so callers (and tests) can supply a deterministic client
// instead of making a real network call — see setPlannerClientForTests
// below. The real implementation returns parsed-but-still-untrusted JSON;
// generatePlannerOutput() is what actually validates it.
export type PlannerClient = (sourcePrompt: string) => Promise<unknown>;

export const callAnthropicPlanner: PlannerClient = async (sourcePrompt) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new PlannerError(
      "ANTHROPIC_API_KEY is not configured — planner generation is unavailable",
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: PLANNER_MODEL,
      max_tokens: 4096,
      system: PLANNER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: sourcePrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PlannerError(`Planner LLM call failed with ${res.status}: ${body}`);
  }

  const payload = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new PlannerError("Planner LLM response contained no text content");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PlannerError("Planner LLM response was not valid JSON");
  }
};

// Test-only override — mirrors no existing DI pattern in this codebase 1:1
// (none exists yet; jobs.ts/routing.ts call their collaborators directly),
// but a real network call to an LLM provider is not something the test
// suite can or should depend on, so this is the narrowest seam: production
// code paths (routes/estimates.ts) never call this, only test setup does.
let activeClient: PlannerClient = callAnthropicPlanner;
export function setPlannerClientForTests(client: PlannerClient | null): void {
  activeClient = client ?? callAnthropicPlanner;
}

// The actual boundary routes/estimates.ts calls. Malformed/injected output
// (missing required fields, wrong types, or an extra field like a
// hallucinated "price") is rejected here via PlannerOutputSchema.parse() —
// deliberately not .safeParse(): a validation failure must throw and abort
// the request before anything reaches the database, never persist a partial
// or best-effort row.
export async function generatePlannerOutput(sourcePrompt: string): Promise<PlannerResult> {
  const raw = await activeClient(sourcePrompt);
  const plannerOutput = PlannerOutputSchema.parse(raw);
  return { plannerOutput, plannerModel: PLANNER_MODEL };
}
