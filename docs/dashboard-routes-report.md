# Dashboard routes — current state (2026-09-21)

Snapshot of what the customer-facing dashboard (`apps/web`) actually renders and calls today,
against what the backend (`apps/api`) actually offers. Written to ground the next round of
dashboard work — not a design doc, just "what's really there."

There is no `apps/web/app/dashboard/` route. "The dashboard" is the project/task pages under
`apps/web/app/projects/`.

## 1. Frontend pages

| Route (URL) | File | Fetches |
|---|---|---|
| `/projects` | `apps/web/app/projects/page.tsx` | `useRepoProjects()` → `GET /v1/projects` |
| `/projects/new/import` | `apps/web/app/projects/new/import/page.tsx` | Hosts `<NewRepoProjectForm>` (create project → first task) |
| `/projects/[projectId]` | `apps/web/app/projects/[projectId]/page.tsx` | `useRepoProjects()` + `useTasks(projectId)` → `GET /v1/projects`, `GET /v1/jobs` (filtered client-side) |
| `/projects/[projectId]/tasks/[taskId]` | `apps/web/app/projects/[projectId]/tasks/[taskId]/page.tsx` | `useTask(taskId)` → `GET /v1/jobs/:id`, polls every 4s while `isTaskActive(status)` |

All four are client components (`"use client"`), all data access goes through React Query hooks
(`apps/web/lib/hooks/`) over `dashboardApi` (`apps/web/lib/api/index.ts` → `liveApi`,
`apps/web/lib/api/live.ts`).

## 2. Backend routes that exist vs. what the frontend calls

`apps/api/src/routes/jobs.ts` — full route list:

| Route | Line | Called by frontend? |
|---|---|---|
| `POST /v1/jobs/estimate` | 37 | **No** |
| `POST /v1/jobs` | 72 | Yes — `AddTaskForm` → `createTask` |
| `POST /v1/jobs/:id/fund` | 151 | Yes — `AddTaskForm` calls it immediately after `createTask` |
| `POST /v1/jobs/:id/verify` | 232 | **No** |
| `POST /v1/jobs/:id/accept` | 312 | **No** |
| `POST /v1/jobs/:id/reject` | 381 | **No** |
| `GET /v1/jobs` | 449 | Yes — `useTasks` |
| `GET /v1/jobs/:id` | 465 | Yes — `useTask` |

Also used: `GET /v1/agent-profiles` (`apps/api/src/routes/agent-profiles.ts:7`), `POST`/`GET
/v1/projects` (`apps/api/src/routes/projects.ts:14,42`).

`apps/web/lib/api/live.ts`'s `liveApi` (the only implementation of `TaskDashboardApi`,
`apps/web/lib/api/types.ts:46`) implements exactly seven methods: `listRepoProjects`,
`createRepoProject`, `listAgentProfiles`, `listTasks`, `createTask`, `fundTask`, `getTask`. There is
no `estimateTask`, `verifyTask`, `acceptTask`, or `rejectTask` — confirmed by grep across
`apps/web` for `estimate|verify|/accept|/reject`: every hit is `acceptanceCriteria` or unrelated
auth/marketing copy.

**Net: three of the seven task-lifecycle endpoints have no frontend caller at all, and the fourth
(`estimate`) was never wired into the create-task form either — `AddTaskForm` creates and funds a
task in one step with no cost preview.**

## 3. Data model gaps

`GET /v1/jobs/:id` returns `verificationRuns` (added alongside the `verify` endpoint), but
`apps/web/lib/api/live.ts`'s `RawTaskDetail`/`toTask` mapping (lines 82-85, 117-132) and the
`TaskDetail` type (`apps/web/lib/types.ts:143-146`) don't read it — a verification outcome is
already in the API response and is silently dropped before it reaches any component.

`TASK_STATUS_DISPLAY` (`apps/web/lib/types.ts:23-43`) already has a label/tone for all 16
`TaskStatus` values, including `AWAITING_ACCEPTANCE` ("Needs your review") and `VERIFYING`
("Verifying") — the badge renders correctly for every status the backend can produce. What's
missing is anything to *do* when a task is sitting in `AWAITING_ACCEPTANCE`.

## 4. UI states already handled

- Loading: yes, on both `/projects/[projectId]` and the task-status page.
- Empty (no projects / no tasks / no executions): yes, `ExecutionList` has its own empty state
  (`apps/web/components/tasks/execution-list.tsx:18-24`).
- Error: task-status page has one (`isError || !task` → "Task not found",
  `apps/web/app/projects/[projectId]/tasks/[taskId]/page.tsx:23-29`); the project-detail page does
  not distinguish a fetch failure from "no data yet."

## 5. Conventions already in place (reuse, don't reinvent)

- Data fetching: `@tanstack/react-query` via `apps/web/lib/query-provider.tsx`, one hook per query
  under `apps/web/lib/hooks/`.
- API access: a single `apiFetch<T>()` wrapper (`apps/web/lib/api/live.ts:10-33`) —
  `credentials: "include"` for the Better Auth session cookie, throws `Error(body.error)` on
  non-2xx.
- UI: shadcn/ui-style primitives under `apps/web/components/ui/` (`Badge`, `Separator`, Radix
  progress/tabs), `lucide-react` icons, Tailwind v4. No chart library, no SWR, no separate HTTP
  client.
- Status → color mapping centralized in `apps/web/lib/types.ts` (`TASK_STATUS_DISPLAY`,
  `isTaskActive`) — the single source of truth the polling logic and the badge both already read
  from.
