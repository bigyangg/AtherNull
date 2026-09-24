# Spike C service contract: AtherNull → OpenHands field mapping

This is the authoritative, field-by-field record of what the adapter server
(`adapter-server/src/mapping.ts`, `adapter-server/src/routes/`) does. Every
row was measured against a real request/response pair during this spike, not
inferred. See `README.md` for the narrative write-up and `metrics.json` for
the numeric summary.

## The endpoints

The plan scoped 4 endpoints, derived from
`spike-a-standalone-shell/upstream/src/mocks/conversation-handlers.ts`. Two
more turned out to be required in practice — discovered by actually running
the real (non-mock) frontend against the adapter and watching what broke.
All 6 are implemented, GET-only against AtherNull except where noted:

| Endpoint | In original plan? | Backed by | Notes |
|---|---|---|---|
| `GET /api/conversations/search` | Yes | `GET /v1/jobs` + `GET /v1/projects` | Sidebar/homepage conversation list |
| `GET /api/conversations/:id` | Yes | `GET /v1/jobs/:id` + `GET /v1/projects` | Single-conversation fetch by id |
| `GET /api/conversations` (plural, `ids[]=`) | **No** | `GET /v1/jobs/:id` × N + `GET /v1/projects` | **The actual endpoint the conversation-detail view uses** (`use-user-conversation.ts` calls `batchGetAppConversations`) — `GET /api/conversations/:id` above is implemented for contract completeness but the real click-through path never calls it. Missing this endpoint was the root cause of the smoke test's first failure: the detail route resolved `conversation: undefined`, which `routes/conversation.tsx` treats as "not found" and silently redirects back to `/conversations` with a toast. |
| `GET /api/conversations/:id/events/count` | Yes | `GET /v1/jobs/:id` + `GET /v1/jobs/:id/executions/:executionId/events` | Bare number |
| `GET /api/conversations/:id/events/search` | Yes | same as above | `{items, next_page_id}` |
| `GET /api/settings` | **No** | *(local stub, not AtherNull-backed)* | Required by the backend-registry health probe (`validateLocalBackend()`) before the app will show anything but a "Manage backends" recovery modal. Also read by `TelemetryConsentBanner`. |
| `PATCH /api/settings` | **No** | *(local stub, not AtherNull-backed)* | Required so the telemetry-consent modal's "Confirm preferences" button succeeds instead of 404ing and getting permanently stuck open over the sidebar. |
| `GET /server_info` | **No** | *(local stub, not AtherNull-backed)* | The other half of the health probe — asserts a minimum agent-server version. |

**Zero of these required editing any OpenHands source file.** The 3
undiscovered-until-runtime endpoints are all extra routes the adapter itself
had to grow — not changes to `spike-a-standalone-shell/upstream/`.

## AppConversation field mapping

Source: `Task`/`TaskDetail` (`GET /v1/jobs`, `GET /v1/jobs/:id`) +
`RepoProject` (`GET /v1/projects`) → `AppConversation`
(`agent-server-conversation-service.types.ts`).

| AppConversation field | AtherNull source | Mapping | Notes |
|---|---|---|---|
| `id` | `task.id` | direct — **superseded for `/search` by the Spike F note after this table** | The adapter treats one AtherNull **task** as one OpenHands **conversation** — a deliberate simplification. AtherNull's own `Execution.conversationId` (a real OpenHands conversation id, stamped by `POST /internal/executions/:id/conversation`, used by the real coding-agent worker) is *not* used as `AppConversation.id` here; using the task id instead means `GET /api/conversations/:id`/the batch endpoint can resolve directly from a task id with no reverse lookup. |
| `created_by_user_id` | *(none)* | stubbed `null` | Task rows carry `organizationId`/`projectId`/`agentProfileId`, not a "created by" user id. `projects.owner_user_id` is one hop away (not fetched here, to keep each read a single round trip) — an honest gap, not fetched-then-hidden. |
| `selected_repository` | `project.permittedRepository` | `"host/owner/repo"` → `"owner/repo"` (`splitRepository()`) | Only recognizes `github.com`/`gitlab.com`/`bitbucket.org` as hosts; anything else falls back to the raw string with `git_provider: null`. |
| `selected_branch` | `task.repositoryRevision` | direct | **Lossy**: AtherNull snapshots a *revision* (commit-ish string, e.g. `"abc123"`) at task creation (`0004_task_reproducibility_snapshot.sql`), not a branch name. It is surfaced as-is; in the real OpenHands UI this can read like a commit sha where a human expects a branch name. |
| `git_provider` | derived from `project.permittedRepository`'s host segment | `"github"` \| `"gitlab"` \| `"bitbucket"` \| `null` | See `selected_repository`. |
| `title` | `task.requirements` | direct | This is the field the smoke test asserts on — AtherNull's task objective string, shown verbatim as the conversation title. |
| `trigger` | *(none)* | stubbed `null` | AtherNull tasks have no "how was this created" trigger concept (`resolve`/`slack`/`api`/etc.). |
| `pr_number` | *(none)* | stubbed `[]` | No PR-linkage concept in AtherNull's task model. |
| `agent_kind` | *(constant)* | always `"openhands"` | Every AtherNull execution that runs an Agent Server conversation does so via OpenHands, never ACP (`internal.ts`'s `/conversation` endpoint). Not derived per-task because there is nothing per-task to derive it from — it is a fleet-wide constant in AtherNull today. |
| `tags` | *(none, task/`/search` only)* | *(not populated by `mapTaskToAppConversation`)* | **Spike F addition, `/search` only** — see the dedicated note after this table. `mapTaskToAppConversation()` (still used by `GET /api/conversations/:id` and the batch endpoint) does not set this field at all (left `undefined`, distinct from `mapExecutionToAppConversation()`'s populated `Record<string,string>`). |
| `llm_model` | `task.executions[0].resolvedModel` | direct (latest execution only) | `null` if the task has no executions yet (still `QUEUED`/`AWAITING_FUNDING`). **Spike F note:** `mapExecutionToAppConversation()` (used by `/search`) instead reads `execution.resolvedModel` directly off the specific execution being mapped, not `executions[0]` — see the note after this table. |
| `metrics` | *(none)* | stubbed `null` | **No AtherNull equivalent at all.** `MetricsSnapshot` (`accumulated_cost`, per-model `token_usage`, `context_window`) is Agent-Server-runtime telemetry, never persisted by `apps/api`. AtherNull's own `usage_events`/`budgetSpentMinor` exist but are shaped completely differently (a running spend total in minor currency units) — deliberately left `null` rather than force-fit an incompatible shape. |
| `created_at` / `updated_at` | `task.createdAt` / `task.updatedAt` | direct | |
| `execution_status` | `task.status` | `taskStatusToExecutionStatus()`, a 16→7 collapse (table below) | **Lossy, many-to-one.** AtherNull's task FSM and OpenHands' agent-loop status enum model different things (payment/lifecycle vs. live-agent-loop). |
| `conversation_url` | *(none)* | stubbed `null`, **always** | No live, browser-reachable sandbox exists for this read-only spike — the Agent Server container concept is entirely worker-process-internal. This field can never be populated by this adapter by construction. |
| `session_api_key` | *(none)* | stubbed `null`, **always, non-negotiable** | See "Security-critical stub" below. |
| `sandbox_id` | *(none)* | stubbed `null` | AtherNull's API surface has no sandbox/container concept at all — it's entirely inside the worker process, never exposed via `apps/api`. |
| `workspace` | *(none)* | stubbed `null` | No AtherNull equivalent surfaced via the read endpoints this adapter calls. |
| `sub_conversation_ids` | *(none)* | stubbed `[]` | AtherNull has no parent/child task relationship. |
| `public` | *(constant)* | always `false` | |

### `taskStatusToExecutionStatus` — the FSM collapse

| AtherNull `TaskStatus` | OpenHands `execution_status` |
|---|---|
| `CREATED`, `AWAITING_FUNDING`, `FUNDED`, `QUEUED` | `idle` |
| `RUNNING` | `running` |
| `VERIFYING`, `AWAITING_ACCEPTANCE`, `ACCEPTED`, `SETTLING`, `SETTLED`, `REFUNDING`, `REFUNDED` | `finished` |
| `FAILED`, `CANCELLED`, `REJECTED`, `DISPUTED` | `error` |

`paused`, `waiting_for_confirmation`, `stuck` (3 of OpenHands' 7 values) have
**no AtherNull source state that maps to them at all** — a live-agent-loop
concept AtherNull's payment/lifecycle FSM has no equivalent for.

## Spike F addition: one `AppConversation` per execution (`/search` only)

`GET /api/conversations/search` was changed from "one `AppConversation` per
AtherNull **task**" (`mapTaskToAppConversation()`, fed by bare `Task[]` from
`GET /v1/jobs`) to "one `AppConversation` per AtherNull **execution**"
(`mapExecutionToAppConversation()`, fed by each task's full `TaskDetail`,
`executions[]` included). This lets OpenHands' real, already-working
sidebar list every retry attempt as its own card — "attempt-switching for
free" — with zero OpenHands source changes.

- **`id`**: `execution.conversationId ?? execution.id` (the real id the
  coding-agent worker stamps via `POST /internal/executions/:id/conversation`,
  falling back to the execution's own id for an execution a worker claimed
  but hasn't stamped one for yet) — **not** `task.id`.
- **`title`**: `` `${task.requirements} (attempt ${n} of ${count})` `` — an
  attempt distinguisher is appended (via `computeAttemptInfo()`, ordering the
  task's executions by `createdAt`) because `task.requirements` alone would
  render N identical-looking sidebar cards for N attempts of the same task.
- **`llm_model`**: `execution.resolvedModel` directly off *this* execution,
  not `executions[0]` — each attempt can in principle have used a different
  routing tier/model.
- **`tags`** (new field, `Record<string,string>`, confirmed rendered as
  chips by `conversation-tag-chips.tsx`, gated by
  `conversation-panel-preferences-store.ts`'s `showTagsMetadata`, confirmed
  default `true`): built by `buildStatusTags()`.
  - `tags.status` is always present: the task's real, un-collapsed
    `TaskStatus` (e.g. `"SETTLED"`, `"VERIFYING"`) — this is now the place a
    human reads task state from in the sidebar, replacing the lossy 16→7
    `execution_status` collapse (still used for the enum field, unchanged,
    since OpenHands has no chip-friendly way to show 16 raw values there).
  - `tags.verification_outcome` (`"PASS"`/`"FAIL"`) is present **only** when
    a `verification_runs` row exists whose `execution_id` matches *this
    specific execution* — matched by id, not "the task's latest run" — so a
    failed-then-retried task's first (failed) attempt card does not
    incorrectly inherit the second attempt's later PASS outcome. Measured
    directly against Spike F's own seeded 2-attempt journey: attempt 1
    (`outcome:"failure"`, no verification run against it) shows only
    `{"status":"SETTLED"}`; attempt 2 (the one a `verification_runs` row's
    `execution_id` actually points at) shows
    `{"status":"SETTLED","verification_outcome":"PASS"}`.

**Fixed (was an honestly-recorded inconsistency in an earlier revision of
this spike):** `GET /api/conversations/:id` and the batch `GET
/api/conversations?ids[]=` endpoint initially were left unchanged when
`/search` switched to per-execution ids above, still calling
`mapTaskToAppConversation()` and resolving by **task id** only — passing one
of `/search`'s new execution-derived ids to either of them did not resolve
(`getTaskDetail()` called with a non-task id 404s internally), breaking
Spike C's own click-through-to-detail smoke test.

Both endpoints now share a single `resolveConversationById()` helper
(`routes/conversations.ts`) that tries execution-id resolution first —
reusing `routes/events.ts`'s exported `resolveExecutionOwner()`, the exact
same "which task owns this execution" scan `.../events` already used, rather
than a second, divergent lookup — and, only if that scan finds no owning
task, falls back to the original pre-Spike-F behavior: treat the id as a
task id directly and return a task-keyed `AppConversation` via
`mapTaskToAppConversation()` (`id = task.id`, no attempt suffix). This keeps
**both** id shapes working through the same two endpoints: an
execution-derived id (from `/search`, the real click-through path) resolves
to that specific attempt's `AppConversation`; a bare task id (e.g. Spike D's
hardcoded `NEXT_PUBLIC_CONVERSATION_ID`, seeded before `/search`'s
per-execution change and never updated) still resolves exactly as before.
Measured directly: `GET /api/conversations?ids[]=<a conversationId from
/search>` now returns that attempt's `AppConversation` (not `[null]`), and
`GET /api/conversations?ids[]=<a task id>` is unchanged from its original
task-keyed response.

## Spike F addition: `old_content`/`new_content`/`old_str`/`new_str`

Previously, `ActionEvent`/`ObservationEvent` mapping passed
`FileEditorAction`/`FileEditorObservation` payloads through close to
verbatim, without ever populating `old_content`/`new_content` (on the
observation) or `old_str`/`new_str` (on the in-flight action) — fields
OpenHands' own real, unmodified `file-editor.tsx`/`diff-view.tsx` visualizer
needs to render its hand-rolled diff instead of falling back to a plain-text
path. AtherNull's raw `FileEditorObservation` payload never carries these
directly (confirmed against both spikes' seed fixture shapes).

- **`ActionEvent.action.old_str`/`new_str`**: for a `FileEditorAction`,
  re-derived from the action's own payload via
  `extractFileEditorActionFields()` (same `typeof`-guarded extraction
  `apps/web/lib/execution-events.ts`'s `ParsedFileEdit` uses) rather than a
  blind object spread, so a malformed upstream value surfaces as an honest
  `null` instead of silently passing through.
- **`ObservationEvent.observation.old_content`/`new_content`**: reconstructed
  from the **paired** `ActionEvent`'s own `old_str`/`new_str`/`file_text`,
  looked up via `ObservationEvent.action_id` against a same-page
  `actionsById` map (mirroring `apps/web`'s `pairActionsWithObservations()`),
  since AtherNull's `ObservationEvent` payload has no before/after content of
  its own:
  - `str_replace`/`insert` (a `new_str` is present): `old_content` /
    `new_content` are the replaced **snippet**, not a whole-file
    before/after — AtherNull never persists a whole-file snapshot around an
    edit, so this is a documented, lossy-but-honest approximation, not a
    fabricated full-file diff.
  - `create` (no `new_str`, but a `file_text` is present): only
    `new_content` is set (from `file_text`); `old_content` is left absent so
    `file-editor.tsx`'s `old_content != null && new_content != null`
    diff-view gate correctly stays off, falling through to its own
    new-content-preferring plain path — the same as a real "create"
    observation would.
  - Measured directly against Spike F's own seeded journey: a `create` event
    for `/workspace/project/src/routes/metrics.ts` returns `new_content` set
    and no `old_content` key at all; a `str_replace` event for
    `/workspace/project/src/app.ts` returns both
    `old_content: "app.get('/status', statusHandler);"` and
    `new_content: "app.get('/status', statusHandler);\nmetricsRoute(app);"`.

## Spike F addition: `routes/events.ts` resolves by execution, not "latest"

Previously, both `.../events/count` and `.../events/search` always resolved
"the conversation's events" as `task.executions[0]`'s events (AtherNull
orders `TaskDetail.executions` newest-first) — correct only because `/search`
used to emit one `AppConversation` per **task**, so there was only ever one
conversation id per task to ask about. Now that `/search` emits one per
**execution**, the requested `:id` identifies a specific execution (via
`execution.conversationId ?? execution.id`, same as above), and "always
`executions[0]`" would silently return the wrong (latest) attempt's events
for every attempt except the newest one.

`routes/events.ts` now resolves the owning task first via
`resolveExecutionOwner()`: a **linear scan across the org's tasks** (`GET
/v1/jobs`, then one `GET /v1/jobs/:id` per task, matching each execution's
own `conversationId ?? id` against the requested id) before calling
AtherNull's real per-execution events endpoint (`GET
/v1/jobs/:taskId/executions/:executionId/events`, which needs the owning
task id, not just an execution id). This is `O(tasks)` extra reads per
`events` request — a **documented prototype-scale simplification**, fine at
1-2 seeded tasks; a production adapter would maintain an execution-id →
task-id index instead of scanning per request. Measured directly against
Spike F's 2-attempt seeded journey: attempt 1's conversation id resolves to
its own 4 events, attempt 2's conversation id resolves to its own (different)
9 events — not the same set for both, confirming the fix actually
distinguishes attempts rather than coincidentally still returning the latest
execution's events for every id.

**Follow-up fix (same phase):** the first version of `resolveExecutionOwner()`
had no fallback — a requested id that didn't match *any* execution's
`conversationId ?? id` (i.e. a **task id**, not an execution id) resolved to
zero events, silently breaking Spike D's `/harness-live` page, whose
`NEXT_PUBLIC_CONVERSATION_ID` is a task id by design (read from the original
`seed-output.json`, seeded before `/search` had any notion of per-execution
ids). Fixed by wrapping it in `resolveConversationTarget()`: try
`resolveExecutionOwner()` first, and if it finds no owning task, fall back to
`getTaskDetail(requestedId)` directly and use that task's own
`executions[0]` — the exact `executions[0]` behavior `.../events` used
*before* Spike F's per-execution change. `routes/conversations.ts`'s
`resolveConversationById()` (above) mirrors this same two-step
execution-id-then-task-id fallback shape, deliberately built on the same
exported `resolveExecutionOwner()` rather than a second scan.

## Scaling limitations introduced by Spike F (documented, not solved)

- **`/search`'s N+1 calls** (unchanged from the original note, restated
  here for completeness now that this endpoint's output shape changed too):
  one `GET /v1/jobs` + one `GET /v1/jobs/:id` per task. Fine at 1-2 seeded
  tasks; would need batching/caching at real scale.
- **`routes/events.ts`'s linear scan** (new in Spike F, see above): one
  `GET /v1/jobs` + one `GET /v1/jobs/:id` per task, per events request, to
  resolve which task owns a requested execution id. Same order of cost as
  `/search`, paid again on every events call instead of once per page load.
- Neither limitation is hidden behind a fake fast path — both are plain,
  visible loops in the adapter's own source, called out here so a reader of
  this contract doesn't have to rediscover them by reading `routes/*.ts`
  directly.

## Security-critical stub: `session_api_key`

`AppConversation.session_api_key` is **always** `null`, unconditionally, by
construction — there is no code path in `mapping.ts` that ever assigns it
anything else. This is the one field the adapter is constitutionally
forbidden from populating: it is the Agent Server credential concept
(`SESSION_API_KEY` in `workers/coding-agent`), and this spike's explicit
safety rule is that it must never be generated, read, or referenced
anywhere here. Confirmed absent from every file under `adapter-server/src/`
(no import of, or reference to, anything Agent-Server-credential-shaped).

## OpenHandsEvent field mapping

Source: `ExecutionEvent` rows (`GET /v1/jobs/:id/executions/:executionId/events`)
→ `OpenHandsEvent` union (`mapExecutionEventToOpenHandsEvent()` in
`mapping.ts`). AtherNull's raw wire shape (`{id, executionId, kind, payload,
occurredAt, createdAt}`) is unusually close to the target already — the
worker forwards the Agent Server SDK's own event body verbatim into
`payload` (`apps/api/src/routes/internal.ts`'s `/events` endpoint), so for
the 3 kinds this spike's seed data actually contains, this is mostly a
flatten-and-rename, not a real shape translation.

### `MessageEvent`

| Field | Source | Notes |
|---|---|---|
| `id`, `timestamp` | `event.id`, `event.occurredAt` | direct |
| `source` | `payload.source` | `"user"` → `"user"`, else `"agent"` |
| `llm_message`, `activated_skills`, `extended_content` | `payload.*` | passed through as-is — AtherNull's payload already carries these verbatim |
| `reasoning_content` | `payload.reasoning_content` | included only when present |

### `ActionEvent`

| Field | Source | Notes |
|---|---|---|
| `id`, `timestamp`, `action`, `tool_name` | `event.*` / `payload.*` | direct |
| `source` | *(constant)* | always `"agent"` (AtherNull doesn't persist a separate source for actions — they're always agent-originated) |
| `thought` | `payload.thought` | direct, defaults to `[]` |
| `reasoning_content` | `payload.reasoning_content` | direct or `null` |
| `thinking_blocks` | *(none)* | **stubbed `[]`**. Not present in this spike's seed content. In a real live execution these would be persisted verbatim (the worker forwards the SDK's own event body unmodified) — this is a limitation of this spike's own synthetic fixture content, not a structural gap in AtherNull's persistence. |
| `tool_call_id` | *(none)* | **stubbed** `` `stub-${event.id}` ``. Same fixture-content limitation as `thinking_blocks`. |
| `tool_call` | *(none)* | **stubbed**, a synthetic `{id, type: "function", function: {name, arguments: "{}"}}` built from the stubbed `tool_call_id` and the real `tool_name`. |
| `llm_response_id` | *(none)* | **stubbed**, reuses `event.id`. |
| `security_risk` | *(none)* | **stubbed**, always `"UNKNOWN"` (the SDK's own `SecurityRisk.UNKNOWN` value — an honest "we don't know," not a fabricated risk level). |

### `ObservationEvent`

| Field | Source | Notes |
|---|---|---|
| `id`, `timestamp`, `observation`, `action_id` | `event.*` / `payload.*` | direct |
| `source` | *(constant)* | always `"environment"` (required literal for this event type) |
| `tool_name` | derived from `payload.observation.kind` | `"TerminalObservation"` → `"terminal"`, `"FileEditorObservation"` → `"file_editor"`, else `"unknown"` — AtherNull's `ObservationEvent` payloads don't carry `tool_name` directly (confirmed against both Spike B's fixtures and this spike's own seed content), so it's reconstructed from the observation's own `kind` field, the same signal `apps/web/lib/execution-events.ts`'s own `parseToolCall()` uses. |
| `tool_call_id` | *(none)* | **stubbed**, `` `stub-${action_id}` `` when `action_id` is present (so it at least agrees with the paired action's own stub), else `` `stub-${event.id}` ``. |

### Unmapped event kinds

Any `ExecutionEvent.kind` other than `MessageEvent`/`ActionEvent`/
`ObservationEvent` is **dropped**, not fabricated into one of the three known
shapes — logged via `console.warn` on the adapter server and simply absent
from the returned page. This spike's own seed data never exercises this path
(all 9 seeded events are one of the three kinds), but the code path exists
for the other `OpenHandsEvent` union members (`CondensationEvent`,
`PauseEvent`, etc.) a real live execution could in principle produce.

## Pagination

Neither `GET /api/conversations/search` nor `.../events/search` implements
real cursor-based pagination against AtherNull. `next_page_id` is always
`null`. This is adequate for this spike's data volumes (1 conversation, 9
events) but is a known simplification, not hidden: `GET
/v1/jobs/:id/executions/:executionId/events` does accept AtherNull's own
`after=<ISO timestamp>` cursor param (`apps/api/src/routes/jobs.ts`), which a
production adapter would need to wire up to OpenHands' `timestamp__lt`/
`limit` query params.

## What a production version of this adapter would still need

Beyond what this spike measured:
- Real pagination (see above).
- A `created_by_user_id` fetch (one more read per task, from `projects.owner_user_id`).
- WebSocket/realtime support — explicitly out of scope, see `README.md`.
- Handling for AtherNull tasks belonging to multiple projects/orgs per adapter instance (this spike hard-codes one seeded org via `ATHERNULL_ORGANIZATION_ID`).
- ~~**(Spike F)** Reconciling `/search`'s execution-keyed ids with the still-task-keyed `GET /api/conversations/:id` and batch `GET /api/conversations?ids[]=` endpoints.~~ **Fixed** — both endpoints now accept either id shape via `resolveConversationById()` (see that section above).
- **(Spike F)** An execution-id → task-id index, to replace `routes/events.ts`'s (and now also `routes/conversations.ts`'s) linear scan (see above) with a direct lookup — still an open scaling item, not attempted here.
