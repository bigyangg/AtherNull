import { PlannerOutputSchema, type PlannerOutput } from "@athernull/contracts";
import { z } from "zod";

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
//
// Phase 4A.1 addition: a real-model verification run (NVIDIA NIM, standing
// in for Anthropic since no ANTHROPIC_API_KEY was available in that
// environment) exposed real, expected LLM non-determinism against this
// exact code — truncated JSON, prose ahead of the JSON object despite an
// explicit "JSON only" instruction, and a transient provider 503. Every one
// of those failures correctly threw before anything reached the database —
// that fail-closed boundary is unchanged and remains authoritative. This
// file adds a single bounded retry on top of it (see generatePlannerOutput),
// never a relaxation of validation.
export class PlannerError extends Error {
  readonly kind: PlannerFailureKind;
  constructor(message: string, kind: PlannerFailureKind = "terminal_provider") {
    super(message);
    this.kind = kind;
  }
}

// Three, and only three, failure categories this module ever needs to act
// on differently:
//   - malformed_output: the provider responded, but what came back isn't a
//     schema-valid PlannerOutput (invalid JSON, truncated JSON, prose
//     instead of JSON, or valid JSON that fails PlannerOutputSchema). Worth
//     one retry with an explicit repair instruction — the SAME request
//     might well succeed on a second try, and a repair note measurably
//     helps steer it.
//   - transient_provider: the provider itself is temporarily unavailable
//     (429/500/502/503/504, or a network/timeout failure before any
//     response was even received). Worth one retry after a short bounded
//     delay — retrying the identical request, no repair note needed.
//   - terminal_provider: retrying can never help (bad credentials,
//     forbidden, unsupported model, a malformed request that's our own
//     code's fault). Surfaced immediately, no retry attempted.
export type PlannerFailureKind = "malformed_output" | "transient_provider" | "terminal_provider";

export interface PlannerResult {
  plannerOutput: PlannerOutput;
  plannerModel: string;
}

// The model apps/api itself calls to produce a plan. Distinct from
// ModelTierSchema's routing tiers (packages/contracts/src/agentProfiles.ts)
// — those pick a model for *executing* a funded task; this one is fixed,
// since planning/estimation happens before any task or budget exists.
const PLANNER_MODEL = "claude-sonnet-5";

// Phase 4A.1 token-budget audit: 4096 was already the production setting.
// The expected output shape (goal string, ~8 short-to-medium string arrays,
// one small resourceEstimate object) comfortably fits well under 4096
// tokens for a model of this class in ordinary cases — the truncation
// observed during real-model verification came from a *different*
// environment's test harness deliberately using a smaller 2048 budget
// against a more verbose model, not from evidence that 4096 is structurally
// insufficient for the actual production path. Left unchanged; revisit only
// if real Anthropic-path evidence (not NIM-at-a-different-budget evidence)
// shows otherwise.
const PLANNER_MAX_TOKENS = 4096;

// Phase 4A.1: audited whether Anthropic's Messages API exposes a native,
// reliable structured-output mechanism narrowly enough to use here (it
// does — tool use with a forced tool_choice and an input_schema would
// constrain the response shape at the provider level, likely eliminating
// the "prose before JSON" failure mode entirely). Deliberately NOT adopted
// in this pass: it changes this file's request/response shape for the one
// production provider this whole system depends on, and there is no
// ANTHROPIC_API_KEY available anywhere in this environment to verify it
// actually behaves as documented before shipping it unverified against the
// authoritative provider. Documented here as a concrete, low-risk follow-up
// rather than implemented blind.
const MAX_PLANNER_ATTEMPTS = 2;
const TRANSIENT_RETRY_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 30_000;

const TRANSIENT_HTTP_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function buildSystemPrompt(): string {
  return `You are a technical scoping assistant. Given a
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
}

// Bounded, provider-agnostic repair instruction. Deliberately does NOT echo
// the previous bad response back to the model (no "continue this JSON" —
// the spec is explicit that a repair retry must produce a complete fresh
// object, and including a large raw failure payload here is exactly what
// this must avoid) — just a short, specific reason plus an unambiguous
// instruction to replace, not continue, the previous attempt.
export interface PlannerRepairContext {
  reason: string;
}

function withRepairNote(sourcePrompt: string, repair: PlannerRepairContext | undefined): string {
  if (!repair) return sourcePrompt;
  return (
    `${sourcePrompt}\n\n[Your previous response was invalid: ${repair.reason}. ` +
    `Ignore that previous response completely and provide a complete, fresh, ` +
    `valid JSON object that exactly matches the required schema above — do not ` +
    `continue or repair the previous output. Respond with ONLY the JSON object, ` +
    `no prose, no markdown fences.]`
  );
}

// Injectable so callers (and tests) can supply a deterministic client
// instead of making a real network call — see setPlannerClientForTests
// below. The real implementation returns parsed-but-still-untrusted JSON;
// generatePlannerOutput() is what actually validates it. `repair` is set
// only on the (at most one) retry attempt following a malformed_output
// failure — omitted on a first attempt or a transient-provider retry.
export type PlannerClient = (sourcePrompt: string, repair?: PlannerRepairContext) => Promise<unknown>;

export const callAnthropicPlanner: PlannerClient = async (sourcePrompt, repair) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Missing credentials can never be fixed by retrying — terminal.
    throw new PlannerError(
      "ANTHROPIC_API_KEY is not configured — planner generation is unavailable",
      "terminal_provider",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: PLANNER_MODEL,
        max_tokens: PLANNER_MAX_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: withRepairNote(sourcePrompt, repair) }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // A network failure or our own timeout abort — the provider was never
    // actually reached with a definitive answer, so this is transient by
    // nature: the exact same request may well succeed a moment later.
    const reason = err instanceof Error && err.name === "AbortError" ? "request timed out" : String(err);
    throw new PlannerError(`Planner LLM call failed before receiving a response: ${reason}`, "transient_provider");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind: PlannerFailureKind = TRANSIENT_HTTP_STATUS_CODES.has(res.status)
      ? "transient_provider"
      : "terminal_provider";
    throw new PlannerError(`Planner LLM call failed with ${res.status}: ${body.slice(0, 500)}`, kind);
  }

  const payload = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    // The provider answered successfully but gave us nothing usable — this
    // is the model's own output being unusable, not a provider outage, so
    // it belongs in the same repair-retry bucket as invalid JSON.
    throw new PlannerError("Planner LLM response contained no text content", "malformed_output");
  }

  // Deliberately strict: no fence-stripping, no regex-extraction, no
  // best-effort recovery of a partial object. A response that isn't
  // literally a JSON object is malformed output, full stop — the retry
  // path (with an explicit repair instruction) is how this recovers, never
  // a lenient parse here.
  try {
    return JSON.parse(text);
  } catch {
    throw new PlannerError("Planner LLM response was not valid JSON", "malformed_output");
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

function classifyFailure(err: unknown): PlannerFailureKind {
  if (err instanceof PlannerError) return err.kind;
  // A schema-validation failure is model output that didn't match the
  // contract — the same "worth a repair retry" bucket as invalid JSON, even
  // though it came from generatePlannerOutput's own parse step rather than
  // the client.
  if (err instanceof z.ZodError) return "malformed_output";
  // Any other, wholly unexpected throw (a bug in our own code, say) is
  // treated as terminal — retrying blind against an unknown failure mode
  // risks masking a real defect behind an apparent flaky success.
  return "terminal_provider";
}

function repairReasonFor(err: unknown): string {
  if (err instanceof z.ZodError) {
    const paths = err.issues.slice(0, 3).map((issue) => issue.path.join(".") || "(root)");
    return `the JSON did not match the required schema (problem field(s): ${paths.join(", ")})`;
  }
  if (err instanceof PlannerError) {
    // Bounded — never the raw response body, just this module's own short,
    // already-bounded error message (see callAnthropicPlanner: none of its
    // malformed_output messages include more than a fixed, short string).
    return err.message;
  }
  return "the response was invalid";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Never log API keys/headers, and never log the full source prompt or full
// model response — only which of the six distinguishable outcomes this
// operation reached. Mirrors email.ts's existing console.* + bracketed-tag
// convention for a standalone (non-request-scoped) module; no new logging
// abstraction introduced.
function logPlanner(message: string): void {
  console.info(`[planner] ${message}`);
}

// The actual boundary routes/estimates.ts calls. Malformed/injected output
// (missing required fields, wrong types, or an extra field like a
// hallucinated "price") is rejected here via PlannerOutputSchema.parse() —
// deliberately not .safeParse(): a validation failure must throw and abort
// the request before anything reaches the database, never persist a partial
// or best-effort row.
//
// Phase 4A.1: at most MAX_PLANNER_ATTEMPTS (2) total model calls per
// operation — one initial attempt, and at most one retry, classified by
// exactly why the first attempt failed. A terminal_provider failure never
// gets a retry at all (one call total). Every attempt, including the retry,
// goes through the identical JSON.parse -> PlannerOutputSchema.parse
// pipeline; nothing about the retry loosens or bypasses that. If both
// attempts fail, generatePlannerOutput throws and — by construction, since
// routes/estimates.ts only ever reads plannerOutput/plannerModel out of a
// successful return value — zero project_estimates rows are ever created.
export async function generatePlannerOutput(sourcePrompt: string): Promise<PlannerResult> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
    const isRetry = attempt > 1;
    let repair: PlannerRepairContext | undefined;

    if (isRetry) {
      const kind = classifyFailure(lastErr);
      if (kind === "transient_provider") {
        logPlanner(`transient provider failure on attempt ${attempt - 1}, retrying after backoff`);
        await delay(TRANSIENT_RETRY_DELAY_MS);
      } else {
        // malformed_output — classified terminal_provider failures never
        // reach here at all (see the throw immediately below).
        logPlanner(`malformed model output on attempt ${attempt - 1}, retrying with repair instruction`);
        repair = { reason: repairReasonFor(lastErr) };
      }
    }

    try {
      const raw = await activeClient(sourcePrompt, repair);
      const plannerOutput = PlannerOutputSchema.parse(raw);
      logPlanner(isRetry ? `success on retry (attempt ${attempt})` : "success on first attempt");
      return { plannerOutput, plannerModel: PLANNER_MODEL };
    } catch (err) {
      lastErr = err;
      const kind = classifyFailure(err);
      if (kind === "terminal_provider") {
        logPlanner(`terminal provider failure on attempt ${attempt}, not retrying: ${(err as Error).message}`);
        throw err;
      }
      // malformed_output or transient_provider: loop continues if another
      // attempt is still available; otherwise falls out of the loop below.
    }
  }

  const finalKind = classifyFailure(lastErr);
  logPlanner(`final ${finalKind} failure after ${MAX_PLANNER_ATTEMPTS} attempts, giving up`);
  throw lastErr;
}
