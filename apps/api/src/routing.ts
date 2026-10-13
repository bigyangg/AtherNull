import { ModelTierSchema } from "@athernull/contracts";
import { chooseTier } from "@athernull/model-router";

import { db } from "./db.js";

export interface RoutingResult {
  resolvedModel: string;
  routingTier: string;
  routingScore: number;
  routingReason: string;
}

/** The NVIDIA NIM model this platform uses when NIM is its only provider. */
export const DEFAULT_NIM_MODEL = "nvidia_nim/nvidia/nemotron-3-super-120b-a12b";

/**
 * The model every build on this deployment runs with, or null to route by
 * the organization's agent profile.
 *
 * - AGENT_MODEL, when set (any LiteLLM model string, e.g. an `openrouter/…`
 *   model): the deployment decides, whatever the profile says.
 * - Otherwise, a deployment with an NVIDIA NIM key and no Anthropic key uses
 *   its NIM model: a profile naming Anthropic models could never run there
 *   (the worker has no credential for them), and every build would fail with
 *   "No credential found for provider 'anthropic'".
 */
export function deploymentAgentModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.AGENT_MODEL?.trim();
  if (explicit) return explicit;
  if (env.NVIDIA_NIM_API_KEY && !env.ANTHROPIC_API_KEY) return env.SANDBOX_LLM_MODEL?.trim() || DEFAULT_NIM_MODEL;
  return null;
}

export async function resolveRouting(
  agentProfileId: string,
  organizationId: string,
  signals: { objective: string; acceptanceCriteriaCount: number; budgetMinor: number },
): Promise<RoutingResult> {
  const profile = await db
    .selectFrom("agent_profiles")
    .select(["model_tiers"])
    .where("id", "=", agentProfileId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();

  if (!profile) {
    throw new Error(`Unknown agent profile: ${agentProfileId}`);
  }

  const tiers = ModelTierSchema.array().min(1).parse(profile.model_tiers);
  const decision = chooseTier(signals, tiers);

  // The tier is still chosen (it is recorded with the execution for usage
  // and routing analysis); only the model behind it is the deployment's.
  const deploymentModel = deploymentAgentModel();
  return {
    resolvedModel: deploymentModel ?? decision.model,
    routingTier: decision.tier,
    routingScore: decision.score,
    routingReason: deploymentModel ? `${decision.reason}; model set by this deployment (${deploymentModel})` : decision.reason,
  };
}
