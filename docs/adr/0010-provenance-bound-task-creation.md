# ADR-0010: Provenance-bound task creation and the execution activation gate (Phase 4C)

Status: Accepted
Date: 2026-09-27

## Context

ADR-0009 (Phase 4B) documented, in detail, a real and live gap it was
explicitly forbidden from closing: `POST /v1/jobs` requires only
`requireOrgSession` and has zero reference to `project_estimates` or
`project_budget_authorizations`, so any org member could create a task and
any owner/admin could fund it to `QUEUED` — the one gate that triggers real
OpenHands dispatch — with zero estimate and zero budget-authorization
involvement, completely bypassing everything Phase 4A/4B built. Phase 4C's
entire job is to close that exact bypass. `apps/api/src/routes/jobs.ts` is
now in scope; `apps/api/src/routes/internal.ts`'s claim/dispatch mechanics
are not — once a task is legitimately `QUEUED`, how it gets claimed and
dispatched is unchanged.

The historical-data preflight (human-reviewed against the real dev
Postgres before this migration was approved) confirmed: 26 total historical
tasks, all preserved; zero task/project organization mismatches; zero orphan
tasks; zero legacy `AWAITING_FUNDING` tasks (the four pre-existing dev-only
`CANCELLED` artifacts were already closed via the valid FSM edge and are out
of scope for this phase). This meant the schema change below could proceed
as a pure additive/constraint-adding migration with no data risk — verified
again, independently, after the migration actually ran (see "Migration
safety" below).

## Decision

### Canonical flow

```
APPROVED estimate + ACTIVE budget authorization
  -> atomic consumption (one DB transaction)
  -> task created with source_estimate_id + source_budget_authorization_id
  -> authorization becomes CONSUMED
  -> task = AWAITING_FUNDING
  -> STOP.
```

No execution, no conversation, no worker claim, no payment intent, no
blockchain activity happens from task creation itself — verified both
statically (a source-grep test mirroring `estimates-no-execution-path.test.ts`
and `budget-authorizations-no-execution-path.test.ts`) and at runtime (a
row-count test across `executions`/`payment_intents` before and after
canonical creation).

**One authorization produces at most one task, ever.** Retries against an
already-`QUEUED`/`RUNNING` task are execution *attempts* under that one task
(`executions.unique(task_id, attempt_id)`, pre-existing) — never a reason to
create a second task from the same authorization.

### Data model: `tasks` gains provenance, tenant integrity is closed

`packages/database/migrations/0010_task_provenance.sql`, applied exactly as
approved (no deviation from the reviewed shape — every constraint name and
column matched what was proposed, unlike Phase 4B, which had to add one
additional unique constraint beyond its own initial proposal):

```sql
alter table tasks add constraint tasks_project_id_organization_id_unique
    foreign key (project_id, organization_id) references projects (id, organization_id);

alter table project_estimates add constraint project_estimates_id_project_id_unique unique (id, project_id);
alter table project_budget_authorizations add constraint pba_id_organization_id_unique unique (id, organization_id);
alter table project_budget_authorizations add constraint pba_id_estimate_id_unique unique (id, estimate_id);

alter table tasks add column source_estimate_id uuid references project_estimates(id);
alter table tasks add column source_budget_authorization_id uuid references project_budget_authorizations(id);
alter table tasks add constraint tasks_provenance_paired check (
    (source_estimate_id is null) = (source_budget_authorization_id is null)
);

alter table tasks add constraint tasks_source_estimate_project_fkey
    foreign key (source_estimate_id, project_id) references project_estimates (id, project_id);
alter table tasks add constraint tasks_source_authorization_org_fkey
    foreign key (source_budget_authorization_id, organization_id) references project_budget_authorizations (id, organization_id);
alter table tasks add constraint tasks_source_authorization_estimate_fkey
    foreign key (source_budget_authorization_id, source_estimate_id) references project_budget_authorizations (id, estimate_id);

create unique index tasks_one_per_source_budget_authorization
    on tasks (source_budget_authorization_id) where source_budget_authorization_id is not null;

alter table project_budget_authorizations drop constraint project_budget_authorizations_status_check;
alter table project_budget_authorizations add constraint project_budget_authorizations_status_check
    check (status in ('ACTIVE','SUPERSEDED','CONSUMED'));
```

Design points:

- **`tasks(project_id, organization_id)` finally gets the same DB-enforced
  tenant-integrity FK `project_estimates` and `project_budget_authorizations`
  already had** (`projects(id, organization_id)`, from Phase 4A's migration
  0008) — closing the exact "pre-existing, out-of-scope condition" ADR-0008
  explicitly called out and deferred.
- **Two more additive unique constraints, both required by Postgres itself**
  for the same reason Phase 4B needed its own two: a composite FK requires a
  unique constraint on the *exact* tuple referenced.
  `project_estimates_id_project_id_unique` and
  `pba_id_organization_id_unique`/`pba_id_estimate_id_unique` did not exist
  before this phase because nothing needed to reference `(id, project_id)`
  or `(id, estimate_id)` as a tuple until now.
- **Nullable provenance, half-provenance impossible by construction.**
  `source_estimate_id`/`source_budget_authorization_id` are both `NULL` for
  every historical task (no backfill, no fabrication) and both set for every
  canonically-created one — `tasks_provenance_paired` makes the mixed case a
  DB-level impossibility, not an application convention.
- **The chain-of-trust composite FKs are the load-bearing part of this
  migration.** `tasks_source_estimate_project_fkey` ties the task's estimate
  to the task's own project. `tasks_source_authorization_org_fkey` ties the
  task's authorization to the task's own organization.
  `tasks_source_authorization_estimate_fkey` ties the task's authorization to
  the task's *own exact* estimate — proving the authorization was actually
  issued for the estimate stored on the task, not two independently-valid-
  but-mismatched rows. Each of the three was proven to actually reject the
  shape it claims to reject with a direct-insert test against real Postgres
  (see "DB invariant test results" in the delivered test report).
- **The partial unique index is the final backstop**, not the primary
  mechanism — the primary mechanism is the route's own
  `SELECT ... FOR UPDATE` transaction (below). Verified independently: two
  genuinely concurrent raw inserts referencing the same
  `source_budget_authorization_id`, with no application-level lock at all,
  race against each other with exactly one succeeding.
- **No additional unique constraint beyond the three listed above turned out
  to be needed** — audited explicitly, since Phase 4B's own implementation
  needed one more than its initial proposal. The reason none was needed
  here: the chain `task.project_id = estimate.project_id` (via
  `tasks_source_estimate_project_fkey`) plus `authorization.estimate_id =
  task.source_estimate_id` (via `tasks_source_authorization_estimate_fkey`)
  together already imply the authorization's estimate belongs to the task's
  project — a fourth FK tying `authorization.project_id` directly to
  `task.project_id` would be redundant with what those two already
  guarantee. The route layer still checks `authorization.project_id ==
  :projectId` explicitly, as defense in depth on top of the DB guarantee,
  not as a substitute for it.

### `CONSUMED`: a fourth, permanently terminal authorization status

`project_budget_authorizations.status` gains `CONSUMED` alongside `ACTIVE`/
`SUPERSEDED`. Semantics, exactly as implemented and tested:

- Set **only** by the canonical task-creation transaction, in the same
  transaction as the task insert (`UPDATE ... SET status = 'CONSUMED' WHERE
  id = :id AND status = 'ACTIVE'` — guarded, loses the race cleanly with a
  409 if lost).
- **Permanently terminal.** `routes/budget-authorizations.ts`'s own
  supersede/correction query filters `WHERE estimate_id = ? AND status =
  'ACTIVE'` — a `CONSUMED` row is invisible to it by construction, so it can
  never be superseded or corrected again. This was **verified with a real
  test, not assumed**: attempting to "correct" a `CONSUMED` authorization's
  estimate does not throw and does not touch the `CONSUMED` row at all — it
  creates a brand-new, independent `ACTIVE` row with `supersedes_id: null`,
  since the query simply finds no current `ACTIVE` row to chain against.
  This is safe (a new authorization the org must explicitly consume again
  via the canonical endpoint to create a second task) but is a real,
  documented quirk of Phase 4B's own code, not something Phase 4C changed
  `routes/budget-authorizations.ts` to accommodate — that file remains
  completely unmodified by this phase.
- **Idempotent replay.** A repeated identical request against a `CONSUMED`
  authorization looks up the one task referencing it via
  `source_budget_authorization_id` and returns it unchanged (`200`, not
  `201`) — never a second task.
- **Integrity anomaly, not silently papered over.** If a `CONSUMED`
  authorization has **no** linked task (structurally should be impossible,
  since `CONSUMED` is only ever set in the same transaction as the task
  insert), the handler logs a server-side error and returns `500` naming the
  anomaly — it never creates a second task and never reverts the
  authorization back to `ACTIVE` to "fix" the inconsistency. Verified with a
  test that manufactures exactly this anomaly directly at the DB level.

### Canonical endpoint

`POST /v1/projects/:projectId/tasks/from-budget-authorization`
(`apps/api/src/routes/task-provenance.ts`, its own route file — deliberately
not merged into `jobs.ts` or `budget-authorizations.ts`, for the same
static-provability reason Phase 4A/4B kept their own surfaces isolated).

Request body: `{ budgetAuthorizationId: string, agentProfileId: string, repositoryRevision: string }`.
`organizationId`/`estimateId`/`estimateVersion`/amount/currency are **never**
trusted from the client — all derived server-side from the persisted
authorization/estimate rows. `agentProfileId`/`repositoryRevision` remain
caller-supplied (same as legacy `CreateJobRequestSchema`) because nothing
upstream (planner output, estimate, authorization) produces either of them
yet — fabricating a default would silently pick a commit/agent profile the
caller never actually chose.

`requirePrivilegedRole` — same tier as `fund`/`verify`/`accept`/`reject`/
estimate-`approve`/budget-`authorization`.

Algorithm (one transaction, row-locking the authorization then the estimate,
mirroring `budget-authorizations.ts`'s own idiom exactly):

1. `SELECT ... FOR UPDATE` the authorization, scoped to `organization_id`
   and the URL's `projectId`. Not found, or `project_id` mismatch -> `404`.
2. `CONSUMED` -> look up the linked task via `source_budget_authorization_id`.
   Found -> return it, `200`. Not found -> `500` integrity anomaly (above).
3. `SUPERSEDED` -> `409`.
4. `ACTIVE` -> `SELECT ... FOR UPDATE` the estimate. Not `APPROVED` -> `409`
   naming the real status. Project/org/estimate-identity mismatches are
   re-verified here too, as defense in depth on top of the DB's own
   composite FKs.
5. Insert the task (`AWAITING_FUNDING`, with both provenance columns set).
6. Guarded `UPDATE ... SET status = 'CONSUMED' WHERE status = 'ACTIVE'`. Lost
   the race -> roll back everything (task insert included) -> `409`.

### Task field derivation

Audited against `POST /v1/jobs`'s existing construction
(`requirements`, `acceptance_criteria`, `agent_profile_id`,
`repository_revision`, `agent_profile_config_revision`,
`agent_policy_version`, `max_budget_minor`, `currency`):

- `requirements` <- `estimate.planner_output.goal`.
- `acceptance_criteria` <- `estimate.planner_output.acceptanceCriteria`.
- `agent_profile_id`/`repository_revision` <- caller-supplied request
  fields (see above); `agent_profile_config_revision`/`agent_policy_version`
  are snapshotted from the agent profile at creation time, same
  reproducibility-snapshot rationale as `0004_task_reproducibility_snapshot.sql`.
- `max_budget_minor`/`currency` <- `authorization.amount_minor`/
  `authorization.currency`, verbatim, snapshotted immutably.

**This last mapping is a deliberate policy decision, not an accidental
overload.** `max_budget_minor` is used today purely as a *routing
affordability filter* — `chooseTier()`'s only signal from it — while the
authorized amount is the actual business/economic ceiling a privileged
member committed to. Phase 4C treats these as the same value for now: the
authorized amount **is** the natural source of truth for what routing should
treat as affordable, snapshotted at task-creation time exactly like
`agent_profile_config_revision`/`repository_revision` already are, so a
later correction to the authorization (which, per the `CONSUMED`-is-terminal
rule above, can only ever apply to a *different*, later authorization/task
pair) never silently changes an already-created task's routing behavior
underneath it.

### `/fund` hardening

`apps/api/src/routes/jobs.ts`'s existing `POST /v1/jobs/:id/fund` handler,
modified in place (same transaction, same optimistic-lock guarded update it
already had) to additionally require, before allowing
`AWAITING_FUNDING -> QUEUED`:

1. `task.source_estimate_id IS NOT NULL AND task.source_budget_authorization_id IS NOT NULL`.
2. The referenced estimate exists, matches the task's project/org, and is
   `status = 'APPROVED'` **at fund time** (not just at task-creation time —
   see "Remaining known limitations" below).
3. The referenced authorization exists, matches the task's project/org,
   references `task.source_estimate_id` exactly, and is `status =
   'CONSUMED'`.
4. Exactly one task references that authorization — structurally guaranteed
   by `tasks_one_per_source_budget_authorization`, confirmed defensively
   with a `COUNT` rather than assumed.

Any failed check returns a `409` naming exactly what's missing. This check
is **always active**, independent of `ALLOW_LEGACY_JOB_CREATION`'s state — a
provenance-less task created via a still-enabled legacy path can be created
but can never be funded. There are zero historical `AWAITING_FUNDING` tasks
today (confirmed by the preflight), so this has zero blast radius on
existing data — proven with a test anyway, not assumed.

### Legacy `POST /v1/jobs`: compatibility-only, fail-closed by default

`legacyJobCreationEnabled()` in `routes/jobs.ts` reads
`process.env.ALLOW_LEGACY_JOB_CREATION` **at call time**, not at module load
— this is what makes it possible for a single test process to exercise both
the disabled and explicitly-enabled paths. Exact semantics:

- The flag must be the **exact string `"true"`** — `"1"`, `"TRUE"`, or any
  other truthy-looking value is fail-closed (`403`). Verified with a test.
- Absent (the production default) -> `403`.
- Set to `"true"` -> the legacy handler runs, but now additionally requires
  `requirePrivilegedRole` (closing "any org member can self-serve a task"
  even in the compatibility path) — narrower than before Phase 4C, when it
  required only `requireOrgSession`.
- Regardless of this flag's state, a legacy-created task carries `NULL`
  provenance and can never pass the `/fund` hardening above.

Test fixtures across `job-lifecycle.test.ts`, `realtime-gateway.test.ts`, and
`openhands-compat.test.ts` no longer call legacy `/v1/jobs` at all — their
shared `createFundedTask`/`createFundedAndRunningTaskWithConversation`
fixtures now build a fixture-only `APPROVED` estimate + `ACTIVE`
authorization directly (bypassing the planner LLM, same pattern
`budget-authorizations-lifecycle.test.ts`'s `insertPricedApprovedEstimate`
already established), then create + fund through the real canonical
endpoint. `tenant-authorization.test.ts` is the one file that still
genuinely exercises the legacy path's own authorization semantics
(cross-org rejection, removed-member rejection, a privileged owner's own
creation) and sets `ALLOW_LEGACY_JOB_CREATION=true` explicitly at the top of
the file, mirroring the existing `AUTH_TEST_RATE_LIMIT_MAX` convention.

### `AddTaskForm` / onboarding wizard

`apps/web/components/projects/add-task-form.tsx` is repurposed, not deleted:
it now lists the project's `ACTIVE` budget authorizations
(`GET /v1/projects/:projectId/budget-authorizations`, pre-existing Phase 4B
endpoint) and lets a privileged member pick one, plus a repository revision,
to call the canonical endpoint — labeled **"Prepare Build"**, landing the
task at `AWAITING_FUNDING`. A new, small `ActivateBuildPanel` on the task
detail page (`apps/web/app/(app)/projects/[projectId]/tasks/[taskId]/page.tsx`)
is the only remaining UI entry point for `POST /v1/jobs/:id/fund`, labeled
**"Activate Build"**. Neither surface, nor `budget-authorization-panel.tsx`'s
updated `CONSUMED` rendering, ever uses "Paid"/"Funded"/"Deposited"/
"Escrowed" — no real payment rail exists anywhere in this codebase.

`apps/web/components/projects/new-repo-project-form.tsx`'s onboarding wizard
also had its own copy of the legacy create+fund pattern in a second wizard
step. Since a legacy-created task can never be funded under the hardened
check (and the flag defaults closed in production), that step was removed
rather than left silently broken — the wizard now stops after creating the
project and hands off to the project page's own canonical flow.

## Migration safety (verified against the real dev Postgres, after applying)

- All 26 historical tasks still exist, unmutated.
- The four pre-existing `CANCELLED` dev artifacts remain exactly
  `CANCELLED` — not touched, not re-examined beyond this count.
- Zero provenance was fabricated for any historical row — both provenance
  columns are `NULL` on every one of the 26 pre-existing tasks.
- Task/project organization-mismatch count: 0 (unchanged).
- Orphan task count: 0 (unchanged).
- No unexpected status mutation on any pre-existing row.

## What Phase 4C provides and does not provide

**Provides:** scope provenance (task -> estimate), budget-authorization
provenance (task -> authorization), a DB-enforced chain proving the
authorization was issued for the task's own exact estimate, one-task-per-
authorization (enforced at three independent layers), and an activation gate
(`/fund`) that refuses to queue any task lacking a fully valid, current
provenance chain.

**Does not provide:** actual payment receipt or capture of any kind; any
Solana/eSewa/Khalti/bank funding integration; runtime spend metering or
enforcement during execution (`usage_events` is still purely observational);
settlement, refunds, or dispute handling; any change to how a `QUEUED` task
is claimed or dispatched (`internal.ts` is untouched).

## Remaining known limitations

- **An estimate revised after its task is created, but before that task is
  funded, permanently locks the task out of funding.** `/fund` requires the
  task's source estimate to be `APPROVED` *at fund time*, not just at task-
  creation time. Revising an estimate supersedes it (Phase 4A behavior,
  unchanged) — including v2, even after a task has been prepared from an
  authorization against it. This was discovered directly via the real
  end-to-end test (a task prepared from v2, followed by a v2 -> v3 revision,
  then a genuine `/fund` attempt on the real task, correctly rejected with
  `409`). This is an intentional consequence of "provenance must be exact
  and current," not a bug, but it means a privileged member must fund a
  prepared build before revising its underlying estimate further, or accept
  that the task becomes permanently stuck in `AWAITING_FUNDING` (it can
  still be explicitly cancelled through the existing FSM). Phase 4D or a
  later UI pass should surface this state clearly rather than leaving a
  silently-stuck task.
- **A "corrected" authorization against a `CONSUMED` row creates a fresh,
  unchained `ACTIVE` row** (documented above) rather than being rejected
  outright — this is existing Phase 4B behavior, confirmed compatible with
  Phase 4C's invariants (never two tasks per authorization, never an
  ambiguous state) but not redesigned by this phase, since
  `budget-authorizations.ts` is unmodified.
- **No runtime spend metering or enforcement** — `usage_events` still only
  records after-the-fact usage; nothing compares live spend against
  `max_budget_minor` during execution.
- **No real payment rail** — `/fund`'s `payment_intents` insert remains the
  pre-existing `chain: "stub"` row from Phase 1.

## Phase 4D boundary (funding / runtime-spend enforcement)

To turn "activation gate" into "real money moved and metered," Phase 4D
would need to add, at minimum:

1. A real payment rail integration (Solana/eSewa/Khalti/bank) replacing the
   `chain: "stub"` `payment_intents` row `/fund` writes today, with genuine
   confirmation semantics before `AWAITING_FUNDING -> QUEUED` is allowed to
   fire.
2. Runtime spend metering: comparing `usage_events` accumulation against
   `tasks.max_budget_minor` *during* execution, not just recording it after
   the fact, with a real enforcement action (pause/fail/alert) when a task
   approaches or exceeds its authorized ceiling.
3. A decision on the "stuck in `AWAITING_FUNDING` after estimate revision"
   limitation above — likely either blocking further revision of an
   estimate once a task has been prepared from one of its authorizations, or
   an explicit UI/API path to re-derive a fresh authorization/task pair from
   the new estimate version.
4. Settlement, refunds, and dispute handling — entirely unbuilt, unscheduled
   by any phase through 4C.
