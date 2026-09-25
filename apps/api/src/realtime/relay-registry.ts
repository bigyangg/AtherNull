import type { WebSocket } from "ws";

export interface RelayConnection {
  executionId: string;
  workerId: string;
  socket: WebSocket;
  registeredAt: Date;
}

type CloseReason =
  | "replaced-by-new-registration"
  | "execution-completed"
  | "lease-expired"
  | "gateway-shutdown";

// WebSocket close codes in the private-use range (4000-4999, RFC 6455 §7.4.2)
// so a worker's relay client can distinguish "you were replaced" from an
// ordinary network drop if it ever wants to (Phase 3B doesn't act on this
// itself, but the information is there for later phases).
const CLOSE_CODE_REPLACED = 4000;
const CLOSE_CODE_SERVER_CLOSED = 4001;

/**
 * In-memory registry: executionId -> the single active worker relay
 * connection for it (ADR-0007 Phase 3B).
 *
 * Single-gateway-instance assumption (v1, as implemented — not just
 * theorized in the ADR): this map lives in exactly one apps/api process's
 * memory. It assumes one gateway instance, or deterministic connection
 * affinity, in front of it — nothing here provides cross-instance routing.
 * If apps/api is ever horizontally scaled without sticky/affinity routing,
 * a worker's relay registration on instance A is simply invisible to
 * instance B (no shared pub/sub exists). Not solved here, per ADR-0007's
 * own recorded scaling caveat — Phase 3B does not change that boundary.
 *
 * Replacement policy (explicit, not incidental): a second successful
 * registration for an executionId REPLACES the previous connection (closing
 * it) rather than being rejected. This is safe because only the execution's
 * actual current lease_owner can ever pass registration (verified by the
 * caller against `executions.lease_owner`/`status` before register() is
 * invoked) — and lease_owner is immutable for a given execution row's
 * lifetime (apps/api/src/routes/internal.ts never UPDATEs lease_owner; a
 * retry after lease expiry always gets a brand-new execution row with its
 * own id, never reuses the old one). So a second registration for the same
 * executionId can only be the SAME worker reconnecting (e.g. after a
 * network blip) — its old socket is presumptively stale, and replacing it
 * (rather than leaving two sockets that could both believe they're the
 * active relay) is what keeps "only one active relay per execution" true at
 * all times, which is the property that actually matters here.
 */
export class RelayRegistry {
  private readonly connections = new Map<string, RelayConnection>();

  register(conn: RelayConnection): void {
    const existing = this.connections.get(conn.executionId);
    if (existing && existing.socket !== conn.socket) {
      this.closeSocket(existing.socket, CLOSE_CODE_REPLACED, "replaced-by-new-registration");
    }
    this.connections.set(conn.executionId, conn);
  }

  get(executionId: string): RelayConnection | undefined {
    return this.connections.get(executionId);
  }

  /**
   * Removes the registration for executionId, but only if `socket` is still
   * the one currently registered — guards against a stale close/error
   * handler firing (possibly late, after the underlying TCP connection was
   * already torn down) for a connection that a newer registration already
   * replaced, which must never be allowed to delete the newer one.
   */
  unregister(executionId: string, socket: WebSocket): void {
    const existing = this.connections.get(executionId);
    if (existing && existing.socket === socket) {
      this.connections.delete(executionId);
    }
  }

  /**
   * Closes and removes whatever relay is currently registered for
   * executionId, if any. Used when apps/api itself learns, from its own
   * authoritative state, that the relay should no longer exist:
   *   - "execution-completed": POST /internal/executions/:id/complete ran.
   *   - "lease-expired": the claim handler reclaimed this execution's task
   *     for a fresh attempt (a new execution row), so this execution id's
   *     relay (if a zombie worker somehow still holds it open) is no longer
   *     current. See docs/adr/0007-secure-realtime-execution.md's Phase 3B
   *     status section for the exact race this narrows but does not fully
   *     close (periodic re-validation is deferred, not silently dropped).
   */
  closeAndRemove(executionId: string, reason: CloseReason): void {
    const existing = this.connections.get(executionId);
    if (!existing) return;
    this.connections.delete(executionId);
    this.closeSocket(existing.socket, CLOSE_CODE_SERVER_CLOSED, reason);
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Best-effort — the socket may already be closed/closing.
    }
  }

  get size(): number {
    return this.connections.size;
  }
}

// Process-wide singleton — see the class doc's single-gateway-instance
// assumption for exactly what this does and doesn't cover.
export const relayRegistry = new RelayRegistry();
