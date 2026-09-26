// ADR-0007 Phase 3D — realtime:control support state, shared between the
// browser-facing gateway (routes/realtime-gateway.ts, which forwards
// commands and waits for an outcome) and the worker-facing relay route
// (routes/relay.ts, which resolves that outcome when the worker's ack
// arrives). Both need to agree on "which commandId is this ack for," so this
// lives in its own small module rather than inside either route file.
//
// Two related-but-distinct pieces of state, deliberately kept separate:
//
//   1. Pending-ack tracking (`registerPending` / `resolveAck`): a commandId
//      that has been forwarded to a worker and is awaiting that worker's
//      `worker.command_ack`. Exactly one resolution per commandId, ever —
//      resolving an already-resolved or unknown commandId is a silent no-op
//      (a stray/duplicate ack, or one that arrived after this gateway
//      process already gave up and reported "uncertain," must never throw
//      or double-fire a browser response).
//
//   2. At-most-once dedupe (`hasBeenForwarded` / `markForwarded`): ADR-0007's
//      own explicit v1 rule — "within one active gateway process, if a
//      commandId has already been seen, do not forward it again." This is
//      NOT durable exactly-once delivery (the ADR's own words): it is a
//      bounded, in-memory, best-effort registry that is completely lost on
//      a gateway restart. That limitation is load-bearing, not an oversight
//      — see the ADR's Phase 3D status section.
//
// Both structures are bounded (a slow/unavailable worker or a browser that
// never stops sending commandIds must never grow gateway memory without
// limit — ADR-0007's own backpressure requirement) via simple FIFO eviction
// of the oldest entry once a hard cap is hit, which is sufficient here: this
// is a liveness/memory bound, not a correctness-critical LRU.

const MAX_TRACKED_COMMAND_IDS = 5_000;
const DEFAULT_ACK_TIMEOUT_MS = 20_000;

export type CommandAckStatus = "accepted" | "rejected" | "failed";

export interface PendingCommandHandlers {
  onAck: (status: CommandAckStatus, detail?: string) => void;
  onTimeout: () => void;
}

interface PendingCommand {
  executionId: string;
  timer: ReturnType<typeof setTimeout>;
  handlers: PendingCommandHandlers;
}

class ControlRegistry {
  private readonly pending = new Map<string, PendingCommand>();
  // commandId -> executionId, insertion-ordered so the oldest entry is
  // always the next one evicted once the cap is hit.
  private readonly forwarded = new Map<string, string>();

  /**
   * Records that `commandId` (for `executionId`) has been forwarded to a
   * worker and is now awaiting that worker's `worker.command_ack`. Exactly
   * one of `handlers.onAck` / `handlers.onTimeout` fires, exactly once —
   * `onAck` if `resolveAck` is called before `timeoutMs` elapses, otherwise
   * `onTimeout`. Neither firing is this registry's own opinion about
   * "uncertain" — that mapping (timeout => uncertain) is the caller's
   * (routes/realtime-gateway.ts), since this registry only knows about the
   * three real ack outcomes.
   *
   * Returns a `cancel()` function the caller must invoke once it has
   * stopped waiting for any other reason (the browser connection itself
   * closed) so the pending-map entry and its timer are always cleaned up,
   * never leaked, and neither handler fires after cancellation.
   */
  registerPending(
    commandId: string,
    executionId: string,
    handlers: PendingCommandHandlers,
    timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
  ): { cancel: () => void } {
    const timer = setTimeout(() => {
      this.pending.delete(commandId);
      handlers.onTimeout();
    }, timeoutMs);
    // Never let a pending-ack timer keep the process alive on its own.
    if (typeof timer.unref === "function") timer.unref();

    this.pending.set(commandId, { executionId, timer, handlers });

    return {
      cancel: () => {
        const entry = this.pending.get(commandId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(commandId);
        }
      },
    };
  }

  /**
   * Resolves a pending command by commandId. A no-op (never throws) if the
   * commandId is unknown or was already resolved/timed out — a late or
   * duplicate ack from a worker must never be treated as an error.
   */
  resolveAck(commandId: string, status: CommandAckStatus, detail?: string): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.handlers.onAck(status, detail);
  }

  /** The executionId a still-pending commandId was registered under, or undefined if unknown/already resolved. Lets routes/relay.ts reject an ack whose executionId doesn't match the connection it arrived on (defense in depth, same convention as its existing envelope.executionId check). */
  getPendingExecutionId(commandId: string): string | undefined {
    return this.pending.get(commandId)?.executionId;
  }

  /** True if this exact commandId has already been forwarded once by this gateway process (ADR-0007's at-most-once rule). */
  hasBeenForwarded(commandId: string): boolean {
    return this.forwarded.has(commandId);
  }

  markForwarded(commandId: string, executionId: string): void {
    if (this.forwarded.has(commandId)) return;
    if (this.forwarded.size >= MAX_TRACKED_COMMAND_IDS) {
      const oldest = this.forwarded.keys().next().value;
      if (oldest !== undefined) this.forwarded.delete(oldest);
    }
    this.forwarded.set(commandId, executionId);
  }

  /**
   * ADR-0007 Phase 3D — called when the worker relay for `executionId` goes
   * away for any reason (disconnect, lease-expired reclaim, execution
   * completion) BEFORE a command's ack timeout would otherwise fire. Every
   * command still pending for that execution is resolved as `onTimeout`
   * (the same "uncertain" path a real ack timeout takes) immediately,
   * rather than making the browser wait out the full ack-timeout window for
   * a connection that is already known to be gone — this is exactly
   * scenario 2 in the ADR's "uncertain delivery" walkthrough ("gateway
   * forwards to worker but worker disconnects before acknowledgement").
   */
  abortAllForExecution(executionId: string): void {
    for (const [commandId, entry] of this.pending) {
      if (entry.executionId !== executionId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(commandId);
      entry.handlers.onTimeout();
    }
  }

  /** Test/observability only. */
  get pendingSize(): number {
    return this.pending.size;
  }
}

export const controlRegistry = new ControlRegistry();
