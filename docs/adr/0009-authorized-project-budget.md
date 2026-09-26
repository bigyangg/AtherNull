# ADR-0009: Authorized project budget and the build-activation boundary (Phase 4B)

Status: Accepted
Date: 2026-09-27

## Context

ADR-0008 (Phase 4A) built intent -> scope -> build plan -> estimate -> user
approval of scope, and stopped there deliberately: an approved estimate has
no code path that reaches execution. ADR-0008's own "Relationship to Phase
4B" section sketched a *proposed* shape for the next step — creating a real
`tasks` row and a `tasks.source_estimate_id` FK at authorization time. That
preview is **superseded by this ADR**: after auditing the real, live gap
described below, the actual decision taken for Phase 4B is narrower and
creates zero task rows. Nothing in ADR-0008's Phase 4A scope/estimate
machinery is changed by this phase.

### Five distinct concepts, kept explicitly separate

This phase exists because "approved a scope" and "committed money to it" are
different acts, and both are different again from three later acts this
phase deliberately does not implement:

1. **Estimate** (ADR-0008) — a plan and a *proposed* cost range/cap. No
   money is committed. Multiple versions may exist per lineage; at most one
   is `APPROVED`.
2. **Budget authorization** (this ADR) — a privileged member's explicit
   commitment of an exact money amount against one exact, `APPROVED`
   estimate version. Still no task exists, no worker is dispatched, no
   payment method is charged. This is "I authorize spending up to this
   much," not "spend it now."
3. **Funding** (`POST /v1/jobs/:id/fund`, pre-existing, untouched) — the
   act of moving a real `tasks` row from `AWAITING_FUNDING` to `QUEUED`,
   which is the ONLY thing that can ever cause OpenHands dispatch to start.
4. **Actual usage** (`usage_events`, pre-existing) — real, metered spend
   recorded once execution actually runs.
5. **Settlement** — reconciling authorized budget against actual usage and
   moving real money (Solana/eSewa/Khalti or otherwise). **Not built. Not
   started. Not even schemed here** — no column, no status, no stub exists
   for it in this phase.

Phase 4B implements only #2, and is careful never to let its own surface
reach #3, #4, or #5.

### What this session confirmed, by reading real source (not assumed)

- **`POST /v1/jobs` requires only `requireOrgSession`** (`apps/api/src/
  routes/jobs.ts:72-135`) — no privileged role, no estimate reference, no
  budget-authorization reference of any kind. It inserts a task directly at
  `AWAITING_FUNDING` with a client-supplied `budgetMinor`/`agentProfileId`/
  `repositoryRevision`. It is reachable live today through `apps/web/
  components/projects/add-task-form.tsx`, rendered on the real project page.
- **`POST /v1/jobs/:id/fund`** (`jobs.ts:151-222`) requires
  `requirePrivilegedRole` and, in one guarded transaction, moves
  `AWAITING_FUNDING -> QUEUED` — with zero reference to
  `project_estimates` or (now) `project_budget_authorizations`.
- Put together: **today, any org member can create a task via `/v1/jobs`,
  and any owner/admin can then fund/queue it — with zero estimate and zero
  budget-authorization involvement, completely bypassing everything ADR-0008
  and this ADR build.** This gap is real, live, and pre-existing; it is
  independent of and unaffected by Phase 4B — Phase 4B does not make it
  worse, and does not close it either. See "Known gap" below for the full
  treatment this ADR is required to give it.
- **No `tasks.source_estimate_id` or `tasks.source_budget_authorization_id`
  column is added in this phase**, and none will be until Phase 4C actually
  wires authorization into task creation. Adding either column now, with no
  code path that reads or writes it, would be schema noise pretending a
  connection exists that doesn't yet.
- **No real pricing/rate card exists** (`apps/api/src/pricing/rates.ts`'s
  `RATE_CONFIG` is still `null`) — every estimate remains honestly
  `UNPRICED` today, exactly as ADR-0008 left it.

## Decision

### Task-creation timing: Option A — zero tasks created by this phase

Two shapes were on the table: (A) authorization is a pure record, no task is
ever touched by this route; (B) authorization eagerly creates a real `tasks`
row at `AWAITING_FUNDING`, snapshotting a `source_estimate_id` FK back to
the estimate.

**Option A was chosen.** The `/fund`-bypass gap above is the deciding
evidence: today, task creation and funding are *already* fully decoupled
from estimates by a live, pre-existing route (`/v1/jobs`) that Phase 4B does
not own and is explicitly out of scope to modify. Building Option B would
mean this phase invents a *second*, parallel task-creation path (estimate ->
authorization -> task) that coexists with the first, ungated one
(`/v1/jobs` directly) — doubling the surface without closing the actual
hole. Closing the hole requires changing `/v1/jobs` itself (requiring an
estimate/authorization at task-creation time, or gating it entirely), which
is a task-creation-timing change explicitly deferred to Phase 4C. Until
that redesign happens, adding a second task-creation path from this phase
would be net-negative: more surface, same vulnerability, and a new
"authorized-but-not-yet-a-task" state with no consumer.

Phase 4B therefore creates **zero task rows, ever**. `tasks.
source_estimate_id` / `tasks.source_budget_authorization_id` are **not**
added by this phase's migration — deferred entirely to Phase 4C, at the
point where task creation is actually redesigned to require one.

### Data model: `project_budget_authorizations`, one row per commitment

`packages/database/migrations/0009_project_budget_authorizations.sql`:

```sql
-- Phase 4B — Authorized Project Budget and Build Activation Boundary.
--
-- Additive uniqueness needed for the composite FKs below. project_estimates
-- did not need either of these for Phase 4A's own composite FK (which only
-- tied project_id to organization_id via projects) — this phase's table
-- needs two more:
--
-- 1. (id, organization_id) — so a project_budget_authorizations row's
--    estimate_id and organization_id can be tied together at the DB level
--    (closes the gap where a row could otherwise reference a real
--    estimate_id belonging to a DIFFERENT organization than the one the
--    authorization row itself claims).
alter table project_estimates add constraint project_estimates_id_organization_id_unique unique (id, organization_id);

-- 2. (id, lineage_id, version) — project_estimates only had
--    unique(lineage_id, version) before this phase; `id` alone is already
--    globally unique via its primary key, but Postgres composite foreign
--    keys require a unique constraint on the EXACT column tuple being
--    referenced, and (id, lineage_id, version) as a tuple has no such
--    constraint until this line. Without it, the exact-version-identity FK
--    below (guaranteeing that a given estimate_id + estimate_lineage_id +
--    estimate_version genuinely belong together, not just that estimate_id
--    exists) could not be declared at all.
alter table project_estimates add constraint project_estimates_id_lineage_id_version_unique unique (id, lineage_id, version);

create table project_budget_authorizations (
    id                  uuid primary key default gen_random_uuid(),

    organization_id     uuid not null references "organization"(id),
    project_id          uuid not null references projects(id),
    foreign key (project_id, organization_id) references projects (id, organization_id),

    estimate_id         uuid not null references project_estimates(id),
    estimate_lineage_id uuid not null,
    estimate_version    integer not null,
    foreign key (estimate_id, estimate_lineage_id, estimate_version)
        references project_estimates (id, lineage_id, version),
    foreign key (estimate_id, organization_id) references project_estimates (id, organization_id),

    amount_minor        bigint not null check (amount_minor > 0 and amount_minor <= 100000000000),
    currency            text not null,
    source              text not null check (source in ('ESTIMATE_PROPOSED_CAP','USER_SET')),
    status              text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED')),

    supersedes_id       uuid references project_budget_authorizations(id),

    authorized_by       uuid not null references "user"(id),
    authorized_at       timestamptz not null default now(),
    created_at          timestamptz not null default now()
);

create index on project_budget_authorizations (project_id);
create index on project_budget_authorizations (organization_id);
create index on project_budget_authorizations (estimate_id);

create unique index project_budget_authorizations_one_active_per_estimate
    on project_budget_authorizations (estimate_id) where status = 'ACTIVE';
```

Design points:

- **Exact-estimate scoping, no lineage inheritance.** `estimate_id` (plus a
  denormalized `estimate_lineage_id`/`estimate_version` for cheap, direct
  reads without a join) is the exact estimate version an authorization was
  made against. The partial unique index is scoped to `estimate_id`, not
  `lineage_id` — v2 and v3 of the same lineage each get their own
  independent authorization history; authorizing v2 says nothing about v3.
  Revising v2 into v3 never touches v2's authorization rows and never
  copies them onto v3 — verified by a runtime test.
- **Two additive unique constraints, both required by Postgres itself, not
  by choice.** `project_estimates_id_organization_id_unique` and
  `project_estimates_id_lineage_id_version_unique` were both added because
  Postgres requires a unique constraint on the *exact* column tuple a
  composite foreign key references — `unique(lineage_id, version)` (already
  present from Phase 4A) does not satisfy a `(id, lineage_id, version)`
  foreign key, even though `id` alone is already globally unique via the
  primary key. Both were verified to actually exist and actually be used by
  attempting the migration against a real Postgres instance before writing
  any application code against it.
- **Tenant integrity is DB-enforced twice over, closing a specific
  composability gap.** Two separate composite FKs — `(project_id,
  organization_id)` and `(estimate_id, organization_id)` — could, in
  isolation, each be independently satisfied by rows belonging to two
  *different* organizations (e.g. a row naming Org A's project but Org B's
  estimate, where both facts are individually true). A dedicated test
  constructs exactly that shape and confirms Postgres rejects it: real FK
  violation, not an application-level check.
- **At most one `ACTIVE` row per exact `estimate_id`**, backed by a partial
  unique index — the same "DB guarantee, not just application logic"
  pattern ADR-0008 established for `project_estimates_one_approved_per_
  lineage`.
- **Corrections are new rows, never in-place mutation.** A superseded row's
  `amount_minor`/`currency`/`source`/`authorized_by`/`authorized_at` are
  permanent history — verified by a test that authorizes, corrects, and then
  re-reads the original row to confirm every one of those fields is
  byte-for-byte unchanged.

### Route semantics

`apps/api/src/routes/budget-authorizations.ts`, registered in `app.ts`
alongside (not merged into) `estimateRoutes`, for the same reason Phase 4A
kept estimates out of `jobs.ts`: this file must be staticaly and provably
free of any task/execution/funding reference.

- `POST /v1/projects/:projectId/estimates/:estimateId/budget-authorization`
  — `requirePrivilegedRole` (same tier as `fund`/`verify`/`accept`/`reject`/
  estimate-`approve`). Targets an exact `estimateId`, never "current" —
  requires `project_estimates.status === 'APPROVED'` **re-verified inside
  the transaction via `SELECT ... FOR UPDATE`**, the same row-lock idiom
  `estimates.ts`'s `/revise` uses. Rejects `DRAFT`/`READY_FOR_REVIEW`/
  `SUPERSEDED` with a distinct 409 naming the real status.

  Request body: `{ source: "USER_SET" | "ESTIMATE_PROPOSED_CAP", amountMinor?: number, currency: string }`.
  - `USER_SET` requires an explicit `amountMinor`; this is the *only* valid
    source when the estimate is `UNPRICED` (`ESTIMATE_PROPOSED_CAP` on an
    `UNPRICED` estimate is rejected with 400 — never a fabricated `$0`).
  - `ESTIMATE_PROPOSED_CAP` is only valid when the estimate is genuinely
    `PRICED` with a real persisted `proposed_budget_cap_minor`; the server
    always uses that persisted value verbatim. If the caller also supplies
    `amountMinor` and it doesn't match the persisted cap exactly, the
    request is rejected (400) — never silently substituted with the real
    value.
  - Response: `201` for a newly created row (fresh or a correction), `200`
    for the idempotent no-op path (see below).

- `GET /v1/projects/:projectId/estimates/:estimateId/budget-authorizations`
  and `GET /v1/projects/:projectId/budget-authorizations` — `requireOrgSession`
  only (same tier as reading an estimate). Returns full history, current
  `ACTIVE` row (if any) plus every `SUPERSEDED` one, oldest first.

### Superseding and idempotency

Both run inside one transaction, mirroring `estimates.ts`'s guarded-update
idiom:

- **Idempotent match**: a request whose `estimate_id` + `amount_minor` +
  `currency` + `source` exactly matches the current `ACTIVE` row returns
  that row unchanged — `200`, no new row, no supersede.
- **Correction**: a request that differs in any of those fields
  guard-updates the old row `ACTIVE -> SUPERSEDED` (`WHERE status =
  'ACTIVE'`) and inserts a new `ACTIVE` row with `supersedes_id` pointing at
  it, in the same transaction — `201`.
- **Concurrency**: the handler locks the *target estimate row* itself
  (`SELECT ... FOR UPDATE` on `project_estimates`) before ever reading or
  writing `project_budget_authorizations` — the same idiom `estimates.ts`'s
  `/revise` uses on its own table. Two concurrent authorize calls against
  the same estimate therefore fully serialize at that lock: there is no
  window where both observe "no `ACTIVE` row" or a stale one at once. Both
  requests succeed in program order (the second is a legitimate,
  correctly-chained correction of the first — not a race loser), and the
  database ends up in exactly the state a sequential pair of calls would
  produce, every time. This was verified directly: a real concurrent-request
  test against two different amounts on the same estimate, both via
  `Promise.all`, confirms both succeed and exactly one `ACTIVE` row survives
  with a correct `supersedes_id` chain — for both a fresh estimate and an
  already-authorized one.

  The partial unique index remains the **last-resort backstop** for any
  write path that does *not* take that estimate-row lock (e.g. a direct,
  non-route insert). This was verified independently and directly: two
  genuinely concurrent raw inserts of `ACTIVE` rows for the same
  `estimate_id`, issued with no estimate-row lock at all, race against each
  other with exactly one succeeding and the other rejected by Postgres with
  a real unique-violation error (`23505`) — proving the index itself, not
  just the application-level lock, is what ultimately prevents two `ACTIVE`
  rows from ever coexisting.

### Consumption-freeze (explicit non-decision)

Phase 4B does **not** implement a "consumed" authorization status. There is
no downstream task/funding/activation object yet for such a status to
refer to, and inventing one now would be a fabricated state with no real
consumer. **Phase 4C invariant to add at that time:** once an authorization
is referenced by a real task/funding/activation object, it must no longer
be eligible to be superseded (a consumed authorization is historical fact,
not a draft). This is written down here as a requirement for Phase 4C's
design, not implemented as a column or status now.

### No planner/model involvement, ever

`routes/budget-authorizations.ts` never imports `planner.ts` and never
calls `generatePlannerOutput` — verified both statically (a source-grep test
mirroring `estimates-no-execution-path.test.ts`, extended to also forbid
`tasks`/`executions`/`payment_intents`/`/fund`/planner references) and at
runtime (a test installs a planner client that throws on any invocation,
then confirms authorization still succeeds normally). Every dollar amount
this route ever persists is either a caller-supplied `USER_SET` figure or
the estimate's own already-computed, already-persisted
`proposed_budget_cap_minor` (Phase 4A's `pricing/engine.ts` output) — never
a value derived, recomputed, or re-requested from an LLM.

## Known gap: `POST /v1/jobs` bypasses estimates and budget authorization entirely

This is a pre-existing, live gap independent of and unaffected by
Phase 4B — Phase 4B neither creates it nor closes it.

**The gap, precisely:** `POST /v1/jobs` (`apps/api/src/routes/jobs.ts:72-
135`) requires only `requireOrgSession` — no privileged role, and no
reference anywhere in that handler to `project_estimates` or
`project_budget_authorizations`. Any authenticated org member can create a
task directly at `AWAITING_FUNDING` by supplying `budgetMinor`/
`agentProfileId`/`repositoryRevision` themselves. `apps/web/components/
projects/add-task-form.tsx` calls this endpoint live, today, rendered on the
real project page. `POST /v1/jobs/:id/fund` (`jobs.ts:151-222`,
`requirePrivilegedRole`) then moves that exact task `AWAITING_FUNDING ->
QUEUED` in one guarded transaction — with, again, zero reference to any
estimate or budget authorization. **The consequence: today, an owner/admin
can take a task from creation to `QUEUED` (i.e. to the one gate that
actually triggers OpenHands dispatch) with zero estimate and zero budget-
authorization involvement, completely bypassing both ADR-0008 and this
ADR's entire structure.**

This is real and was confirmed by reading the live route source, not
assumed. Hiding the "Create task directly" UI affordance on the frontend
would not close this gap — the endpoint itself has no server-side
requirement tying it to an estimate or authorization, so any direct API
caller (or a future UI regression) reopens it instantly. **Phase 4C must
close this server-side**, not by frontend omission alone.

### Was a temporary feature gate needed to ship Phase 4B safely on its own?

Answered explicitly, as required, rather than decided unilaterally:

**No temporary gate was added, and none is being proposed as a blocking
requirement for shipping Phase 4B.** Reasoning:

- The gap **pre-dates Phase 4B entirely** and is completely unaffected by
  it — Phase 4B adds a new, additive, opt-in capability (authorize a budget
  against an approved estimate) that no existing code path is required to
  use. It does not touch `jobs.ts`, does not change `/v1/jobs`'s
  authorization requirements, and does not make the existing bypass any
  easier, more damaging, or more discoverable than it already is today on
  `main`.
  A reasonable objection is that shipping Phase 4B lends the *appearance* of
  a completed budget-authorization boundary while the actual enforcement
  point (`/v1/jobs`) remains wide open — that's a real risk, but it's a
  risk of *messaging/expectations*, not of Phase 4B introducing or
  amplifying an actual new vulnerability. This ADR's "Known gap" section
  exists specifically to prevent that appearance from going undocumented.
- A temporary gate on `/v1/jobs` (e.g. an env-flag-gated 403 for non-admin/
  non-test contexts) is a real, viable option and is described concretely
  below for Phase 4C to pick up — but it is a `jobs.ts` change, and this
  phase's explicit instructions are to not modify `jobs.ts`/`internal.ts`
  and to stop and report rather than implement anything touching them
  without it being explicitly requested. Given the gap is pre-existing and
  unaffected by this phase's own changes, implementing a gate here would be
  scope creep into a decision that belongs to whoever schedules Phase 4C
  work, not an emergency fix this phase's changes made newly necessary.

**If the reasoning above changes** — e.g. if `/v1/jobs`+`/fund` is to be
exposed to real users/real money before Phase 4C ships — then a temporary
gate is warranted, and would concretely look like: an env-flag
(`REQUIRE_ESTIMATE_FOR_TASK_CREATION` or similar) checked at the top of
`POST /v1/jobs`, returning 403 for any caller without a privileged role (or
disabling the route entirely) when the flag is set, defaulting to the flag
being *off* in local/dev/test so no existing test suite breaks, and *on* in
any environment carrying real money. That is a `jobs.ts` change and is
explicitly not implemented in this phase.

## Phase 4C handoff (documentation only — not implemented here)

Phase 4C's job is to turn "an authorized budget exists" into "a task can
actually be created and run against it," and to close the gap above. Concretely:

1. **Redesign task creation to require an authorization.** `POST /v1/jobs`
   (or a new, stricter endpoint) must, for any project with at least one
   estimate lineage, require a `project_budget_authorizations.id`
   referencing an `ACTIVE` row before a task can be created — not merely
   accept `agentProfileId`/`budgetMinor` from the client directly. Whether
   this fully replaces `/v1/jobs` or adds a required parameter to it is a
   Phase 4C design decision.
2. **Add the deferred columns.** `tasks.source_estimate_id` (references
   `project_estimates(id)`) and `tasks.source_budget_authorization_id`
   (references `project_budget_authorizations(id)`) — snapshotted at task
   creation, immutable afterward, giving full audit provenance from task
   back through authorization back through estimate.
3. **Add the consumption-freeze invariant.** Once a
   `project_budget_authorizations` row is referenced by a real task, reject
   any further supersede/correction attempt against it — that row is now
   historical fact, not a draft. This requires either a new `CONSUMED`
   status or an equivalent guard keyed off whether any task references it;
   the exact mechanism is a Phase 4C design decision, but the invariant
   itself is fixed by this ADR.
4. **Decide and implement the `/v1/jobs` gap closure**, per the "Known gap"
   section above — likely superseding today's `/v1/jobs` shape entirely
   once task creation is required to carry a real authorization reference,
   rather than needing the separate temporary gate described above at all.
5. **Reconcile authorized amount vs. `tasks.max_budget_minor`.** Today
   `POST /v1/jobs` accepts an arbitrary `budgetMinor` from the caller; once
   task creation requires an authorization, this phase's `amount_minor`
   should become the authoritative source for (or an upper bound on)
   `tasks.max_budget_minor`, not a second, independently-supplied number.

None of the above is implemented by Phase 4B. `apps/api/src/routes/
{jobs,internal}.ts` are unmodified by this phase.

## Consequences

**Makes easier**: a reviewable, auditable record of exactly what a
privileged member committed to spend, against exactly which estimate
version, before any task exists — a clean, additive seam for Phase 4C to
build task creation against, without this phase inventing a task-shaped
placeholder or fabricating a rate. Corrections are fully auditable (nothing
is ever overwritten in place).

**Makes harder / explicitly does not guarantee**: Phase 4B does **not**
guarantee that every task in this system is backed by an authorization —
the `/v1/jobs` gap above proves the opposite is true today. It does **not**
implement consumption/locking (deliberately deferred, with the invariant
written down for Phase 4C). It does **not** implement funding, settlement,
or any real payment rail. An authorization amount is a stated intent, not a
reservation against any real balance — no escrow, no hold, no wallet
integration exists or is implied by this phase.
