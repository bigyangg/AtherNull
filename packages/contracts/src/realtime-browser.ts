import { z } from "zod";

// ADR-0007 Phase 3C — the browser-facing realtime protocol spoken between
// apps/api's realtime gateway (apps/api/src/routes/realtime-gateway.ts) and
// an authenticated AtherNull browser tab. This is a NEW, minimal, versioned
// protocol — distinct from BOTH:
//   - the internal worker<->gateway relay envelope
//     (apps/api/src/realtime/envelope.ts, ADR-0007 Phase 3B) — that one is
//     never forwarded to a browser verbatim, and this file must not import
//     it or structurally mirror its shape 1:1 (deliberately different field
//     names below: `event` not `payload`, `outcome` not a lifecycle `type`
//     alone) so the two are never confused at a call site.
//   - OpenHands' own native wire format (the pinned frontend's
//     `{type: "auth", session_api_key}` / `AgentServerEvent` shapes) — this
//     phase does not integrate with that frontend at all (see
//     docs/adr/0007-secure-realtime-execution.md's Phase 3C status section
//     for the audit that confirmed apps/web, not the vendored OpenHands
//     frontend, is the real integration target).
//
// Genuinely shared code: both apps/api (producer) and apps/web (consumer)
// are TypeScript and can import this one Zod schema/type directly — unlike
// the Python/TypeScript worker-relay envelope, which must be hand-duplicated
// across languages.
//
// Read-only (realtime:view) in this phase — there is no client-to-server
// message type defined here at all. Every inbound browser message the
// gateway receives is rejected (RealtimeErrorSchema, code
// "control_not_supported"), not silently ignored, per ADR-0007's explicit
// Phase 3C scope boundary (no realtime:control, no chat/bash forwarding).

export const REALTIME_BROWSER_PROTOCOL_VERSION = 1 as const;

// Mirrors the one persisted shape (`execution_events` row / the relay's own
// RelayExecutionEventPayloadSchema) — the event's own OpenHands UUID
// (`id`) is reused verbatim as the sole dedup identity throughout this
// protocol; no second event-identity scheme is introduced here.
export const RealtimeExecutionEventSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  occurredAt: z.string().min(1),
  payload: z.unknown(),
});
export type RealtimeExecutionEvent = z.infer<typeof RealtimeExecutionEventSchema>;

export const RealtimeServerHelloSchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("server.hello"),
  executionId: z.string().min(1),
  taskId: z.string().min(1),
  executionStatus: z.string().min(1),
});
export type RealtimeServerHello = z.infer<typeof RealtimeServerHelloSchema>;

// Sent exactly once per connection, immediately after server.hello: the full
// persisted-history replay from Postgres (execution_events), before any live
// execution.event message. See this package's header comment and
// apps/api/src/routes/realtime-gateway.ts's own comment for the
// buffer-then-release mechanism that makes this handoff lossless.
export const RealtimeHistoryReadySchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("history.ready"),
  executionId: z.string().min(1),
  events: z.array(RealtimeExecutionEventSchema),
});
export type RealtimeHistoryReady = z.infer<typeof RealtimeHistoryReadySchema>;

// One live (or buffered-then-released) event. The client must dedupe by
// `event.id` against whatever `history.ready` already delivered — the
// gateway also dedupes server-side (belt and braces, not a substitute for
// the client itself being dedupe-safe on reconnect).
export const RealtimeExecutionEventMessageSchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("execution.event"),
  executionId: z.string().min(1),
  event: RealtimeExecutionEventSchema,
});
export type RealtimeExecutionEventMessage = z.infer<typeof RealtimeExecutionEventMessageSchema>;

// Server-driven only (ADR-0007: "the browser must never be responsible for
// deciding an execution is done"). Never mapped to any business-lifecycle
// status (SETTLED/ACCEPTED/etc) — outcome here is exactly the same
// success/failure the worker reported to
// POST /internal/executions/:id/complete, nothing more.
export const RealtimeExecutionCompletedSchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("execution.completed"),
  executionId: z.string().min(1),
  outcome: z.enum(["success", "failure"]),
  // The count of execution_events rows persisted in Postgres at the moment
  // the gateway performed its final reconciliation fetch — lets a client
  // sanity-check its own rendered event count against the authoritative
  // source without a second round-trip.
  finalEventCount: z.number().int().nonnegative(),
});
export type RealtimeExecutionCompleted = z.infer<typeof RealtimeExecutionCompletedSchema>;

// Sent when no Phase 3B worker relay is currently registered for this
// execution (never connected, disconnected, or the gateway process itself
// restarted since the registry is in-memory/process-local). This must never
// be confused with "the execution is finished" — historical data (already
// delivered via history.ready, from Postgres) remains valid regardless, and
// this message can be followed by real execution.event messages later if a
// relay registers afterward (e.g. the worker itself reconnecting is Phase
// 3E's scope, but a browser connecting before vs. after the worker's own
// relay handshake completes is a real, harmless race in this phase already).
export const RealtimeRelayUnavailableSchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("relay.unavailable"),
  executionId: z.string().min(1),
  reason: z.string().min(1),
});
export type RealtimeRelayUnavailable = z.infer<typeof RealtimeRelayUnavailableSchema>;

// Explicit rejection for anything the gateway will not act on — most
// importantly, ANY inbound browser message in this read-only phase (there is
// no legitimate client->server message type defined at all yet;
// realtime:control is Phase 3D). Never a silent drop.
export const RealtimeErrorSchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("error"),
  code: z.enum(["control_not_supported", "invalid_message", "internal_error"]),
  message: z.string().min(1),
});
export type RealtimeError = z.infer<typeof RealtimeErrorSchema>;

export const RealtimeServerMessageSchema = z.discriminatedUnion("type", [
  RealtimeServerHelloSchema,
  RealtimeHistoryReadySchema,
  RealtimeExecutionEventMessageSchema,
  RealtimeExecutionCompletedSchema,
  RealtimeRelayUnavailableSchema,
  RealtimeErrorSchema,
]);
export type RealtimeServerMessage = z.infer<typeof RealtimeServerMessageSchema>;
