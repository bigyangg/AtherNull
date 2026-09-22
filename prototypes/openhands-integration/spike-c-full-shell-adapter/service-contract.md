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
| `id` | `task.id` | direct | The adapter treats one AtherNull **task** as one OpenHands **conversation** — a deliberate simplification. AtherNull's own `Execution.conversationId` (a real OpenHands conversation id, stamped by `POST /internal/executions/:id/conversation`, used by the real coding-agent worker) is *not* used as `AppConversation.id` here; using the task id instead means `GET /api/conversations/:id`/the batch endpoint can resolve directly from a task id with no reverse lookup. |
| `created_by_user_id` | *(none)* | stubbed `null` | Task rows carry `organizationId`/`projectId`/`agentProfileId`, not a "created by" user id. `projects.owner_user_id` is one hop away (not fetched here, to keep each read a single round trip) — an honest gap, not fetched-then-hidden. |
| `selected_repository` | `project.permittedRepository` | `"host/owner/repo"` → `"owner/repo"` (`splitRepository()`) | Only recognizes `github.com`/`gitlab.com`/`bitbucket.org` as hosts; anything else falls back to the raw string with `git_provider: null`. |
| `selected_branch` | `task.repositoryRevision` | direct | **Lossy**: AtherNull snapshots a *revision* (commit-ish string, e.g. `"abc123"`) at task creation (`0004_task_reproducibility_snapshot.sql`), not a branch name. It is surfaced as-is; in the real OpenHands UI this can read like a commit sha where a human expects a branch name. |
| `git_provider` | derived from `project.permittedRepository`'s host segment | `"github"` \| `"gitlab"` \| `"bitbucket"` \| `null` | See `selected_repository`. |
| `title` | `task.requirements` | direct | This is the field the smoke test asserts on — AtherNull's task objective string, shown verbatim as the conversation title. |
| `trigger` | *(none)* | stubbed `null` | AtherNull tasks have no "how was this created" trigger concept (`resolve`/`slack`/`api`/etc.). |
| `pr_number` | *(none)* | stubbed `[]` | No PR-linkage concept in AtherNull's task model. |
| `agent_kind` | *(constant)* | always `"openhands"` | Every AtherNull execution that runs an Agent Server conversation does so via OpenHands, never ACP (`internal.ts`'s `/conversation` endpoint). Not derived per-task because there is nothing per-task to derive it from — it is a fleet-wide constant in AtherNull today. |
| `llm_model` | `task.executions[0].resolvedModel` | direct (latest execution only) | `null` if the task has no executions yet (still `QUEUED`/`AWAITING_FUNDING`). |
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
