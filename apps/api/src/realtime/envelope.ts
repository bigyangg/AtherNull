import { z } from "zod";

// ADR-0007 Phase 3B — the worker <-> apps/api relay tunnel's own internal
// wire envelope. This is NOT a browser-facing protocol and has no relation
// to any OpenHands wire format (see docs/adr/0007-secure-realtime-execution.md).
//
// Cross-language note: the Python worker
// (workers/coding-agent/src/coding_agent/relay_client.py) implements this
// exact same JSON shape independently, in Python. It is duplicated by
// necessity (TypeScript and Python cannot literally share a module) — this
// file is apps/api's own typed reference for the shape, not shared code.
// If this envelope ever changes, both sides must be updated by hand.

export const RELAY_PROTOCOL_VERSION = 1 as const;

export const RelayMessageTypeSchema = z.enum([
  // Sent once, right after the worker's relay connection is accepted.
  "worker.ready",
  // The worker forwarding one OpenHands event over the relay, in addition
  // to (never instead of) the authoritative HTTP
  // /internal/executions/:id/events path.
  "execution.event",
  // The worker signaling it is about to close this relay connection because
  // its dispatch finished. This is a relay-lifecycle signal only — it does
  // NOT transition any task/execution state. That remains exclusively
  // POST /internal/executions/:id/complete.
  "execution.completed",
  // Optional application-level liveness signal. The WebSocket protocol's
  // own ping/pong (handled by `ws` and by Python's `websockets` transport
  // automatically) is the real liveness/dead-connection mechanism; this is
  // purely for observability at the gateway.
  "relay.heartbeat",
]);
export type RelayMessageType = z.infer<typeof RelayMessageTypeSchema>;

export const RelayEnvelopeSchema = z.object({
  version: z.literal(RELAY_PROTOCOL_VERSION),
  type: RelayMessageTypeSchema,
  executionId: z.string().min(1),
  // The OpenHands event's own id — the same identity `execution_events.id`
  // already uses (ADR-0007: "do not invent a second event-identity
  // scheme"). Required for execution.event; null/omitted for lifecycle
  // messages that don't correspond to a single event.
  eventId: z.string().min(1).nullable().optional(),
  payload: z.unknown().optional(),
});
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

// execution.event's payload is the same {id, kind, occurredAt, payload}
// record shape POST /internal/executions/:id/events already accepts per
// event (see routes/internal.ts) — reused verbatim, not reinvented.
export const RelayExecutionEventPayloadSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  occurredAt: z.string().min(1),
  payload: z.unknown(),
});
export type RelayExecutionEventPayload = z.infer<typeof RelayExecutionEventPayloadSchema>;
