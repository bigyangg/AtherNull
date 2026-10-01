# ADR-0012: Operational token limits and pause/resume

Status: Implemented, pending review and verification report
Date: 2026-09-30

## Decision

After observed cumulative token usage reaches or exceeds the configured usage
limit, AtherNull pauses the execution at the next safe OpenHands step boundary.
This is a **soft, post-response operational token limit**. An in-flight response
and its step's tool calls can complete first. Observed usage is never clamped.

This feature has no monetary enforcement. Pricing remains `UNPRICED`; it does
not write payment intents, budget authorizations, rate cards, charges, or cost
fields. Existing task budget/provenance fields retain their prior meaning.

## Metric and source of truth

`TOTAL_LLM_TOKENS = input_tokens + output_tokens`, matching Phase 4D.1
`usage_events.total_tokens`. Cache and reasoning counters are not added again.

Postgres `usage_events` is the authoritative ledger. The worker's fast view is:

```
prior task usage from other attempts + current attempt accumulated tokens
```

Claim supplies the durable prior-attempt baseline. The existing stats callback
reads `accumulated_token_usage.prompt_tokens + completion_tokens` across the
stats' metrics, even when the SDK emits a lossy snapshot. It takes a monotonic
maximum, so replayed snapshots cannot double-count or reduce usage. A background
thread requests enforcement without first waiting for a usage-ingestion HTTP
round trip. Full-fidelity REST refreshes still supply the per-response records
for the existing deduplicated usage ledger. Successful ingestion also returns
the durable prior-attempt total to reconcile late usage from older attempts.

Reconciliation runs at pause, after a policy-governed `.run()` returns, and before
container teardown. A retry whose baseline already meets the limit pauses
before its first `.run()`. Extending a policy never changes consumption.

## Policy and pause records

Migration: `packages/database/migrations/0012_task_usage_policies.sql`.

`task_usage_policies` contains tenant/project/task identity, lineage, positive
version, metric, positive token limit, ACTIVE/SUPERSEDED status, superseded
policy, author, and timestamps. One ACTIVE policy is allowed per task. Extension
requires `expectedVersion`, creates a new revision, and strictly increases the
limit. Owner/admin organization authorization is required for mutations.
Historical quantities remain unchanged. Initial policy creation takes the task
lock and is refused once a RUNNING execution exists; this prevents claiming an
unenforced policy on a worker that started without one. Configure it before
activation. Existing policies can be extended while running or paused.

`task_usage_pauses` contains tenant/project/task/execution/policy identity,
metric, configured limit, real observed usage, enforcement action, resume mode,
pause/resume timestamps, and resume execution identity. Composite foreign keys
bind the policy and both execution identities to the same task; task identity
is in turn bound to its organization/project. INTERRUPT requires NEW_ATTEMPT.
One unresolved pause is allowed per execution.

Pause insertion, task transition, and `usage_limit_reached` event insertion
share one transaction. The task lock serializes concurrent delivery; replays
return the prior record. The existing execution-event persistence and broadcaster
are reused, with no second realtime channel. Payloads contain usage/control
metadata only. Publication follows commit; reconnect replay reads durable events.

## Execution semantics

The verified SDK's `.run()` returns normally for PAUSED, and potentially other
non-RUNNING states. Normal return is therefore never proof of completion.
Only a fresh `FINISHED` status allows success. Unexpected statuses fail closed.
The worker waits for any concurrent enforcement decision before interpreting
the return. An enforcement wait timeout is also a failure.

Policy-governed dispatches use the Agent Server adapter even if the worker's
fallback adapter setting is `direct`. The direct adapter also checks actual
status before declaring success. A task without a policy has no implicit limit.

Enforcement claims a local once-per-policy-crossing guard and attempts:

1. `conversation.pause()`, then freshly confirm PAUSED.
2. If that fails, `conversation.interrupt()` once, then freshly confirm a known
   non-RUNNING state. Record INTERRUPT/NEW_ATTEMPT.
3. If neither succeeds, request container cleanup and report failure with
   `USAGE_ENFORCEMENT_FAILED`. Container cleanup errors are logged; the worker
   must not claim that a failed cleanup stopped a container.

`USAGE_ENFORCEMENT_FAILED` is an execution failure reason, not a task status.
It leaves the task FAILED without the ordinary automatic retry, including on
the first attempt. A pause-persistence failure also forbids success. If its
HTTP response was lost after the server committed, the task may already be
paused; normal completion is refused, and lease-expiry recovery remains the
path forward. This is not claimed as exactly-once external side effects.

## FSM

```
RUNNING -> PAUSED_USAGE_LIMIT
PAUSED_USAGE_LIMIT -> RUNNING  (same conversation)
PAUSED_USAGE_LIMIT -> QUEUED   (new attempt)
RUNNING -> FAILED             (enforcement failure)
```

PAUSED_USAGE_LIMIT cannot enter VERIFYING. A successful pause does not invoke
normal `/complete`. The existing usage-event ledger survives every transition.

## Explicit resume

Increasing the limit and resuming are separate actions. Resume checks tenant
ownership, privileged role, paused task, open pause record, ACTIVE policy, and
a limit strictly above both durable task usage and recorded observed usage.
A task row lock makes duplicate/concurrent resume requests deterministic conflicts.

For SAME_EXECUTION, the original execution must still have a live lease and a
matching reachable worker relay. The API commits RUNNING and resolves the pause
before sending the wake-up command. The worker checks the durable
`/internal/executions/:id/usage-resume` authorization before another `.run()` and
loads the current policy ID and limit. It polls this authorization while paused,
so a dropped wake-up message does not lose the resume. The command handler never
calls `.run()` itself. A single signal arriving before the wait is retained.
The same container, conversation, execution ID, and heartbeat remain alive.

A disconnected relay with a live lease returns 409; it is not evidence of a dead
conversation and does not queue another worker. For an expired lease or an
INTERRUPT pause, resume records NEW_ATTEMPT, fences the old execution by clearing
its lease ownership, checks the existing three-attempt cap, and queues the task.
The ordinary claim path creates a new execution. An old paused worker that
receives a rejected authorization exits and cleans up its container.

## Accepted limitations

- A different worker cannot reconnect to a lost conversation: its loopback
  endpoint and session key are not durably recoverable. Recovery starts a new
  attempt, with prior usage still counted.
- Relay routing remains single-gateway-process, as in Phase 3. Durable resume
  polling recovers a lost command after authorization; it does not add
  cross-gateway relay discovery.
- A process killed while owning a container may leave an orphan container;
  cross-process container/conversation recovery is outside this phase.
- Limits are only observed after responses; in-flight work may overshoot.
- Initial policies must be configured before execution starts. There is no
  default limit and no decrease operation.
- The genuine provider verification and repeated-suite results are recorded
  separately in the implementation report, rather than inferred from mocks.

## Frontend and future pricing boundary

Task detail displays the token limit, observed usage, remaining/over-limit
quantity, and paused status. Increase Limit and Resume Build are separate.
The UI explains soft enforcement and NEW_ATTEMPT recovery. Server-side owner/
admin checks remain authoritative; members cannot increase limits.

Phase 4D.2B owns rate-card selection/versioning and deterministic pricing of
usage. It may populate the currently unpriced monetary projections only under
its own approved design. This phase adds no rates, usage charges, funding,
credits, reservations, monetary ceilings, payment rails, or general cancellation.
Operational token quantities must not be silently reinterpreted as money.
