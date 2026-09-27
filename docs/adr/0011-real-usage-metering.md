# ADR-0011: Real usage metering foundation (Phase 4D.1)

Status: Accepted
Date: 2026-09-28

## Context

ADR-0010 (Phase 4C) closed the provenance/activation gap: a task can no
longer reach `QUEUED` without an exact `APPROVED` estimate and a `CONSUMED`
budget authorization behind it. That answers "was this build authorized?" —
it says nothing about "what did it actually consume?" A prior Phase 4D audit
(not itself an implementation phase) established the honest starting point:

- `usage_events` has existed since the very first migration
  (`0002_platform_tables.sql`) but has had **zero writers anywhere in the
  codebase** — confirmed by repeated full-repo grep across this ADR's own
  audit passes. Its two readers (`/usage`, `jobs.ts`'s `budgetSpentMinor`)
  have therefore always computed a permanent `0`.
- NVIDIA NIM (this deployment's real provider) returns a standard
  OpenAI-compatible `usage` object on every completion, and the OpenHands
  SDK's `Telemetry._record_usage` reliably extracts real per-call token
  counts from it. **Monetary cost does not have the same reliability**:
  LiteLLM's own price table has zero chat-model entries under the
  `nvidia_nim/` prefix this deployment actually routes to (verified by
  loading and inspecting `model_prices_and_context_window_backup.json`
  directly) — the SDK's own cost calculator honestly returns `None` on that
  gap rather than fabricating a number.
- No rate card exists (`apps/api/src/pricing/rates.ts`'s `RATE_CONFIG` is
  `null`).

Phase 4D.1's scope, deliberately narrow: make AtherNull able to truthfully
answer "what measurable resources did this execution actually consume?"
using the one genuinely reliable signal (LLM token usage), without ever
converting a token count into a fabricated dollar amount. Pricing, funding,
credits, reservations, and any runtime spend enforcement are explicitly out
of scope — separate, later phases.

### The critical event-path finding

Two independent transmission paths already existed for usage-shaped data,
with very different fidelity:

1. A `ConversationStateUpdateEvent(key="stats")` fires after **every** LLM
   response and already reaches the worker's `EventForwarder` today — but
   its own field validator (`openhands/sdk/event/conversation_state.py`)
   unconditionally forces `ConversationStats.model_dump(...,
   context={"use_snapshot": True})` whenever the value is a
   `ConversationStats` instance (confirmed by reading the installed SDK
   source directly). This makes the reliable per-response trigger **always**
   carry a lossy cumulative snapshot with a stale `response_id` — never
   genuine per-call data.
2. `RemoteConversation.stats` — a real REST call
   (`GET {conversation_info_base_path}/{id}`) the worker never invoked
   before this phase — does **not** pass a snapshot context server-side, so
   actively polling it returns the full, genuine per-call `TokenUsage` list
   with real, distinct `response_id`s. A naive in-process read of the
   SDK's own cached `.stats` was also verified to be unsafe: the same lossy
   snapshot overwrites that cache on the identical trigger, so the
   implementation calls `conversation.state.refresh_from_server()`
   specifically to bypass the cache and force a real network round trip.

This is why Phase 4D.1 required new worker-side wiring, not merely a new
extraction step on the `apps/api` side.

## Decision

### Extraction mechanism

A new `UsageForwarder` `Conversation` callback in
`workers/coding-agent/src/coding_agent/agent_server_adapter.py`, alongside
the existing `EventForwarder`/`RelayEventCallback`. The stats-update event
is used **only as a trigger** — its own payload is never read as usage
truth. On trigger, a dedicated background thread calls
`conversation.state.refresh_from_server()` and extracts genuine per-response
`TokenUsage` entries, each keyed by its real `response_id`. A **final poll
is performed synchronously in the dispatch's `finally` block**, before
worker teardown — proven necessary in real-execution verification, where the
very last response's usage was only captured by this explicit final call,
not by any earlier trigger.

### Worker payload

`POST /internal/executions/:id/usage` carries only raw evidence: execution
identity, `providerRequestId` (the real `response_id`), `provider`, `model`
(both persisted verbatim — no rate-card normalization, that is entirely
Phase 4D.2's job), the raw token categories, and an `observedAt` timestamp.
**No monetary field exists on this wire shape at all** — not even `null`.
`task_id`/`project_id`/`organization_id` are never sent by the worker;
`apps/api`'s ingestion handler (`apps/api/src/usage-events.ts`) derives them
itself from the trusted, already-persisted
`execution_id -> task_id -> project_id/organization_id` chain.

### Schema (`packages/database/migrations/0011_usage_metering.sql`)

Confirmed `usage_events` genuinely empty (`select count(*)` returned `0` on
both `athernull_dev` and `athernull_test`) immediately before migrating, so
the destructive parts (dropping the old single `tokens` column, making
`cost_minor` nullable) are pure schema changes with nothing to lose. Added:
`task_id`/`project_id`/`organization_id` (DB-enforced via
`usage_events_execution_task_fkey` and `usage_events_task_project_org_fkey`,
chained through `executions` and `tasks`, mirroring the exact composite-FK
tenant-integrity pattern established in Phase 4A/4B/4C — precedent for this
denormalization already existed even before Phase 4A, in the `artifacts`
table); `provider`; raw per-category token columns
(`input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`/
`reasoning_tokens`/`total_tokens`, the last derived server-side as
`input_tokens + output_tokens` — cache and reasoning tokens are documented
sub-categories already counted inside those two, never double-counted);
`observed_at` (when AtherNull's worker first observed the usage — no
genuine provider-side completion timestamp survives into `TokenUsage`, so
naming it `occurred_at` would overclaim precision that doesn't exist) plus
a renamed `recorded_at` (DB-insert time, mirroring `execution_events`'
existing split); and `pricing_status`/`currency`/`rate_version`, with a
completeness check making a "half-priced" row impossible by construction
(same pattern as `tasks_provenance_paired` in migration 0010). One
correction made along the way: 0010's `tasks_project_id_organization_id_unique`
is, despite its name, a **foreign key**, not a unique constraint — this
migration adds the actual missing `tasks(id, project_id, organization_id)`
unique constraint the new composite FK needed.

### Dedupe

`(execution_id, provider_request_id)`, enforced by Postgres (the
pre-existing unique constraint from migration 0002, unchanged) plus
`ON CONFLICT ... DO NOTHING`. A worker-side seen-IDs set exists **only** as
a network-call optimization; correctness never depends on worker memory —
proven directly against real data during verification (replaying the exact
same 4 real usage rows via an independent `curl` call, with no worker
process involved at all, left the row count unchanged at 4).

### Pricing truth

Every row this phase writes: `pricing_status = 'UNPRICED'`,
`cost_minor = currency = rate_version = NULL`. LiteLLM's `None` is never
treated as `0`. No same-named model's price data from a different provider
prefix (e.g. `nebius/nvidia/nemotron-...`) is ever substituted for an
`nvidia_nim/` model — structurally impossible here, since `provider` is
stored verbatim and this phase contains no pricing logic of any kind to
perform such a substitution.

### `budgetSpentMinor` — corrected to never lie

`jobs.ts`'s task-detail response: `budgetSpentMinor` is `null` the instant
**any** `usage_events` row exists with `pricing_status = 'UNPRICED'` (true
for every row this phase ever writes) — remaining a genuine `0` only when
zero usage rows exist at all for the task's executions (nothing has run,
so nothing could have cost anything). A monetary unknown is never rendered
as a calculated zero. Sibling `usage: {inputTokens, outputTokens, ...}` and
`pricing: {status, amountMinor: null, currency: null}` fields were added
additively to both the task-detail response and `/usage/summary`, summed
across **all** executions under a task (preserving the existing behavior
that a retried attempt's usage adds to the task total rather than resetting
it). `apps/web`'s `BudgetMeter` renders "Cost — Not priced yet" instead of a
numeric meter when the spent amount is `null`.

### Test-fixture isolation correction

`usage-metering.test.ts`'s own fixture helper initially called the real
`POST /v1/jobs/:id/fund` to get a task into a fundable state — this drove up
to 15 tasks per run to genuine `QUEUED`, exposed to the shared global
`POST /internal/executions/claim` queue every other test file's own
claim-endpoint tests draw from. This was a real, deterministic contamination
bug (reproduced 3/3 with the file present, clean 100% of the time without
it) — not the same class as the pre-existing, previously-disclosed
shared-claim-queue sensitivity this engagement has repeatedly documented,
though it manifested through the identical mechanism. Fixed by removing the
real `/fund` call entirely (nothing in this file asserts on `/fund`'s own
behavior) in favor of a direct status update that never touches real
`QUEUED` at all — mirroring the fixture-isolation convention already
established in Phase 3C.5. Post-fix, across an 18-run sample, 17 were clean
and 1 showed the same intermittent, non-deterministic shared-queue-style
signature this engagement has disclosed before (vs. 7/7 clean in an
equally-sized control run without this file) — the deterministic failure
pattern this fix targeted has not recurred.

## Consequences

**Makes easier**: an honest, auditable, per-execution, per-token-category
usage trail that Phase 4D.2's pricing engine can read directly (`provider`/
`model` verbatim, all five raw token categories, `pricing_status` already
in place for a future pass to flip to `PRICED` once a real rate card
exists); the `/usage` dashboard and task-detail views stop silently implying
a working cost meter that has never actually existed.

**Makes harder / open items**: `budgetSpentMinor` will continue returning
`null` (not a number) for the foreseeable future, until Phase 4D.2 actually
prices something — any UI/consumer that assumed a numeric value needs to
handle `null` explicitly (done for `BudgetMeter` in this phase; other
consumers should be audited before Phase 4D.2). No runtime spend
enforcement of any kind exists after this phase — `Conversation.pause()`/
`.interrupt()` remain real, unused REST primitives. The residual,
non-deterministic shared-claim-queue-style test flakiness (distinct from
the deterministic bug this phase fixed) remains an open, previously-known
condition of this test suite, not resolved by this phase.

## Phase 4D.2 boundary

Phase 4D.2 owns: building a real rate card (`apps/api/src/pricing/rates.ts`),
a pricing engine that reads `usage_events` rows still marked `UNPRICED` and
fills in `cost_minor`/`currency`/`rate_version` together (never partially —
the completeness constraint already enforces this), and only then does
`budgetSpentMinor`/`/usage`'s total-spend figures start reflecting anything
real. It must not substitute another provider's price data for an
`nvidia_nim/` model. Runtime enforcement (pause/interrupt on budget
exhaustion) is a separate, later phase again, building on the
`Conversation.pause()`/`.interrupt()` primitives confirmed to exist but
remain unused throughout Phase 3 and Phase 4.
