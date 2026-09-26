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
  // ADR-0007 Phase 3D — gateway -> worker: forward one authorized browser
  // command for the worker to re-issue against its local, authenticated
  // Agent Server connection using the worker's own real per-execution
  // session credential (never present in this envelope, on either leg —
  // see routes/relay.ts's static assertion test, which checks this exact
  // file's raw source for that credential's env-var name). This is the ONLY direction
  // this relay tunnel now needs a gateway->worker message for; nothing else
  // about Phase 3B's worker->gateway event flow changes.
  "gateway.command",
  // ADR-0007 Phase 3D — worker -> gateway: the terminal outcome of
  // forwarding one command to the Agent Server. "accepted" = the worker's
  // REST call to the Agent Server succeeded (the command was durably
  // recorded in the OpenHands conversation's event log). "rejected" = the
  // WORKER itself declined to forward (e.g. an envelope it doesn't
  // recognize/support at its own protocol version) — distinct from the
  // gateway's own "rejected" (which never reaches the worker at all).
  // "failed" = the Agent Server explicitly returned an error for the
  // attempted action. There is no "executed" ack from the worker — the
  // gateway derives that signal from the ordinary execution.event stream
  // (see routes/realtime-gateway.ts), not from a second, competing
  // worker-reported outcome.
  "worker.command_ack",
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

// ADR-0007 Phase 3D — gateway.command's payload. `commandId` is the
// browser's own command identity (see packages/contracts/realtime-browser.ts)
// carried through unchanged end to end — this relay tunnel does not
// generate a second id for the same command. `command` mirrors the
// browser-facing ExecutionCommandPayloadSchema shape (kept as z.unknown()
// here and re-validated narrowly by the worker, so this internal envelope
// schema doesn't need to import the browser-facing package — this file is
// intentionally standalone, matching this module's existing
// no-shared-code-across-languages convention).
export const RelayCommandPayloadSchema = z.object({
  commandId: z.string().min(1),
  command: z.object({
    type: z.string().min(1),
    payload: z.unknown(),
  }),
});
export type RelayCommandPayload = z.infer<typeof RelayCommandPayloadSchema>;

// ADR-0007 Phase 3D — worker.command_ack's payload.
export const RelayCommandAckPayloadSchema = z.object({
  commandId: z.string().min(1),
  status: z.enum(["accepted", "rejected", "failed"]),
  detail: z.string().optional(),
});
export type RelayCommandAckPayload = z.infer<typeof RelayCommandAckPayloadSchema>;
