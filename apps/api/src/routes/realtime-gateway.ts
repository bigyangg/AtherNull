// ADR-0007 Phase 3C — authenticated browser realtime viewing (read-only).
// See docs/adr/0007-secure-realtime-execution.md's "Phase 3C status" section
// for the full design rationale; this file's own comments cover only the
// "how", not the "why" already recorded there.
//
// Scope, exactly: an authenticated AtherNull browser may SUBSCRIBE to a
// RUNNING execution's event stream (persisted history + live tail). This
// paragraph describes the original Phase 3C (read-only) scope; the Phase 3D
// addendum immediately below it describes what was added on top.
//
// This route never touches SESSION_API_KEY, never calls anything under
// /internal/*, and never gives the browser any network coordinate for the
// worker or the Agent Server container — its only two data sources are (a)
// Postgres (execution_events, via the exact same tables the historical
// compat layer already reads) and (b) the in-process
// executionBroadcaster/relayRegistry, both of which live entirely inside
// apps/api.
//
// ADR-0007 Phase 3D adds realtime:control on top of the above, strictly
// additively: a connection without it still hits the exact same
// "control_not_supported" rejection Phase 3C always sent for any inbound
// message. A connection WITH it may send exactly one legitimate message
// shape (`execution.command`, packages/contracts/realtime-browser.ts),
// which is authorized against CURRENT server-side state on every single
// command (never just the connect-time check) before being forwarded to the
// worker relay — see `handleControlMessage` below. This file still never
// touches SESSION_API_KEY and never calls anything under /internal/*; the
// command is forwarded over the exact same worker relay socket Phase 3B
// already established (relayRegistry.sendCommand), never a new connection.

import {
  REALTIME_BROWSER_PROTOCOL_VERSION,
  RealtimeClientMessageSchema,
  type CommandStatusValue,
  type RealtimeExecutionEvent,
  type RealtimeServerMessage,
} from "@athernull/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import { db } from "../db.js";
import { RELAY_PROTOCOL_VERSION } from "../realtime/envelope.js";
import { controlRegistry, type CommandAckStatus } from "../realtime/control-registry.js";
import {
  executionBroadcaster,
  type BroadcastExecutionEvent,
  type ExecutionCompletionOutcome,
} from "../realtime/execution-broadcaster.js";
import { attachHeartbeat } from "../realtime/heartbeat.js";
import { relayRegistry } from "../realtime/relay-registry.js";
import { resolveConversationTarget } from "./openhands-compat.js";
import { HttpError, hasRealtimeControlAuthority, requireOrgSession, sendHttpError } from "../session.js";
import { isTrustedOrigin } from "../trusted-origins.js";

// ADR-0007 Phase 3D backpressure bounds (all in-memory, per this gateway
// process — same "not durable" caveat as controlRegistry itself). None of
// these are configurable via env var in v1: they are conservative,
// hardcoded defaults, not a tuning surface this phase needs to expose.
const MAX_CONTROL_MESSAGE_BYTES = 16 * 1024; // 16 KiB — comfortably above MAX_COMMAND_TEXT_LENGTH (8000) plus JSON/envelope overhead.
const MAX_PENDING_COMMANDS_PER_CONNECTION = 5;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_COMMANDS_PER_WINDOW = 10;

interface RealtimeAuth {
  executionId: string;
  taskId: string;
  executionStatus: string;
  organizationId: string;
  // ADR-0007 Phase 3D: decided once at connect time from the live role
  // requireOrgSession's preValidation check already fetched — but NEVER
  // trusted alone for an actual command (see handleControlMessage's own
  // fresh requireOrgSession re-check). This flag only controls whether the
  // connection is even allowed to attempt sending a command at all, and
  // what `server.hello` reports to the frontend.
  canControl: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    realtimeAuth?: RealtimeAuth;
  }
}

const ParamsSchema = z.object({ id: z.string().min(1) });
// Optional defense-in-depth cross-check, not itself a security boundary
// (resolution is already org-scoped regardless): the browser already knows
// both taskId and executionId (apps/web's RealWorkspaceView), so it can
// optionally assert which execution attempt it expects. If a task has
// retried, this catches "the requestedId's task_id_fallback landed on a
// different attempt than the one the tab is displaying" as an explicit
// rejection instead of silently subscribing to the wrong attempt's stream.
const QuerySchema = z.object({ executionId: z.string().min(1).optional() });

// ADR-0007 Phase 3D — best-effort extraction of a commandId from an
// otherwise-invalid inbound message, so a malformed/unrecognized command can
// still be rejected as a specific commandId's "rejected" status rather than
// a bare, un-actionable error frame the browser can't attribute to any one
// in-flight submission. Never throws; returns undefined for anything that
// isn't a plain object with a non-empty string `commandId` field.
function extractCommandId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const commandId = (value as Record<string, unknown>).commandId;
  return typeof commandId === "string" && commandId.length > 0 ? commandId : undefined;
}

async function loadPersistedEvents(executionId: string): Promise<RealtimeExecutionEvent[]> {
  const rows = await db
    .selectFrom("execution_events")
    .select(["id", "kind", "payload", "occurred_at"])
    .where("execution_id", "=", executionId)
    .orderBy("occurred_at", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  }));
}

export async function realtimeGatewayRoutes(app: FastifyInstance) {
  app.decorateRequest("realtimeAuth", undefined);

  app.get(
    "/v1/realtime/executions/:id",
    {
      websocket: true,
      // Runs BEFORE the WebSocket upgrade completes (@fastify/websocket only
      // calls wss.handleUpgrade from inside the route's `handler`, confirmed
      // by reading its source in Phase 3B) — a reply sent from here means an
      // unauthorized browser never gets a live socket, same guarantee
      // routes/relay.ts already established for the worker leg.
      //
      // Check order (deliberately not identical to the ADR's own prose
      // ordering "session, Origin, org membership, execution scope,
      // capability" — this codebase's actual primitive, requireOrgSession,
      // inseparably bundles session validation AND live org-membership
      // re-query into one call, so those two cannot be split apart to match
      // the ADR's list item-for-item). Origin is checked FIRST instead,
      // ahead of any auth work: it is the cheapest possible check (no DB
      // access at all) and rejecting a forged cross-site upgrade attempt
      // before spending any session/DB cost on it is strictly safer, not a
      // weaker interpretation of the requirement that all of these checks
      // must pass. realtime:view's authorization rule (documented in the
      // ADR's Phase 3C status section) is exactly requireOrgSession's own
      // bar — no additional capability check exists beyond it in v1.
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const origin = request.headers.origin;
          if (!isTrustedOrigin(origin)) {
            request.log.warn({ origin: origin ?? null }, "realtime gateway: rejected upgrade with untrusted/missing Origin");
            reply.status(403).send({ error: "Untrusted or missing Origin" });
            return;
          }

          // Real Better Auth session + live org-membership re-query
          // (auth.api.getActiveMember() inside requireOrgSession) — a
          // removed member is rejected immediately, identical guarantee
          // Phase 2's own "removed member" test already proved for the
          // historical compat layer.
          const { organizationId, role } = await requireOrgSession(request);

          const { id } = ParamsSchema.parse(request.params);
          const query = QuerySchema.parse(request.query);

          // The exact same org-scoped resolver Phase 2 built and tested —
          // no second resolution implementation, no new identity concept.
          // A cross-org or genuinely nonexistent id both resolve to `null`
          // here, identically — this route must not let a browser
          // distinguish those two cases any more than the historical compat
          // layer already refuses to.
          const resolution = await resolveConversationTarget(id, organizationId);
          if (!resolution) {
            reply.status(404).send({ error: "Not found" });
            return;
          }
          if (!resolution.execution) {
            reply.status(409).send({ error: "This task has no execution yet — nothing to view live" });
            return;
          }
          if (query.executionId && query.executionId !== resolution.execution.id) {
            reply.status(409).send({ error: "executionId does not match the resolved execution" });
            return;
          }
          if (resolution.execution.status !== "RUNNING") {
            reply.status(409).send({
              error: `Execution is not RUNNING (currently ${resolution.execution.status}) — use the historical view instead`,
            });
            return;
          }

          request.realtimeAuth = {
            executionId: resolution.execution.id,
            taskId: resolution.task.id,
            executionStatus: resolution.execution.status,
            organizationId,
            // ADR-0007 Phase 3D authorization policy (session.ts's own
            // header comment has the full rationale): realtime:control is
            // gated on the exact same owner/admin tier that already gates
            // fund/verify/accept/reject, reused deliberately rather than a
            // new permission concept.
            canControl: hasRealtimeControlAuthority(role),
          };
        } catch (err) {
          if (sendHttpError(reply, err)) return;
          if (err instanceof z.ZodError) {
            reply.status(400).send({ error: err.message });
            return;
          }
          if (err instanceof HttpError) {
            reply.status(err.status).send({ error: err.message });
            return;
          }
          throw err;
        }
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const auth = request.realtimeAuth;
      if (!auth) {
        // Unreachable in practice, same defensive posture as relay.ts.
        socket.close(4003, "unauthenticated");
        return;
      }
      const { executionId, taskId, executionStatus, organizationId, canControl } = auth;

      let closed = false;
      let completionHandled = false;
      const sentIds = new Set<string>();

      function send(message: RealtimeServerMessage): void {
        if (closed) return;
        try {
          socket.send(JSON.stringify(message));
        } catch {
          // Best-effort — the socket may already be closing.
        }
      }

      // --- ADR-0007 Phase 3D: realtime:control state, scoped to this one
      // connection --------------------------------------------------------
      let pendingCommandCount = 0;
      const rateLimitTimestamps: number[] = [];
      const pendingCancels = new Map<string, () => void>();
      // Commands this connection has seen accepted, awaiting the "executed"
      // heuristic below — bounded, oldest-first, same reasoning as every
      // other bound in this phase.
      const acceptedAwaitingExecuted: string[] = [];
      const MAX_ACCEPTED_AWAITING = 20;

      function sendCommandStatus(commandId: string, status: CommandStatusValue, reason?: string): void {
        send({
          version: REALTIME_BROWSER_PROTOCOL_VERSION,
          type: "command.status",
          executionId,
          commandId,
          status,
          ...(reason ? { reason } : {}),
        });
      }

      function sendEventOnce(event: BroadcastExecutionEvent | RealtimeExecutionEvent): void {
        if (sentIds.has(event.id)) return;
        sentIds.add(event.id);
        send({
          version: REALTIME_BROWSER_PROTOCOL_VERSION,
          type: "execution.event",
          executionId,
          event: { id: event.id, kind: event.kind, occurredAt: event.occurredAt, payload: event.payload },
        });
        // ADR-0007 Phase 3D — best-effort "executed" heuristic (explicitly
        // NOT a precise per-command correlation — see the ADR's Phase 3D
        // status section for why a real event<->commandId correlation is
        // deferred to a future phase): the oldest command this connection
        // has seen "accepted" is upgraded to "executed" the next time ANY
        // execution.event is observed for this execution. This is honest
        // about being a heuristic, not a guarantee that THIS specific event
        // resulted from THAT specific command — but it is the "a normal
        // OpenHands event proves execution" signal the ADR asks for, without
        // inventing a second, un-audited event-identity scheme to correlate
        // them exactly.
        const nextCommandId = acceptedAwaitingExecuted.shift();
        if (nextCommandId) {
          sendCommandStatus(nextCommandId, "executed");
        }
      }

      // --- History <-> live handoff -----------------------------------
      //
      // Invariant 1 (no event lost in the transition) and invariant 2
      // (duplicate delivery across the transition is safe) are satisfied by
      // this exact sequencing, not by a timing assumption:
      //   1. Subscribe to the live broadcaster channel FIRST, before the
      //      Postgres history read even begins. Anything published in the
      //      gap between "subscribe" and "history query returns" lands in
      //      `preHistoryBuffer` instead of being missed.
      //   2. Query Postgres (the authoritative source, invariant 3) and
      //      send `history.ready`, recording every id it contained in
      //      `sentIds` (invariant 4: the event's own uuid is the dedup
      //      identity).
      //   3. Flush `preHistoryBuffer` through `sendEventOnce`, which is a
      //      no-op for anything `sentIds` already has — so an event that
      //      landed in Postgres AND was also observed live during the gap
      //      is delivered exactly once, and an event that only arrived live
      //      (not yet visible to the history query) is still delivered.
      //   4. From then on, the same live subscription (still open, never
      //      re-created) delivers everything through `sendEventOnce`
      //      directly — no separate "live mode" code path to drift from the
      //      buffered one.
      const preHistoryBuffer: BroadcastExecutionEvent[] = [];
      let bufferingPreHistory = true;

      const unsubscribeEvent = executionBroadcaster.onEvent(executionId, (event) => {
        if (bufferingPreHistory) {
          preHistoryBuffer.push(event);
          return;
        }
        sendEventOnce(event);
      });

      let pendingCompletionOutcome: ExecutionCompletionOutcome | null = null;
      const unsubscribeCompletion = executionBroadcaster.onCompletion(executionId, (outcome) => {
        if (bufferingPreHistory) {
          // Recorded, not acted on yet — handled right after the buffer is
          // flushed below, so a client never sees execution.completed
          // before history.ready.
          pendingCompletionOutcome = outcome;
          return;
        }
        void handleCompletion(outcome);
      });

      // ADR-0007 Phase 3E — same bounded liveness detection as the worker
      // relay leg (relay.ts): a browser tab whose network died without a
      // clean close (laptop sleep, wifi drop, etc.) is otherwise
      // indistinguishable from "still there" until some future write fails —
      // this bounds that to one heartbeat interval, freeing the connection's
      // resources (unsubscribing from executionBroadcaster, cancelling any
      // pending command waits) promptly rather than leaking them for the
      // life of a half-open TCP connection.
      const heartbeat = attachHeartbeat(socket);

      function cleanup(): void {
        closed = true;
        heartbeat.stop();
        unsubscribeEvent();
        unsubscribeCompletion();
        // ADR-0007 Phase 3D: a command left waiting for a worker ack must
        // never fire its status callback after this connection is gone
        // (there is no browser left to send it to) — cancel every
        // still-pending wait this connection registered.
        for (const cancel of pendingCancels.values()) cancel();
        pendingCancels.clear();
      }

      // --- Completion (server-driven only, per ADR-0007) ----------------
      async function handleCompletion(outcome: ExecutionCompletionOutcome): Promise<void> {
        if (completionHandled) return;
        completionHandled = true;
        // Final reconciliation fetch: re-read Postgres one more time so any
        // event that only landed via the worker's post-run resync gap-fill
        // (Phase 3B's own documented relay-vs-persisted-count gap) is still
        // delivered before the socket closes — this is why completion does
        // a fresh query rather than trusting `sentIds` was already complete.
        const rows = await loadPersistedEvents(executionId);
        for (const row of rows) sendEventOnce(row);
        send({
          version: REALTIME_BROWSER_PROTOCOL_VERSION,
          type: "execution.completed",
          executionId,
          outcome,
          finalEventCount: rows.length,
        });
        cleanup();
        try {
          socket.close(1000, "execution-completed");
        } catch {
          // Best-effort.
        }
      }

      socket.on("close", cleanup);
      socket.on("error", (err: Error) => {
        request.log.warn({ executionId, taskId, err }, "realtime gateway socket error");
      });

      // ADR-0007 Phase 3D: a connection without realtime:control gets the
      // exact same unconditional rejection Phase 3C always gave every
      // inbound message — nothing about that default changes. A connection
      // WITH realtime:control gets its messages routed to
      // handleControlMessage instead, which re-validates everything
      // (schema, authorization, execution/lease state, backpressure,
      // dedupe) before ever forwarding anything.
      socket.on("message", (raw: Buffer) => {
        if (!canControl) {
          request.log.warn(
            { executionId, taskId, size: raw.byteLength },
            "realtime gateway: rejected inbound browser message (this connection does not hold realtime:control)",
          );
          send({
            version: REALTIME_BROWSER_PROTOCOL_VERSION,
            type: "error",
            code: "control_not_supported",
            message:
              "This connection is realtime:view only. Sending commands into a running execution requires realtime:control.",
          });
          return;
        }
        void handleControlMessage(raw);
      });

      // --- ADR-0007 Phase 3D: realtime:control inbound command handling --
      async function handleControlMessage(raw: Buffer): Promise<void> {
        if (raw.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
          request.log.warn({ executionId, taskId, size: raw.byteLength }, "realtime gateway: oversized control message, rejecting");
          send({
            version: REALTIME_BROWSER_PROTOCOL_VERSION,
            type: "error",
            code: "invalid_message",
            message: "Message exceeds the maximum allowed size.",
          });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          send({ version: REALTIME_BROWSER_PROTOCOL_VERSION, type: "error", code: "invalid_message", message: "Malformed JSON." });
          return;
        }

        const result = RealtimeClientMessageSchema.safeParse(parsed);
        if (!result.success) {
          // Salvage a commandId if the shape was close-but-invalid (e.g. an
          // unknown command.type, or an oversized text field caught by the
          // Zod schema itself) so the rejection can be attributed to a
          // specific command rather than a bare, un-actionable error frame —
          // this is exactly the "reject unknown fields/types" /
          // "enforce size limits" requirement, done per-command wherever
          // possible.
          const maybeCommandId = extractCommandId(parsed);
          if (maybeCommandId) {
            sendCommandStatus(maybeCommandId, "rejected", "invalid_payload");
          } else {
            send({
              version: REALTIME_BROWSER_PROTOCOL_VERSION,
              type: "error",
              code: "invalid_message",
              message: "Unrecognized or malformed message.",
            });
          }
          return;
        }

        const message = result.data;
        const { commandId, executionId: claimedExecutionId, command } = message;

        if (claimedExecutionId !== executionId) {
          sendCommandStatus(commandId, "rejected", "execution_id_mismatch");
          return;
        }

        // ADR-0007's own at-most-once rule: a commandId already forwarded
        // once by this gateway process is never forwarded again, regardless
        // of why the browser sent it twice (retry, reconnect, bug). This is
        // an explicit, deliberate rejection, not a silent drop.
        if (controlRegistry.hasBeenForwarded(commandId)) {
          request.log.warn({ executionId, commandId }, "realtime gateway: duplicate commandId, not forwarding again");
          sendCommandStatus(commandId, "rejected", "duplicate_command_id");
          return;
        }

        // Backpressure — bounded per connection, checked before any DB work.
        if (pendingCommandCount >= MAX_PENDING_COMMANDS_PER_CONNECTION) {
          sendCommandStatus(commandId, "rejected", "too_many_pending");
          return;
        }
        const now = Date.now();
        while (rateLimitTimestamps.length > 0 && now - (rateLimitTimestamps[0] ?? now) > RATE_LIMIT_WINDOW_MS) {
          rateLimitTimestamps.shift();
        }
        if (rateLimitTimestamps.length >= RATE_LIMIT_MAX_COMMANDS_PER_WINDOW) {
          sendCommandStatus(commandId, "rejected", "rate_limited");
          return;
        }

        sendCommandStatus(commandId, "received");

        // ADR-0007: "do not rely only on authorization performed when the
        // WebSocket first connected" — every command re-runs the real
        // session + live org-membership check (the same
        // auth.api.getActiveMember() re-query requireOrgSession already
        // does), not just the connect-time snapshot. A demoted/removed
        // member's very next command is rejected immediately, matching the
        // guarantee Phase 2/3C already established for connection-level
        // checks, now extended to command-level.
        let freshRole: string;
        try {
          const fresh = await requireOrgSession(request);
          if (fresh.organizationId !== organizationId) {
            sendCommandStatus(commandId, "rejected", "not_authorized");
            return;
          }
          freshRole = fresh.role;
        } catch {
          sendCommandStatus(commandId, "rejected", "not_authorized");
          return;
        }
        if (!hasRealtimeControlAuthority(freshRole)) {
          sendCommandStatus(commandId, "rejected", "not_authorized");
          return;
        }

        // Fresh execution/lease/status revalidation — never trust the
        // connect-time RUNNING check for a mutating command. Re-queries the
        // same executions row internal.ts's own claim/heartbeat/complete
        // handlers are the sole writers of, so this always reflects the
        // current authoritative state, not a cached one.
        const executionRow = await db
          .selectFrom("executions")
          .select(["id", "status", "lease_owner"])
          .where("id", "=", executionId)
          .executeTakeFirst();
        if (!executionRow || executionRow.status !== "RUNNING") {
          sendCommandStatus(commandId, "rejected", "execution_not_running");
          return;
        }
        const relayConnection = relayRegistry.get(executionId);
        if (!relayConnection) {
          sendCommandStatus(commandId, "rejected", "no_active_relay");
          return;
        }
        if (relayConnection.workerId !== executionRow.lease_owner) {
          // The lease moved (or this connection is somehow stale) — never
          // send a command into an execution whose lease no longer matches
          // the relay we'd be forwarding through.
          sendCommandStatus(commandId, "rejected", "lease_mismatch");
          return;
        }

        sendCommandStatus(commandId, "authorized");

        rateLimitTimestamps.push(now);
        pendingCommandCount += 1;
        controlRegistry.markForwarded(commandId, executionId);

        const relayEnvelope = {
          version: RELAY_PROTOCOL_VERSION,
          type: "gateway.command" as const,
          executionId,
          eventId: null,
          payload: { commandId, command },
        };

        const sent = relayRegistry.sendCommand(executionId, relayEnvelope);
        if (!sent) {
          pendingCommandCount = Math.max(0, pendingCommandCount - 1);
          sendCommandStatus(commandId, "rejected", "no_active_relay");
          return;
        }

        sendCommandStatus(commandId, "forwarded");

        const { cancel } = controlRegistry.registerPending(commandId, executionId, {
          onAck: (status: CommandAckStatus, detail?: string) => {
            pendingCancels.delete(commandId);
            pendingCommandCount = Math.max(0, pendingCommandCount - 1);
            if (status === "accepted") {
              sendCommandStatus(commandId, "accepted");
              acceptedAwaitingExecuted.push(commandId);
              if (acceptedAwaitingExecuted.length > MAX_ACCEPTED_AWAITING) {
                acceptedAwaitingExecuted.shift();
              }
            } else if (status === "rejected") {
              // The WORKER itself declined to forward — distinct from this
              // gateway's own "rejected" above, but the same terminal
              // status from the browser's point of view (AtherNull's own
              // system chose not to let this command reach the agent).
              sendCommandStatus(commandId, "rejected", detail ?? "worker_rejected");
            } else {
              sendCommandStatus(commandId, "failed", detail ?? "agent_server_error");
            }
          },
          onTimeout: () => {
            pendingCancels.delete(commandId);
            pendingCommandCount = Math.max(0, pendingCommandCount - 1);
            // ADR-0007's explicit v1 rule: never automatically resend. The
            // browser is told, honestly, that the outcome is unknown.
            sendCommandStatus(commandId, "uncertain", "ack_timeout");
          },
        });
        pendingCancels.set(commandId, cancel);
      }

      send({
        version: REALTIME_BROWSER_PROTOCOL_VERSION,
        type: "server.hello",
        executionId,
        taskId,
        executionStatus,
        canControl,
      });

      // Relay-unavailable is informational, not fatal: historical data below
      // is served from Postgres regardless of relay state, and this must
      // never be confused with "the execution is finished" (that is only
      // ever `execution.completed`, driven by the broadcaster above).
      if (!relayRegistry.get(executionId)) {
        send({
          version: REALTIME_BROWSER_PROTOCOL_VERSION,
          type: "relay.unavailable",
          executionId,
          reason:
            "No active worker relay is currently registered for this execution (never connected, disconnected, or this gateway process restarted). Historical events are still available; new live events will only appear if a relay registers.",
        });
      }

      void (async () => {
        try {
          const rows = await loadPersistedEvents(executionId);
          for (const row of rows) sentIds.add(row.id);
          send({
            version: REALTIME_BROWSER_PROTOCOL_VERSION,
            type: "history.ready",
            executionId,
            events: rows,
          });

          bufferingPreHistory = false;
          const buffered = preHistoryBuffer.splice(0, preHistoryBuffer.length);
          for (const event of buffered) sendEventOnce(event);

          if (pendingCompletionOutcome && !closed) {
            await handleCompletion(pendingCompletionOutcome);
          }
        } catch (err) {
          request.log.error({ executionId, taskId, err }, "realtime gateway: failed to load/send history");
          send({
            version: REALTIME_BROWSER_PROTOCOL_VERSION,
            type: "error",
            code: "internal_error",
            message: "Failed to load execution history.",
          });
        }
      })();
    },
  );
}
