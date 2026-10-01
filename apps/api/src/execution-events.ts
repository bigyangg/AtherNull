import { db } from "./db.js";
import type { Transaction } from "kysely";
import type { Database } from "@athernull/database";

export interface ExecutionEventRecord {
  id: string;
  kind: string;
  occurredAt: string;
  payload: unknown;
}

// Shared by the authoritative HTTP ingestion route
// (routes/internal.ts's POST /internal/executions/:id/events) and the
// opportunistic relay path (routes/relay.ts, ADR-0007 Phase 3B) — both
// write through this one insert so there is exactly one dedupe mechanism
// (ON CONFLICT on the event's own OpenHands uuid), never two competing
// ones. This is genuinely shared DB logic, not the lease-check pattern
// internal.ts's routes deliberately keep duplicated per-route.
export async function persistExecutionEvents(
  executionId: string,
  events: ExecutionEventRecord[],
  connection: typeof db | Transaction<Database> = db,
): Promise<void> {
  if (events.length === 0) return;
  await connection
    .insertInto("execution_events")
    .values(
      events.map((event) => ({
        id: event.id,
        execution_id: executionId,
        kind: event.kind,
        payload: JSON.stringify(event.payload),
        occurred_at: event.occurredAt,
      })),
    )
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}
