import { z } from "zod";

// One rung of an agent profile's model ladder (ADR-0003). Ordered
// cheapest/simplest -> most capable in agent_profiles.model_tiers.
export const ModelTierSchema = z.object({
  tier: z.string(),
  model: z.string(), // LiteLLM-style, e.g. "anthropic/claude-sonnet-5"
  maxComplexity: z.number().min(0).max(1),
  costCeilingMinor: z.number().int().nonnegative().optional(),
});
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const AgentProfileSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  modelTiers: z.array(ModelTierSchema).min(1),
  policyVersion: z.string(),
  toolAllowlist: z.array(z.string()),
  configRevision: z.number().int(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
