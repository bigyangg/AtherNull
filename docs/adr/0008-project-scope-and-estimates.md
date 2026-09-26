# ADR-0008: Project scope, build plan and cost estimate (Phase 4A)

Status: Accepted
Date: 2026-09-27

## Context

AtherNull is moving from "an AI coding interface" to a structured product
flow: user intent -> scope -> build plan -> estimate -> user approval ->
authorized budget -> build -> verify -> review -> deploy -> settle. This ADR
covers only the first slice: **intent -> scope -> build plan -> estimate ->
user approval of scope.** Funding, settlement, Solana, and actual task/
execution creation from an approved estimate are explicitly out of scope —
that bridge is "Phase 4B: Authorized Project Budget," proposed but not
built here.

### What this session confirmed, by reading real source (not assumed)

- **No planning/estimation machinery existed before this phase.** The only
  prior art was `POST /v1/jobs/estimate` (`apps/api/src/routes/jobs.ts`), a
  read-only routing-tier preview (tier/model/score, `costCeilingMinor`
  always `null`) with no persistence, no scope, no plan, no dollar range.
  It is untouched by this phase and remains what it was.
- **No real pricing/rate data exists anywhere in this codebase.** The only
  dollar-shaped concept, `ModelTierSchema.costCeilingMinor`, is a per-tier
  spend *ceiling* used by `packages/model-router`'s `chooseTier()` for
  routing affordability at dispatch time — not a rate card. Every estimate
  this phase produces is honestly `UNPRICED` until real rate configuration
  is supplied.
- **Task creation already conflates "define the task" with "ready to
  fund."** `POST /v1/jobs` calls `assertTransition("CREATED",
  "AWAITING_FUNDING")` and inserts the row already at `AWAITING_FUNDING`;
  `CREATED` never actually rests as a stored status. It also requires
  `agentProfileId`/`budgetMinor`/`repositoryRevision` up front — inputs a
  planner does not produce. Forcing a task row to exist before scoping is
  finished would mean inventing a fake task just to hang a draft estimate
  off it. Estimates therefore attach to a **project**, not a task; Phase 4B
  is the seam that turns an approved estimate into a real task.
- **The execution-trigger boundary is narrow and easy to guarantee.**
  Nothing reaches OpenHands dispatch except a task reaching `QUEUED`, which
  only happens via the privileged `POST /v1/jobs/:id/fund` endpoint. As long
  as no estimate code path ever writes `tasks.status` or calls `/fund`,
  execution categorically cannot start from this phase's surface.
- **The existing privileged-role precedent fits cleanly.** `session.ts`'s
  `PRIVILEGED_ORG_ROLES`/`requirePrivilegedRole` already gates `fund`/
  `verify`/`accept`/`reject`. Estimate approval — setting the ceiling later
  funding will be measured against — is genuinely analogous in risk, so it
  reuses the same primitive rather than inventing a new permission tier.
- **`projects`/`tasks` share an unenforced tenant-integrity gap today**:
  both store `organization_id` and a parent id as independent plain foreign
  keys with no DB-level constraint tying them together. This phase does not
  fix that gap on existing tables (out of scope), but does not repeat it on
  the new table either — see Decision.

## Decision

### Data model: project-level, versioned, immutable-once-approved

A new `project_estimates` table (`packages/database/migrations/
0008_project_estimates.sql`) holds one row per estimate version, grouped by
a server-generated `lineage_id`:

- **Ownership**: `project_id` + `organization_id`, not `task_id`. Scoping
  happens before a task/agent-profile/budget commitment exists.
- **Versioning**: `unique(lineage_id, version)`. A revision always inserts a
  new row and, in the same transaction, supersedes the prior head
  (`status='SUPERSEDED'`) via the same guarded-optimistic-lock pattern
  `jobs.ts`'s `fund`/`verify` handlers already use. An approved or
  superseded row is never mutated in place.
- **At most one `APPROVED` row per lineage**, enforced by a partial unique
  index (`project_estimates_one_approved_per_lineage`) — a database
  guarantee, not just application logic.
- **Historical approval metadata is immutable and auditable.**
  `approved_by`/`approved_at` are set once and survive a later supersede —
  a `SUPERSEDED` row that *was* approved keeps proof of that forever. This
  was a deliberate correction to an earlier draft constraint that would have
  nulled approval metadata on every supersede, destroying exactly the audit
  trail settlement will eventually need.
- **Pricing totals are first-class, nullable columns**
  (`currency`, `estimated_min_minor`, `estimated_max_minor`,
  `proposed_budget_cap_minor`), not something a later phase recomputes from
  JSON or today's rate config. A completeness constraint requires all four
  when `pricing_status='PRICED'` and none when `'UNPRICED'`; an ordering
  constraint requires `min <= max <= proposed cap`. `pricing_breakdown`
  (jsonb) and `rate_version` are preserved alongside the totals so a future
  priced estimate records both the aggregate numbers and the exact inputs
  that produced them.
- **Tenant integrity is DB-enforced, not just app-scoped.** `projects`
  gained an additive `unique(id, organization_id)` constraint; the new
  table's `foreign key (project_id, organization_id) references
  projects(id, organization_id)` makes a mismatched org/project pair
  impossible at the database level, independent of any query-level
  `.where("organization_id", ...)` check. This does not touch `tasks`'s
  identical, pre-existing, unaddressed gap — that remains explicitly out of
  scope for this phase.

### Planner vs. pricing: a hard boundary

An LLM ("the planner") produces structured output — goal, scope, deliverables,
implementation plan, assumptions, acceptance criteria, infrastructure
requirements, risks, and *resource* estimates (complexity, duration,
inference tier/tokens, storage/compute/deployment type). It never produces a
dollar figure. `PlannerOutputSchema` (`packages/contracts/src/estimates.ts`)
is a plain `z.object()` with no monetary field in its shape at all — even if
a model hallucinates a `price`/`estimatedCostMinor` key, `.parse()` strips it
before anything is persisted, verified by a dedicated contract test.

A separate, pure, deterministic pricing engine (`apps/api/src/pricing/
engine.ts`) turns a validated resource estimate into a dollar breakdown —
`priceEstimate(resourceEstimate, rateConfig)` — with no I/O and no model
involvement, unit-tested independently of any LLM call. Today
`apps/api/src/pricing/rates.ts` has no real rate configuration, so every
estimate this phase produces is honestly `pricing_status='UNPRICED'` rather
than a fabricated plausible-looking number. `proposedBudgetCapMinor`, when
it exists, is computed by fixed policy off the estimated maximum, never by
the model.

### Approval semantics

Approval targets an exact `estimateId` — never "the current version" — via
`requirePrivilegedRole`. It is implemented as a guarded `UPDATE ... WHERE
id = $id AND status = 'READY_FOR_REVIEW'`: a second approval of the same
already-approved id is an idempotent success (same `approvedBy`/
`approvedAt`, never a duplicate transition); approving a `SUPERSEDED` id
returns 409 naming the real current head version; approving a `DRAFT`
returns 409 "not ready for review." Concurrent approve/revise races on the
same lineage resolve deterministically through this same guard, tested in
both orderings and under a genuine concurrent race.

Approval means "I accept this scope and proposed estimate." It explicitly
does **not** mean funds transferred, execution queued, execution started, or
settlement authorized — enforced by construction: `apps/api/src/routes/
estimates.ts` has zero references to the `tasks`/`executions` tables, the
`/fund` endpoint, or dispatch-routing/execution-event machinery, verified by
both a runtime test (task/execution row counts unchanged across a full
generate-revise-approve cycle) and a static source-grep test that fails the
instant anyone adds such a reference in the future.

### Auditability

Every estimate row preserves what settlement will eventually need to answer
"what exactly did the user approve": the source prompt, the full validated
planner output, which planner model produced it, the pricing inputs/version
if priced, the approving actor, and the approval timestamp — never only the
latest rendered UI state.

## Relationship to Phase 4B: Authorized Project Budget

Phase 4B is the seam that turns "accept this scope" into "commit money to
it." Proposed shape: once an estimate is `APPROVED` (ideally `PRICED`, or
with an explicit manually-entered cap if not), a privileged member
authorizes a budget against it; this creates a real `tasks` row (still
requiring `agentProfileId`/`repositoryRevision`, which the planner does not
produce), snapshots a new `tasks.source_estimate_id` FK back to the
approved estimate (Phase 4B's own migration, not this one), and only then
re-enters the existing, unmodified `fund`/claim/dispatch machinery. Until
Phase 4B exists, an approved estimate has no code path that can ever reach
execution — that inertness is the property this ADR's design guarantees.

## Consequences

**Makes easier**: reviewable, revisable, auditable build proposals before
any money or compute is committed; a clean seam for Phase 4B to bridge
without touching this phase's tables; honest `UNPRICED` estimates today with
no schema change needed once real rates exist.

**Makes harder / open questions**: one lineage is created per `POST
.../estimates` call today — calling it again on the same project starts a
new lineage rather than reusing one, and the UI only surfaces the most
recent lineage's head; if multiple concurrent planning threads per project
are wanted (or explicitly unwanted), that needs its own product decision.
The planner's LLM call has only been validated against an injectable fake
client in this environment (no `ANTHROPIC_API_KEY` was available); real
Claude output-shape drift against `PlannerOutputSchema` remains an
unverified integration item until run against a live key. `tasks`/`projects`
still lack the composite tenant-integrity FK that `project_estimates` now
has — a pre-existing gap this phase deliberately did not expand its own
scope to fix.
