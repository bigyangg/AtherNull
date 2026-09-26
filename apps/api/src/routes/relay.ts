import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import { db } from "../db.js";
import { persistExecutionEvents } from "../execution-events.js";
import { requireInternalToken } from "../internal-auth.js";
import { executionBroadcaster } from "../realtime/execution-broadcaster.js";
import { RelayEnvelopeSchema, RelayExecutionEventPayloadSchema } from "../realtime/envelope.js";
import { relayRegistry } from "../realtime/relay-registry.js";

// Matches the maxPayload bound configured on the @fastify/websocket plugin
// in app.ts — kept here too as an explicit, self-documenting application-
// level bound (the transport-level one terminates the connection on an
// oversized frame; this one lets a single malformed/huge message be logged
// and ignored without ever reaching JSON.parse).
export const MAX_RELAY_MESSAGE_BYTES = 1_048_576; // 1 MiB

interface RelayAuth {
  executionId: string;
  workerId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    relayAuth?: RelayAuth;
  }
}

// ADR-0007 Phase 3B — worker -> apps/api outbound relay registration.
//
// Trust direction: the worker always initiates this connection outward to
// apps/api. apps/api never connects to a worker or to any Agent Server
// container. Authentication mirrors internal.ts's existing convention
// exactly (duplicated inline per route, not abstracted — see internal.ts's
// own header comment on this): requireInternalToken() first, then a lease
// check (`executions.lease_owner === workerId`), then a status check
// (`executions.status === 'RUNNING'`) — the execution's own status column,
// not the parent task's, since that's what actually flips at claim/complete
// time (routes/internal.ts).
//
// The check runs in `preValidation`, which Fastify's request lifecycle runs
// BEFORE the route's `handler` — and @fastify/websocket only performs the
// actual WebSocket upgrade (`wss.handleUpgrade`) from inside that `handler`
// (see node_modules/@fastify/websocket/index.js). So a `reply.status(...).
// send()` from `preValidation` short-circuits the lifecycle and the 101
// Switching Protocols response is never sent — an unauthorized attempt
// never gets a live socket, satisfying ADR-0007's stated goal exactly, not
// just approximately.
export async function relayRoutes(app: FastifyInstance) {
  app.decorateRequest("relayAuth", undefined);

  app.get(
    "/internal/relay/:executionId",
    {
      websocket: true,
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!requireInternalToken(request, reply)) return;

        const { executionId } = z.object({ executionId: z.string().min(1) }).parse(request.params);
        const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.query);

        const execution = await db
          .selectFrom("executions")
          .select(["id", "lease_owner", "status"])
          .where("id", "=", executionId)
          .executeTakeFirst();

        if (!execution) {
          reply.status(404).send({ error: "Not found" });
          return;
        }
        if (execution.lease_owner !== workerId) {
          reply.status(409).send({ error: "Lease no longer owned by this worker" });
          return;
        }
        if (execution.status !== "RUNNING") {
          reply.status(409).send({ error: `Execution is not RUNNING (currently ${execution.status})` });
          return;
        }

        request.relayAuth = { executionId, workerId };
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const auth = request.relayAuth;
      if (!auth) {
        // Unreachable in practice — preValidation above always rejects
        // before the upgrade completes when auth isn't set. Defensive only.
        socket.close(4003, "unauthenticated");
        return;
      }

      const { executionId, workerId } = auth;
      relayRegistry.register({ executionId, workerId, socket, registeredAt: new Date() });
      request.log.info({ executionId, workerId }, "relay registered");

      socket.on("message", (raw: Buffer) => {
        void handleRelayMessage(request, executionId, raw);
      });

      socket.on("close", () => {
        relayRegistry.unregister(executionId, socket);
        request.log.info({ executionId, workerId }, "relay disconnected");
      });

      socket.on("error", (err: Error) => {
        request.log.warn({ executionId, workerId, err }, "relay socket error");
      });
    },
  );
}

async function handleRelayMessage(request: FastifyRequest, executionId: string, raw: Buffer): Promise<void> {
  // Failure/backpressure policy (ADR-0007 Phase 3B): every branch below
  // logs-and-ignores rather than throwing or closing the socket. A single
  // malformed or mismatched message from a worker must never take down its
  // relay connection (let alone the gateway process) — the worker's dispatch
  // and the authoritative HTTP event-persistence path must be completely
  // unaffected by anything that happens on this best-effort channel.
  if (raw.byteLength > MAX_RELAY_MESSAGE_BYTES) {
    request.log.warn({ executionId, size: raw.byteLength }, "relay message exceeds max size, ignoring");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    request.log.warn({ executionId }, "relay message is not valid JSON, ignoring");
    return;
  }

  const envelopeResult = RelayEnvelopeSchema.safeParse(parsed);
  if (!envelopeResult.success) {
    request.log.warn({ executionId, issues: envelopeResult.error.issues }, "malformed relay envelope, ignoring");
    return;
  }
  const envelope = envelopeResult.data;

  if (envelope.executionId !== executionId) {
    // Defense in depth: this connection was registered for exactly one
    // executionId at handshake time. A mismatched envelope is either a bug
    // in the worker or an attempt to write into another execution's event
    // stream — never something to act on.
    request.log.warn(
      { registeredFor: executionId, claimed: envelope.executionId },
      "relay envelope executionId mismatch, ignoring",
    );
    return;
  }

  if (envelope.type !== "execution.event") {
    // worker.ready / execution.completed / relay.heartbeat are lifecycle
    // signals only, observed here for logging — Phase 3B has no
    // browser-facing consumer for them yet (that's Phase 3C+).
    return;
  }

  const payloadResult = RelayExecutionEventPayloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    request.log.warn({ executionId }, "malformed execution.event payload, ignoring");
    return;
  }
  const record = payloadResult.data;
  if (envelope.eventId && envelope.eventId !== record.id) {
    request.log.warn({ executionId }, "execution.event eventId does not match payload.id, ignoring");
    return;
  }

  try {
    // Best-effort, opportunistic persistence only. The worker's own HTTP
    // POST /internal/executions/:id/events path (EventForwarder, batched)
    // remains the authoritative persistence path and will independently
    // deliver this same event — ON CONFLICT (id) DO NOTHING is exactly what
    // makes also writing it here safe rather than a second, competing
    // identity for the same event (a duplicate eventId arriving via the
    // relay, or arriving via both paths, never produces a second row).
    await persistExecutionEvents(executionId, [record]);
    request.log.info({ executionId, eventId: record.id, kind: record.kind }, "relay event persisted");
    // ADR-0007 Phase 3C fan-out: notify any subscribed browser gateway
    // connection for this execution. Best-effort/non-authoritative, exactly
    // like the persistence line above — a browser gateway that isn't
    // currently subscribed simply has no listener registered on this
    // channel, which is a normal no-op (EventEmitter.emit with zero
    // listeners), not an error.
    executionBroadcaster.publishEvent(executionId, record);
  } catch (err) {
    // A DB hiccup on this opportunistic write must never crash the socket
    // or the process — the HTTP path is unaffected and remains the real
    // backstop for persistence.
    request.log.warn({ executionId, err }, "relay event persistence failed (non-fatal, HTTP path unaffected)");
  }
}
