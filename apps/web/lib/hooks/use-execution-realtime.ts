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
//
// ADR-0007 Phase 3E adds bounded browser reconnect on top of the above,
// strictly additively — the wire protocol (packages/contracts/
// realtime-browser.ts) is completely unchanged. Design, matching the ADR's
// own stated invariants (docs/adr/0007-secure-realtime-execution.md, Phase
// 3E status section):
//   - On an unexpected socket close (anything other than a server-driven
//     `execution.completed`, or this hook's own effect cleanup on
//     unmount/executionId change), a NEW WebSocket is opened to the exact
//     same URL after a bounded exponential backoff with jitter — never a
//     tight reconnect loop. The gateway itself re-validates session, Origin,
//     org membership and realtime:view from scratch on every single new
//     connection attempt (routes/realtime-gateway.ts's preValidation) — this
//     hook restores NOTHING from the old socket; a reconnect is, from the
//     gateway's point of view, indistinguishable from a brand-new tab
//     opening the same URL.
//   - `eventsById`/`commandStatusesById` (this hook's own client-side caches)
//     are NOT reset on a reconnect — only on a genuine new subscription
//     (mount, or `taskId`/`executionId` changing). This is what makes
//     reconnection lossless without duplicating anything: the gateway always
//     replays the FULL persisted history on every new connection
//     (`history.ready`), and `upsert()` is a plain Map.set() keyed by the
//     event's own uuid — replaying the same id twice is a no-op overwrite,
//     never a second rendered row (invariant: "reconnect does not duplicate
//     rendered events").
//   - Any command status that was still non-terminal (received/authorized/
//     forwarded/accepted — i.e. NOT executed/failed/rejected/uncertain) at
//     the moment the socket closed is force-transitioned to `uncertain`
//     (reason `connection_lost`) right then, before any reconnect is even
//     attempted. This is a client-side application of the same "never
//     fabricate certainty" rule the gateway itself already follows
//     (control-registry.ts's own ack-timeout handling): once the connection
//     that was going to tell us the real outcome is gone, the gateway
//     process on the other end may not even still exist (e.g. it just
//     restarted) to ever resolve that command — continuing to display
//     "forwarded" forever would be a false, stale certainty, not an honest
//     "we don't know."
//   - Reconnect attempts stop (this hook simply lets the socket stay closed)
//     once: the execution has already reached `execution.completed` (no
//     reason to keep trying — the historical/polled view is the correct
//     source from then on), the caller's own `active` flag goes false
//     (RealWorkspaceView flips this the moment its own task/execution poll
//     observes a non-RUNNING status — this is the real backstop for "don't
//     reconnect forever against a finished execution" described in the ADR,
//     since a closed WebSocket carries no HTTP status code this hook could
//     otherwise inspect to tell "rejected because finished" apart from
//     "transient network blip"), the effect is cleaned up (unmount /
//     `taskId`/`executionId` change), or a bounded maximum attempt count is
//     reached.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// ADR-0007 Phase 3E bounded-reconnect policy (mirrors the worker relay's own
// policy in workers/coding-agent/src/coding_agent/relay_client.py, though
// the two are independent implementations — a browser tab and a worker
// process reconnect to entirely different gateway routes and have no shared
// state). Full jitter, exponential backoff, hard attempt cap: never a tight
// loop, never unbounded.
const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

const TERMINAL_COMMAND_STATUSES = new Set<CommandStatusValue>(["executed", "failed", "rejected", "uncertain"]);

export type RealtimeConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
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

    // Fresh subscription (mount, or taskId/executionId actually changed —
    // e.g. a retried task attempt got a new execution) — this is the ONLY
    // place these caches are reset. A reconnect within the same subscription
    // (below) deliberately does NOT touch them, per this file's own Phase 3E
    // header comment: the gateway replays full history on every connection,
    // and re-delivering an already-known event id is a harmless no-op
    // upsert, never a duplicate.
    eventsById.current = new Map();
    commandStatusesById.current = new Map();
    setEvents(null);
    setRelayUnavailable(false);
    setCanControl(false);
    setCommandStatuses([]);

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // Latched true only by a real server-driven execution.completed message
    // (never inferred from a socket closing/erroring) — once true, this
    // subscription never attempts to reconnect again. ADR-0007's own
    // invariant: the browser must never decide an execution is finished;
    // this flag only ever gets set from that one authoritative signal.
    let completed = false;

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

    // ADR-0007 Phase 3E: once the connection that could have told us a
    // command's real outcome is gone, this gateway process may not even
    // still exist to ever answer (e.g. it just restarted) — leaving a
    // non-terminal status (received/authorized/forwarded/accepted) displayed
    // would be a false, stale certainty. Force it to the same honest
    // "uncertain" the gateway itself already uses for an unresolved ack
    // timeout — never a silent forget, never a fabricated success/failure.
    function markInFlightCommandsUncertain(reason: string) {
      let changed = false;
      for (const [commandId, entry] of commandStatusesById.current) {
        if (!TERMINAL_COMMAND_STATUSES.has(entry.status)) {
          commandStatusesById.current.set(commandId, { commandId, status: "uncertain", reason });
          changed = true;
        }
      }
      if (changed) setCommandStatuses(commandSnapshot());
    }

    function scheduleReconnect() {
      if (cancelled || completed) return;
      attempt += 1;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        // Bounded, not infinite. The caller's own task/execution poll
        // (RealWorkspaceView) is the real backstop from here — once it
        // observes the execution is no longer RUNNING, `active` goes false
        // and this whole effect tears down; if the execution is genuinely
        // still RUNNING and the gateway is just unreachable for longer than
        // this budget, the historical/polled event view remains available
        // regardless (this hook's `events` simply stays whatever it last
        // was, per its own "coexist, don't replace" contract with the
        // polling fallback).
        setStatus("error");
        return;
      }
      const backoffCap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      const backoff = Math.random() * backoffCap; // full jitter, same policy as the worker relay's own reconnect
      setStatus("reconnecting");
      reconnectTimer = setTimeout(connect, backoff);
    }

    function connect(): void {
      if (cancelled || completed) return;

      let socket: WebSocket;
      try {
        socket = new WebSocket(realtimeWebSocketUrl(taskId, executionId!));
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      // A fresh connection attempt — reset per-connection (not per-
      // subscription) flags. `relayUnavailable`/`canControl` are the
      // gateway's OWN fresh decision on every new socket (never restored
      // from a previous one, matching ADR-0007's "never restore previous
      // privileges just because the old socket had them"); a reconnect that
      // succeeds gets a brand-new `server.hello`/possible
      // `relay.unavailable` message reflecting current server-side state.
      setRelayUnavailable(false);
      setCanControl(false);
      setStatus(attempt === 0 ? "connecting" : "reconnecting");

      socket.onopen = () => {
        attempt = 0; // a real successful connection resets the backoff budget
        setStatus("open");
      };

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
            // never computed here — this hook only reflects it. Rechecked
            // fresh on every reconnect, same as connect-time.
            setCanControl(message.canControl);
            break;
          case "history.ready":
            // ADR-0007 Phase 3E: this is exactly the reconciliation a
            // reconnect relies on — the gateway always sends the FULL
            // current persisted history on every new connection, so any
            // event produced while this tab was disconnected is delivered
            // here, deduped by id against whatever this hook already had.
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
            completed = true;
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
            // gateway can't attribute it to a specific commandId in that
            // case.
            break;
          default:
            break;
        }
      };

      socket.onerror = () => {
        // Deliberately not a terminal state here — a browser always follows
        // a failed-connection error with a close event, and `onclose` below
        // is the single place that decides completed/reconnect/give-up, so
        // the decision isn't split across two handlers that could disagree.
      };

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (cancelled) return;
        if (completed) {
          setStatus("completed");
          return;
        }
        // ADR-0007 Phase 3E: socket loss does not mean the execution
        // finished — never inferred here. Only ever a reason to try to
        // reconnect (bounded) while treating any command this connection
        // was still tracking as uncertain from this moment forward.
        markInFlightCommandsUncertain("connection_lost");
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
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
