"use client";

import { useEffect, useRef, useState } from "react";

import type { RealtimeExecutionEvent, RealtimeServerMessage } from "@athernull/contracts";

// ADR-0007 Phase 3C — the smallest reasonable frontend integration proving
// the real path: authenticated browser -> apps/api's realtime gateway ->
// (worker relay | authoritative HTTP persistence) -> live event delivery,
// without a visual redesign of the workspace page. This hook does NOT
// replace useExecutionEvents (lib/hooks/use-execution-events.ts) — that
// hook's 2s poll against GET /v1/jobs/:id/executions/:executionId/events
// remains the historical/fallback data source, per this phase's own
// "coexist, don't replace" instruction. RealWorkspaceView (app/(app)/
// projects/[projectId]/workspace/page.tsx) prefers this hook's events once
// `history.ready` has arrived, and falls back to the polled events
// otherwise (connecting, relay.unavailable with no realtime:control
// dependency, or a WS error) — an execution that's already finished by the
// time the tab opens never even reaches RUNNING here, so it never attempts
// a socket at all (this hook is a no-op unless `active` is true).
//
// realtime:view only — this hook never sends anything over the socket. If a
// future Phase 3D adds realtime:control, that is new, explicit scope on top
// of this file, not an extension of it by default.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type RealtimeConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "relay-unavailable"
  | "completed"
  | "error"
  | "closed";

export interface UseExecutionRealtimeResult {
  // null until history.ready has been received at least once — callers
  // should treat null as "no realtime data yet, use the polled fallback."
  events: RealtimeExecutionEvent[] | null;
  status: RealtimeConnectionStatus;
  // True once relay.unavailable has been observed for the current
  // connection — informational only; historical `events` above remain
  // valid regardless (per ADR-0007, this must never be confused with
  // "finished").
  relayUnavailable: boolean;
}

function realtimeWebSocketUrl(taskId: string, executionId: string): string {
  const httpUrl = new URL(`/v1/realtime/executions/${encodeURIComponent(taskId)}`, API_URL);
  httpUrl.searchParams.set("executionId", executionId);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}

export function useExecutionRealtime(
  taskId: string,
  executionId: string | undefined,
  active: boolean,
): UseExecutionRealtimeResult {
  const [events, setEvents] = useState<RealtimeExecutionEvent[] | null>(null);
  const [status, setStatus] = useState<RealtimeConnectionStatus>("idle");
  const [relayUnavailable, setRelayUnavailable] = useState(false);
  // Keyed by event id — the sole dedup identity this protocol defines — so a
  // re-delivered id (safe by design, per ADR-0007's stated invariant) is
  // merged in place rather than appended as a duplicate row.
  const eventsById = useRef<Map<string, RealtimeExecutionEvent>>(new Map());

  useEffect(() => {
    if (!active || !executionId) {
      setStatus("idle");
      return;
    }

    eventsById.current = new Map();
    setEvents(null);
    setRelayUnavailable(false);
    setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(realtimeWebSocketUrl(taskId, executionId));
    } catch {
      setStatus("error");
      return;
    }

    function snapshot(): RealtimeExecutionEvent[] {
      return [...eventsById.current.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    }

    function upsert(event: RealtimeExecutionEvent) {
      eventsById.current.set(event.id, event);
    }

    socket.onopen = () => setStatus("open");

    socket.onmessage = (raw) => {
      let message: RealtimeServerMessage;
      try {
        message = JSON.parse(String(raw.data)) as RealtimeServerMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case "server.hello":
          break;
        case "history.ready":
          for (const event of message.events) upsert(event);
          setEvents(snapshot());
          break;
        case "execution.event":
          upsert(message.event);
          setEvents(snapshot());
          break;
        case "relay.unavailable":
          setRelayUnavailable(true);
          break;
        case "execution.completed":
          setStatus("completed");
          break;
        case "error":
          // The gateway explicitly rejected something (e.g. this hook never
          // sends anything, so in practice this only fires if a future bug
          // sends an unexpected frame) — surfaced for observability, not
          // treated as a fatal connection error.
          break;
        default:
          break;
      }
    };

    socket.onerror = () => setStatus("error");
    socket.onclose = () => setStatus((prev) => (prev === "completed" ? prev : "closed"));

    return () => {
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, executionId, active]);

  return { events, status, relayUnavailable };
}
