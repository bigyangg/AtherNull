// ADR-0007 Phase 3C — authenticated browser realtime viewing (read-only).
// See docs/adr/0007-secure-realtime-execution.md's "Phase 3C status" section
// for the full design rationale; this file's own comments cover only the
// "how", not the "why" already recorded there.
//
// Scope, exactly: an authenticated AtherNull browser may SUBSCRIBE to a
// RUNNING execution's event stream (persisted history + live tail). Nothing
// in this file accepts, relays, or even parses an inbound browser message
// into anything actionable — every inbound message is rejected explicitly
// (see the "message" handler below). realtime:control (chat/bash forwarding,
// command envelopes) is Phase 3D, not started here.
//
// This route never touches SESSION_API_KEY, never calls anything under
// /internal/*, and never gives the browser any network coordinate for the
// worker or the Agent Server container — its only two data sources are (a)
// Postgres (execution_events, via the exact same tables the historical
// compat layer already reads) and (b) the in-process
// executionBroadcaster/relayRegistry, both of which live entirely inside
// apps/api.

import {
  REALTIME_BROWSER_PROTOCOL_VERSION,
  type RealtimeExecutionEvent,
  type RealtimeServerMessage,
} from "@athernull/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import { db } from "../db.js";
import {
  executionBroadcaster,
  type BroadcastExecutionEvent,
  type ExecutionCompletionOutcome,
} from "../realtime/execution-broadcaster.js";
import { relayRegistry } from "../realtime/relay-registry.js";
import { resolveConversationTarget } from "./openhands-compat.js";
import { HttpError, requireOrgSession, sendHttpError } from "../session.js";
import { isTrustedOrigin } from "../trusted-origins.js";

interface RealtimeAuth {
  executionId: string;
  taskId: string;
  executionStatus: string;
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
          const { organizationId } = await requireOrgSession(request);

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
      const { executionId, taskId, executionStatus } = auth;

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

      function sendEventOnce(event: BroadcastExecutionEvent | RealtimeExecutionEvent): void {
        if (sentIds.has(event.id)) return;
        sentIds.add(event.id);
        send({
          version: REALTIME_BROWSER_PROTOCOL_VERSION,
          type: "execution.event",
          executionId,
          event: { id: event.id, kind: event.kind, occurredAt: event.occurredAt, payload: event.payload },
        });
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

      function cleanup(): void {
        closed = true;
        unsubscribeEvent();
        unsubscribeCompletion();
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

      // Read-only phase: there is no defined client->server message type at
      // all. Every inbound message — whether it looks like a future
      // realtime:control command (chat send, bash exec) or anything else —
      // is rejected explicitly and logged, never silently dropped, per
      // ADR-0007's Phase 3C scope boundary.
      socket.on("message", (raw: Buffer) => {
        request.log.warn(
          { executionId, taskId, size: raw.byteLength },
          "realtime gateway: rejected inbound browser message (view-only connection, no realtime:control in this phase)",
        );
        send({
          version: REALTIME_BROWSER_PROTOCOL_VERSION,
          type: "error",
          code: "control_not_supported",
          message:
            "This connection is realtime:view only. Sending commands into a running execution is not supported (realtime:control is not implemented in this phase).",
        });
      });

      send({
        version: REALTIME_BROWSER_PROTOCOL_VERSION,
        type: "server.hello",
        executionId,
        taskId,
        executionStatus,
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
