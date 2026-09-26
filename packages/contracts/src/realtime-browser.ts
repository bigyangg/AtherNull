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
  // ADR-0007 Phase 3D: whether THIS connection currently holds
  // realtime:control, decided entirely server-side (requireOrgSession's role
  // plus AtherNull's existing owner/admin policy — see session.ts). The
  // frontend must treat this as informational only, never as its own
  // authorization decision: every command is re-checked server-side
  // regardless of what this flag said at connect time.
  canControl: z.boolean(),
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

// ADR-0007 Phase 3D — authorized browser -> agent control. Everything below
// this line is new; everything above is unchanged from Phase 3C (the
// discriminated union at the bottom of this file is extended, not replaced).
//
// realtime:control is a SEPARATE, strictly additive capability on top of
// realtime:view (see docs/adr/0007-secure-realtime-execution.md's Phase 3D
// status section for the authorization policy). A connection without
// realtime:control still gets `RealtimeErrorSchema`'s existing
// "control_not_supported" rejection for ANY inbound message, unchanged from
// Phase 3C — nothing here weakens that default. `server.hello` gains one new
// field (`canControl`) so the frontend reflects a permission decision the
// gateway already made, rather than deciding for itself (ADR-0007: "Do not
// let the frontend decide whether someone has control permission").
//
// V1 delivery semantics (deliberate, not an oversight — see the ADR): AT-MOST-
// ONCE submission with EXPLICIT DELIVERY UNCERTAINTY. There is no durable
// command ledger and no automatic retry. `commandId` is the browser command's
// own identity — it is NEVER an OpenHands event id, and reusing an
// execution-event UUID as a commandId (or vice versa) is a bug, not a
// convenience shortcut.

// Narrowest useful v1 command surface (ADR-0007 Phase 3D source audit):
// only a chat/user message. Terminal/bash forwarding was investigated and
// deliberately deferred — the installed OpenHands SDK's own
// RemoteConversation exposes no raw-shell-execution method (send_message /
// run / pause / interrupt / confirm-reject only); the pinned frontend's
// `/sockets/bash-events` PTY-style channel is a frontend-specific
// convenience the Agent Server happens to also accept, not something the
// Python SDK client this worker actually uses exposes or relies on. Faking
// bash as a disguised chat message, or building a second, unaudited direct
// execution path, was rejected as unsafe — see the ADR for the full
// reasoning. Adding a real terminal command type is left to a future phase.
export const ExecutionCommandTypeSchema = z.enum(["agent.message"]);
export type ExecutionCommandType = z.infer<typeof ExecutionCommandTypeSchema>;

// Deliberately conservative: plain text only, no markup/HTML, no attachments.
export const MAX_COMMAND_TEXT_LENGTH = 8_000;

export const AgentMessageCommandSchema = z.object({
  type: z.literal("agent.message"),
  payload: z.object({
    text: z.string().min(1).max(MAX_COMMAND_TEXT_LENGTH),
  }),
});

// z.discriminatedUnion requires 2+ members — a single-member allowlist is
// still expressed as a union of one so adding a second command type later
// (e.g. a future, carefully-audited terminal command) is a pure addition to
// this list, never a restructuring of callers.
export const ExecutionCommandPayloadSchema = z.discriminatedUnion("type", [
  AgentMessageCommandSchema,
]);
export type ExecutionCommandPayload = z.infer<typeof ExecutionCommandPayloadSchema>;

// Browser -> gateway. This is the ONLY legitimate inbound message shape when
// a connection holds realtime:control; anything else (unknown `type`, wrong
// `version`, missing fields) is rejected as `invalid_message`, and a
// commandId that has already been seen for this execution (bounded,
// in-memory, this gateway process only — ADR-0007: "not durable
// exactly-once delivery") is never forwarded a second time.
export const ExecutionCommandMessageSchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("execution.command"),
  commandId: z.string().uuid(),
  executionId: z.string().min(1),
  command: ExecutionCommandPayloadSchema,
});
export type ExecutionCommandMessage = z.infer<typeof ExecutionCommandMessageSchema>;

export const RealtimeClientMessageSchema = z.discriminatedUnion("type", [
  ExecutionCommandMessageSchema,
]);
export type RealtimeClientMessage = z.infer<typeof RealtimeClientMessageSchema>;

// Explicit command lifecycle states (ADR-0007 Phase 3D). REJECTED = AtherNull
// deliberately did not forward the command (authorization, validation,
// backpressure, or execution/lease state made forwarding unsafe). FAILED =
// downstream (worker or Agent Server) explicitly reported failure. UNCERTAIN
// = the command may have been forwarded and/or executed, but the system lost
// enough acknowledgement state (e.g. the worker relay disconnected before
// acking) to no longer safely know the outcome — this is never silently
// resent, and must never be presented to the user as though it were FAILED.
export const CommandStatusValueSchema = z.enum([
  "received",
  "authorized",
  "forwarded",
  "accepted",
  "executed",
  "failed",
  "rejected",
  "uncertain",
]);
export type CommandStatusValue = z.infer<typeof CommandStatusValueSchema>;

// Gateway -> browser, one or more per commandId, ending in exactly one
// terminal status (accepted alone is not terminal if `executed` can still
// follow — see the ADR's note on how "executed" is derived in this phase).
export const RealtimeCommandStatusSchema = z.object({
  version: z.literal(REALTIME_BROWSER_PROTOCOL_VERSION),
  type: z.literal("command.status"),
  executionId: z.string().min(1),
  commandId: z.string().min(1),
  status: CommandStatusValueSchema,
  // Machine-readable reason for rejected/failed/uncertain — e.g.
  // "not_authorized", "execution_not_running", "no_active_relay",
  // "lease_mismatch", "duplicate_command_id", "oversized_payload",
  // "unknown_command_type", "invalid_payload", "rate_limited",
  // "too_many_pending", "worker_disconnected", "agent_server_error".
  reason: z.string().optional(),
});
export type RealtimeCommandStatus = z.infer<typeof RealtimeCommandStatusSchema>;

export const RealtimeServerMessageSchema = z.discriminatedUnion("type", [
  RealtimeServerHelloSchema,
  RealtimeHistoryReadySchema,
  RealtimeExecutionEventMessageSchema,
  RealtimeExecutionCompletedSchema,
  RealtimeRelayUnavailableSchema,
  RealtimeErrorSchema,
  RealtimeCommandStatusSchema,
]);
export type RealtimeServerMessage = z.infer<typeof RealtimeServerMessageSchema>;
