import { z } from "zod";

// Minimum event set (spec §7)
export const EventTypeSchema = z.enum([
  "JOB_CREATED",
  "FUNDING_CONFIRMED",
  "JOB_QUEUED",
  "EXECUTION_STARTED",
  "USAGE_RECORDED",
  "CHECKPOINT_SAVED",
  "EXECUTION_FINISHED",
  "VERIFICATION_COMPLETED",
  "ACCEPTANCE_RECORDED",
  "SETTLEMENT_SUBMITTED",
  "SETTLEMENT_CONFIRMED",
  "REFUND_CONFIRMED",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

// Every event carries these fields (spec §7); payload shape is event-specific
// and defined alongside the producer, not here.
export const EventEnvelopeSchema = z.object({
  eventId: z.string(),
  type: EventTypeSchema,
  tenant: z.string(),
  jobId: z.string(),
  executionId: z.string().optional(),
  attemptId: z.string().optional(),
  timestamp: z.string(), // ISO-8601 UTC
  schemaVersion: z.number().int(),
  correlationId: z.string(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
