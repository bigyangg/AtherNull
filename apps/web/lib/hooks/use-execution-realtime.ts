"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  REALTIME_BROWSER_PROTOCOL_VERSION,
  type CommandStatusValue,
  type RealtimeExecutionEvent,
  type RealtimeServerMessage,
} from "@athernull/contracts";

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
// ADR-0007 Phase 3D adds realtime:control on top, strictly additively:
// `canControl` reflects the gateway's own server.hello decision (never
// computed client-side — see docs/adr/0007-secure-realtime-execution.md's
// Phase 3D status section, "do not let the frontend decide whether someone
// has control permission"), and `sendCommand` submits exactly one allowed
// command type (agent.message in this phase). This hook never automatically
// retries a command and never guesses at an outcome the gateway hasn't
// reported — an uncertain command stays visibly "uncertain" (see
// `commandStatuses` below) until the user explicitly acknowledges it or a
// later, unrelated event supersedes the display.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type RealtimeConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "relay-unavailable"
  | "completed"
  | "error"
  | "closed";

// One command's last-known status, as reported by the gateway — never
// inferred or upgraded client-side. `uncertain` and `failed` are rendered
// distinctly by the caller (see live-conversation-panel.tsx); this hook
// itself makes no judgment about what a status means.
export interface CommandStatusEntry {
  commandId: string;
  status: CommandStatusValue;
  reason?: string;
}

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
  // ADR-0007 Phase 3D — whether THIS connection currently holds
  // realtime:control, per the gateway's own server.hello. Never computed
  // client-side.
  canControl: boolean;
  // Every command this hook has submitted, keyed by commandId, with its
  // latest known status. Never cleared automatically — a command that goes
  // "uncertain" stays visible until the tab is reloaded/reconnects, per
  // ADR-0007's explicit "never silently resend, never silently forget"
  // instruction.
  commandStatuses: CommandStatusEntry[];
  // Submits one agent.message command with a fresh, unique commandId.
  // Never retries automatically — calling this again for the same logical
  // message after an "uncertain" outcome is a new, explicit user action
  // (a brand-new commandId), never this hook's own decision.
  sendMessage: (text: string) => void;
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
  const [canControl, setCanControl] = useState(false);
  const [commandStatuses, setCommandStatuses] = useState<CommandStatusEntry[]>([]);
  // Keyed by event id — the sole dedup identity this protocol defines — so a
  // re-delivered id (safe by design, per ADR-0007's stated invariant) is
  // merged in place rather than appended as a duplicate row.
  const eventsById = useRef<Map<string, RealtimeExecutionEvent>>(new Map());
  const commandStatusesById = useRef<Map<string, CommandStatusEntry>>(new Map());
  const socketRef = useRef<WebSocket | null>(null);
  const executionIdRef = useRef<string | undefined>(executionId);
  executionIdRef.current = executionId;

  useEffect(() => {
    if (!active || !executionId) {
      setStatus("idle");
      return;
    }

    eventsById.current = new Map();
    commandStatusesById.current = new Map();
    setEvents(null);
    setRelayUnavailable(false);
    setCanControl(false);
    setCommandStatuses([]);
    setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(realtimeWebSocketUrl(taskId, executionId));
      socketRef.current = socket;
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

    function commandSnapshot(): CommandStatusEntry[] {
      return [...commandStatusesById.current.values()];
    }

    function upsertCommandStatus(entry: CommandStatusEntry) {
      commandStatusesById.current.set(entry.commandId, entry);
      setCommandStatuses(commandSnapshot());
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
          // ADR-0007 Phase 3D: the gateway's own authorization decision,
          // never computed here — this hook only reflects it.
          setCanControl(message.canControl);
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
        case "command.status":
          // Never inferred, never auto-retried — this hook only relays
          // exactly what the gateway reported, including "uncertain".
          upsertCommandStatus({ commandId: message.commandId, status: message.status, reason: message.reason });
          break;
        case "error":
          // The gateway explicitly rejected something — surfaced for
          // observability, not treated as a fatal connection error. A
          // malformed/unrecognized command this hook itself sent (a bug,
          // since sendMessage below always builds a valid envelope) would
          // also land here rather than as a command.status, since the
          // gateway can't attribute it to a specific commandId in that case.
          break;
        default:
          break;
      }
    };

    socket.onerror = () => setStatus("error");
    socket.onclose = () => setStatus((prev) => (prev === "completed" ? prev : "closed"));

    return () => {
      socketRef.current = null;
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, executionId, active]);

  // ADR-0007 Phase 3D: submits one agent.message command. A fresh,
  // client-generated commandId is minted per call — this is the command's
  // OWN identity (never an OpenHands event id, never reused across calls).
  // No retry logic exists here or anywhere else in this hook: if the
  // gateway reports "uncertain", the only way to try again is a brand-new
  // call to this function (a new, explicit user action), never an automatic
  // resend of the same commandId.
  const sendMessage = useCallback((text: string) => {
    const socket = socketRef.current;
    const currentExecutionId = executionIdRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !currentExecutionId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const commandId = crypto.randomUUID();
    socket.send(
      JSON.stringify({
        version: REALTIME_BROWSER_PROTOCOL_VERSION,
        type: "execution.command",
        commandId,
        executionId: currentExecutionId,
        command: { type: "agent.message", payload: { text: trimmed } },
      }),
    );
  }, []);

  return { events, status, relayUnavailable, canControl, commandStatuses, sendMessage };
}
