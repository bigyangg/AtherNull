import { EventEmitter } from "node:events";

// ADR-0007 Phase 3C — the fan-out point this phase adds. Neither Phase 3B's
// relay.ts nor internal.ts had any way to notify a second, independent
// consumer (a browser gateway connection) that a new execution_events row
// just landed, or that an execution just completed — the ADR's own grounding
// audit says this explicitly ("nothing today re-emits that live event to
// anyone else"). This is new plumbing, not an extension of something that
// half-existed.
//
// Design choice (documented, not the only valid one): a single in-process
// EventEmitter, keyed by executionId via the event-name string, rather than
// (a) the browser gateway polling relayRegistry directly — polling would add
// latency and CPU for no benefit when a push-based signal is trivial here —
// or (b) a full pub/sub broker (Redis, etc.) — unnecessary complexity given
// ADR-0007's own explicit single-gateway-instance assumption (§4b of the
// design doc): relay-registry.ts already lives as one process-local Map for
// exactly this same reason, so a second in-process mechanism is consistent,
// not a new architectural boundary. If apps/api is ever horizontally scaled
// without sticky routing, this in-process broadcaster has the identical
// cross-instance blind spot relay-registry.ts already has and already
// documents — not a new gap introduced here.
//
// Two publish call sites (both intentional, not just the one the ADR names):
//   1. routes/relay.ts's handleRelayMessage, after a relay-forwarded
//      execution.event is persisted (the ADR's own required fan-out point).
//   2. routes/internal.ts's POST /internal/executions/:id/events, after the
//      *authoritative* HTTP batch-ingestion path persists events — added so
//      a browser still gets live pushes for events that arrive via that path
//      even when no relay is registered at all (worker running in
//      EXECUTION_ADAPTER=direct mode, or the relay having dropped). Both
//      call sites go through the same persistExecutionEvents() dedupe, and
//      the browser gateway itself dedupes by event id again — publishing the
//      same eventId from both paths is always safe (invariant 2).
// One publish-completion call site: routes/internal.ts's
// POST /internal/executions/:id/complete, the single authoritative place a
// task/execution status transitions off RUNNING (§1.8 of the design doc) —
// mirrors the exact signal relayRegistry.closeAndRemove(id,
// "execution-completed") already reacts to for the worker-relay leg.
export interface BroadcastExecutionEvent {
  id: string;
  kind: string;
  occurredAt: string;
  payload: unknown;
}

export type ExecutionCompletionOutcome = "success" | "failure";

class ExecutionBroadcaster {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many concurrent executions each with their own event name on this one
    // emitter is expected, ordinary usage, not a leak — raise the default
    // 10-listener warning ceiling accordingly.
    this.emitter.setMaxListeners(0);
  }

  publishEvent(executionId: string, event: BroadcastExecutionEvent): void {
    this.emitter.emit(eventChannel(executionId), event);
  }

  publishCompletion(executionId: string, outcome: ExecutionCompletionOutcome): void {
    this.emitter.emit(completionChannel(executionId), outcome);
  }

  /** Returns an unsubscribe function — callers must invoke it on socket close to avoid leaking listeners across the process's lifetime. */
  onEvent(executionId: string, listener: (event: BroadcastExecutionEvent) => void): () => void {
    const channel = eventChannel(executionId);
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  onCompletion(executionId: string, listener: (outcome: ExecutionCompletionOutcome) => void): () => void {
    const channel = completionChannel(executionId);
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}

function eventChannel(executionId: string): string {
  return `event:${executionId}`;
}

function completionChannel(executionId: string): string {
  return `completed:${executionId}`;
}

// Process-wide singleton, same lifetime/scope assumption as relayRegistry.
export const executionBroadcaster = new ExecutionBroadcaster();
