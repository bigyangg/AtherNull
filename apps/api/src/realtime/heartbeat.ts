import type { WebSocket } from "ws";

// ADR-0007 Phase 3E — bounded application-level ping/pong liveness for both
// realtime sockets this codebase owns: the worker<->gateway relay
// (routes/relay.ts) and the browser<->gateway view/control connection
// (routes/realtime-gateway.ts).
//
// Why this is needed (Step 12's own audit finding): neither `ws` (the Node
// server side) nor Python's `websockets.sync.client` (the worker side) sends
// periodic pings on its own. Both respond automatically to a ping the OTHER
// side initiates (that part of the WebSocket protocol is handled
// transparently by both libraries — confirmed by reading `ws`'s own
// `receiver.js`/`websocket.js` and, on the Python side, `websockets`'
// protocol-level auto-pong, neither of which this file needs to reimplement).
// But nothing in this codebase was periodically INITIATING a ping before this
// phase — so a half-open TCP connection (peer's process died, or a network
// path silently stopped delivering in one direction without an RST/FIN ever
// arriving) could sit registered as "connected" for a very long time (bounded
// only by OS-level TCP keepalive, which is typically hours, not the
// seconds-to-minutes this system actually needs to detect a dead relay or a
// dead browser tab). This file is the fix: the GATEWAY (the one place both
// socket types terminate) periodically pings; a peer that fails to pong
// within the timeout is presumed dead and its socket is terminated, which
// drives the exact same `close` handlers relay.ts/realtime-gateway.ts already
// have (unregister the relay / clean up the browser subscription) — no new
// cleanup path, just a faster, bounded trigger for the existing one.
//
// This is observability/liveness only, never a correctness signal: execution
// status in Postgres remains authoritative always (ADR-0007's own repeated
// invariant) — a terminated socket here only ever causes the SAME in-memory
// cleanup an ordinary disconnect already causes, never a database write.

const DEFAULT_PING_INTERVAL_MS = 30_000;

export interface HeartbeatHandle {
  /** Stops the ping interval. Must be called from the socket's own `close`
   * handler so a dead/replaced connection's timer is never left running. */
  stop: () => void;
}

/**
 * Attaches bounded ping/pong liveness to `socket`. Every `intervalMs`, if the
 * socket did not answer the PREVIOUS ping with a pong, it is presumed dead
 * and terminated (`socket.terminate()` — an abrupt close, not a graceful
 * handshake, matching what a genuinely dead peer looks like); otherwise a new
 * ping is sent and the cycle repeats. The very first interval tick is always
 * given one full grace period before the first liveness check fires, so a
 * connection that has simply not had a chance to pong yet is never
 * penalized.
 */
export function attachHeartbeat(socket: WebSocket, intervalMs: number = DEFAULT_PING_INTERVAL_MS): HeartbeatHandle {
  let isAlive = true;

  socket.on("pong", () => {
    isAlive = true;
  });

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!isAlive) {
      try {
        socket.terminate();
      } catch {
        // Best-effort — the socket may already be closing/closed.
      }
      return;
    }
    isAlive = false;
    try {
      socket.ping();
    } catch {
      // Best-effort — a ping that fails to send means the socket is already
      // on its way out; the next interval tick's `!isAlive` branch above
      // will terminate it.
    }
  }, intervalMs);
  // Never let a heartbeat timer keep the process alive on its own (mirrors
  // control-registry.ts's own unref() convention for its ack timers).
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
