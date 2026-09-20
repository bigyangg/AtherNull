import { ModelTierSchema } from "@athernull/contracts";
import { chooseTier } from "@athernull/model-router";

import { db } from "./db.js";

export interface RoutingResult {
  resolvedModel: string;
  routingTier: string;
  routingScore: number;
  routingReason: string;
}

// Glue between packages/model-router (pure logic, no I/O) and the DB —
// loads the agent profile's *current* model ladder and calls chooseTier()
// (ADR-0003: routing is computed "at dispatch time", i.e. live, not
// snapshotted). Remaps {tier, model, score, reason} onto
// InternalWorkDispatchSchema's field names — the two shapes are allowed to
// differ, this is the seam.
//
// agentProfileVersion/policyVersion are NOT sourced here — those are
// snapshotted on the task itself at job-creation time
// (0004_task_reproducibility_snapshot.sql) precisely because the live
// agent_profiles row can drift after a task references it. Callers read
// those two off the task row, not off this function.
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

  return {
    resolvedModel: decision.model,
    routingTier: decision.tier,
    routingScore: decision.score,
    routingReason: decision.reason,
  };
}
