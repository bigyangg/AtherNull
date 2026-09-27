import { db } from "./db.js";

// Phase 4D.1 — real usage metering. Shared by the authoritative HTTP
// ingestion route (routes/internal.ts's POST /internal/executions/:id/usage)
// exactly like execution-events.ts's persistExecutionEvents is shared by its
// own ingestion route.
//
// Wire shape sent by the worker (workers/coding-agent/src/coding_agent/
// agent_server_adapter.py's UsageForwarder) is deliberately minimal raw
// evidence only: execution identity (via the URL path), provider_request_id
// (the provider's real response id — resp.id, see telemetry.py), provider,
// model, and the exact raw token categories the OpenHands SDK's Telemetry
// extracted. The worker NEVER sends task_id/project_id/organization_id (it
// isn't a trusted source for tenant attribution) and NEVER sends any cost
// value, not even null — money has no place on this wire at all in this
// phase.
export interface UsageEventRecord {
  providerRequestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  observedAt: string;
}

// Derives task_id/project_id/organization_id itself from the trusted,
// already-persisted execution_id -> task_id -> project_id/organization_id
// chain (the caller in routes/internal.ts has already verified this
// execution_id's lease is owned by the calling worker before this runs) —
// never trusts worker-supplied values for these, because none are ever sent.
//
// total_tokens is derived here, once, as input_tokens + output_tokens — see
// 0011_usage_metering.sql's own comment for why this is the single correct
// formula for an OpenAI-compatible provider like NVIDIA NIM (cache_read/
// cache_write/reasoning are sub-categories already counted inside
// input/output, never additive). Computed server-side rather than trusted
// from the worker so there is exactly one implementation of this formula,
// not two that could silently disagree.
//
// Dedupe is DB-enforced, not application logic: onConflict(execution_id,
// provider_request_id) doNothing relies entirely on
// usage_events_execution_id_provider_request_id_key (0002_platform_tables.sql,
// unchanged by 0011) — inserting the same (execution_id, provider_request_id)
// pair twice (a repeated conversation.stats poll resending its full
// cumulative history, a worker restart replaying from zero, a retried POST)
// is always a no-op at the database level, regardless of what any
// in-memory worker state does or does not remember.
//
// pricing_status/cost_minor/currency/rate_version are never set here — they
// take the table's own defaults (UNPRICED / NULL / NULL / NULL). This
// function has no pricing logic and must never gain any in this phase.
export async function persistUsageEvents(
  executionId: string,
  events: UsageEventRecord[],
): Promise<void> {
  if (events.length === 0) return;

  const execution = await db
    .selectFrom("executions")
    .innerJoin("tasks", "tasks.id", "executions.task_id")
    .select([
      "executions.id as execution_id",
      "tasks.id as task_id",
      "tasks.project_id as project_id",
      "tasks.organization_id as organization_id",
    ])
    .where("executions.id", "=", executionId)
    .executeTakeFirst();

  if (!execution) {
    throw new Error(`persistUsageEvents: execution ${executionId} not found`);
  }

  await db
    .insertInto("usage_events")
    .values(
      events.map((event) => ({
        execution_id: execution.execution_id,
        task_id: execution.task_id,
        project_id: execution.project_id,
        organization_id: execution.organization_id,
        provider_request_id: event.providerRequestId,
        provider: event.provider,
        model: event.model,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        cache_read_tokens: event.cacheReadTokens,
        cache_write_tokens: event.cacheWriteTokens,
        reasoning_tokens: event.reasoningTokens,
        total_tokens: event.inputTokens + event.outputTokens,
        observed_at: event.observedAt,
      })),
    )
    .onConflict((oc) => oc.columns(["execution_id", "provider_request_id"]).doNothing())
    .execute();
}
