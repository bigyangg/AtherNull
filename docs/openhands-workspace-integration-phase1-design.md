# AtherNull Workspace Integration v1 — Phase 1 design

Companion to [ADR-0006](adr/0006-openhands-workspace-frontend.md). This
document is the production contract that must exist before any UI
migration. It does not migrate `apps/web`, does not touch Solana/payment
logic, and does not change deployment flows. It is a design artifact, not
an implementation — see "Migration risks" for what's still unresolved.

`prototypes/openhands-integration/docs/prototype-study/` is unrelated,
untracked, and left untouched by this document.

## 1. Production auth/execution contract audit

Read directly from source this session, not assumed.

### Session/authorization helpers (`apps/api/src/session.ts`)

- `requireSession(request)` — validates the Better Auth cookie session only
  (`auth.api.getSession`). Throws 401 if absent. Returns `{userId,
  organizationId}`.
- `requireOrgSession(request)` — calls `requireSession`, then throws 403 if
  no active organization, then **re-queries membership live**
  (`auth.api.getActiveMember`) rather than trusting the session cache — this
  catches a user removed from an org mid-session. Returns `{userId,
  organizationId, role}`.
- `requirePrivilegedRole(role)` — throws 403 unless `role` is `"owner"` or
  `"admin"`. Must be called after `requireOrgSession`, never as a
  substitute for it.

### Per-endpoint authorization today (`apps/api/src/routes/jobs.ts`)

| Endpoint | Check | Level |
|---|---|---|
| `POST /v1/jobs/estimate` | `requireOrgSession` | member |
| `POST /v1/jobs` | `requireOrgSession` | member |
| `GET /v1/jobs` | `requireOrgSession` | member |
| `GET /v1/jobs/:id` | `requireOrgSession` | member |
| `GET /v1/jobs/:id/executions/:executionId/events` | `requireOrgSession` | member |
| `POST /v1/jobs/:id/fund` | `requireOrgSession` + `requirePrivilegedRole` | owner/admin |
| `POST /v1/jobs/:id/verify` | `requireOrgSession` + `requirePrivilegedRole` | owner/admin |
| `POST /v1/jobs/:id/accept` | `requireOrgSession` + `requirePrivilegedRole` | owner/admin |
| `POST /v1/jobs/:id/reject` | `requireOrgSession` + `requirePrivilegedRole` | owner/admin |

**Every read a compatibility layer would need already exists at member
level.** No new privilege tier is needed for a read-only OpenHands-facing
surface.

### App structure and cross-origin model (`apps/api/src/app.ts`, `apps/web/proxy.ts`)

- `apps/api` and `apps/web` are **cross-origin** (different origins), not
  same-origin-proxied. `apps/web/proxy.ts` is Next.js middleware for page
  navigation/sign-in redirects only — it explicitly excludes `/api/*` from
  its matcher and never forwards requests to `apps/api`.
- `apps/api/src/app.ts` registers `@fastify/cors` with `origin:
  trustedOrigins` (parsed from `TRUSTED_ORIGINS`, falling back to
  `WEB_APP_URL`) and `credentials: true` — an explicit allowlist, not a
  wildcard (wildcard is incompatible with `credentials: true` anyway).
  **Consequence: a browser-side OpenHands frontend can call `apps/api`
  cross-origin with the real session cookie today, as soon as its origin is
  added to `TRUSTED_ORIGINS` and its fetches use `credentials: "include"`.**
  No same-origin proxy needs to be built for this to work.
- Route groups are registered as Fastify plugins in `app.ts`
  (`projectRoutes`, `jobRoutes`, `agentProfileRoutes`, `usageRoutes`,
  `internalRoutes`), each defining its own literal paths (`/v1/...` for
  session-scoped routes, `/internal/...` for the worker-only,
  `INTERNAL_API_TOKEN`-gated routes). A new compatibility route group
  follows this exact pattern.

### Better Auth cookie attributes and intended hostnames (`apps/api/src/auth.ts`, installed `better-auth@1.7.5`)

Read directly from `auth.ts` and the installed package, not assumed:

- `advanced.useSecureCookies: process.env.NODE_ENV === "production"` — the
  `Secure` flag is off outside production.
- `advanced.crossSubDomainCookies` is only enabled, with `domain:
  process.env.COOKIE_DOMAIN`, when `COOKIE_DOMAIN` is set. Unset in local
  dev today.
- **`SameSite` is not configured anywhere in this codebase.** The installed
  `better-auth` package hardcodes `sameSite: "lax"` in its cookie-creation
  code (`node_modules/better-auth/dist/cookies/index.mjs`) unless overridden
  via `advanced.cookies`/`advanced.defaultCookieAttributes` — neither is
  used here. No code path produces `SameSite=None`.
- **Intended production hostnames, found in this repo**:
  `app.athernull.io` (web) and `api.athernull.io` (API) — stated
  identically in `auth.ts` and `apps/api/.env.example`. No other topology is
  documented anywhere in `docs/`, ADRs, or `PLAN.md`.

**What this actually means for the design in §2 — corrected in Phase 2 by
live-frontend evidence, superseding the paragraph below's original
same-site-is-sufficient conclusion.** `SameSite=Lax` alone permits a cookie
on a cross-**origin** fetch/XHR as long as the calling page and the request
target are the same **site** (same registrable domain) — which
`app.athernull.io` calling `api.athernull.io` would satisfy on the
`SameSite` rule in isolation. **But `SameSite` only controls whether a
cookie the browser already intends to attach is allowed through — it does
not make the browser attach a cross-origin request's cookies at all.**
That is `fetch`'s own `credentials` mode, which defaults to
`"same-origin"` and must be explicitly set to `"include"` by the calling
code for a cross-origin request to carry the cookie in the first place.
Phase 2's live-verification pass read the pinned OpenHands frontend's own
compiled HTTP client (`@openhands/typescript-client`'s `http-client.js`)
directly and found that for a `kind: "local"` backend — the only kind this
integration uses — **no call site in the local-backend request path
(`getAgentServerClientOptions` → `SettingsClient`/`ServerClient`/
`ConversationClient`) ever passes `credentials: "include"`**;
`authMode: "cookie"` exists only for `kind: "cloud"` backends, a separate
code path (`callCloudProxy`) this integration does not use. Confirmed
empirically: serving the frontend and `apps/api` on different ports of the
same host (a same-site, different-origin arrangement) left every
authenticated call 401ing, with requests visibly missing the session
cookie, even though CORS and `SameSite=Lax` both permitted it in principle.
**Conclusion: same-site is necessary but not sufficient for this pinned
frontend build. Production must serve the OpenHands frontend and `apps/api`
from the same browser origin** (a reverse proxy in front of both, or
literally the same origin) so the request is same-origin and `fetch`'s
default `"same-origin"` credentials mode already attaches the cookie
without relying on the frontend ever opting in to `"include"`. A
same-origin reverse proxy was built and verified for Phase 2's own
verification harness (test-only, not part of any shipped code) and is the
recommended production shape; deliberately changing the pinned frontend's
own HTTP client to pass `credentials: "include"` for local-kind backends
would be an alternative, but that is a frontend source change, explicitly
out of scope for this phase, and not evaluated further here.
`COOKIE_DOMAIN`/`crossSubDomainCookies` remains unnecessary either way,
since the cookie is `httpOnly` and this call pattern needs it visible only
to the browser's own network stack, not to JavaScript. No auth
configuration is changed in this phase, and neither Better Auth nor the
OpenHands frontend's source was modified to make this finding.

### `executions.conversation_id` (`packages/database/src/schema.ts`, `internal.ts`)

- Column: `conversation_id: string | null`, nullable `text`, no default, no
  uniqueness constraint (migration `0006_execution_conversation_id.sql`).
- Set once, at execution start, by the worker calling `POST
  /internal/executions/:id/conversation` (`_report_conversation_id` in
  `agent_server_adapter.py`, called right after the OpenHands SDK's
  `Conversation` object is constructed, before `.run()`).
- **Can be null for an otherwise-complete execution**: the handler only
  logs a failure on a non-200 response and does not retry or block
  `.run()`. Any identity-resolution logic must treat null as an expected,
  not exceptional, case.
- No uniqueness enforcement anywhere in the codebase today.
- **Duplicate check performed this session** (read-only `SELECT`, no
  migration): `athernull_dev` has 23 `executions` rows, 4 with a non-null
  `conversation_id`, and all 4 are distinct (0 duplicate groups).
  `athernull_test` has 34 rows, 0 with a non-null `conversation_id` (the
  test suite never calls the conversation-report endpoint). **No production
  database exists yet** — this confirms no duplicates exist in the only
  data currently available, which is a small dev/prototype dataset, not
  evidence that duplicates are impossible at production scale. The
  proposed partial unique index (§5) remains a recommendation for before
  real traffic, not something this check clears as unnecessary.

### Agent Server credential boundary (`workers/coding-agent/src/coding_agent/agent_server_adapter.py`, ADR-0005)

- `SESSION_API_KEY` is `secrets.token_hex(32)`, generated fresh per
  execution, set only as the worker process's own env var (auto-forwarded
  into the execution's Docker container) and as `docker_workspace.api_key`
  for the SDK's outbound calls. Cleared in a `finally` block at the end of
  the dispatch.
- **Confirmed: it never reaches `apps/api`, the database, or the browser.**
  No `/internal/*` request body or response, and no `executions`/
  `execution_events` column, carries this value. This must remain true —
  any production compatibility layer design that would require this key to
  cross into `apps/api` or the browser is disqualified by construction.

### Event ingestion (push, not poll)

Agent Server (in-container) → SDK `RemoteConversation` WebSocket →
`EventForwarder` callback → buffers → flushes to `POST
/internal/executions/:id/events` on a 20-event batch or a 1-second timer,
whichever first — plus a one-off WebSocket-based resync pass after `.run()`
completes, for gap recovery, deduplicated by `ON CONFLICT (id) DO NOTHING`.
All `/internal/*` routes require `Bearer <INTERNAL_API_TOKEN>`, a static
shared secret distinct from and unrelated to the per-execution
`SESSION_API_KEY`.

### Current Phase 2 workspace read pattern (`apps/web/lib/hooks/use-execution-events.ts`)

`refetchInterval: active ? 2000 : false`; query key is `["execution-events",
taskId, executionId]`; each poll **re-fetches and replaces the full
snapshot** (no incremental `after` cursor in the current code — this
supersedes an earlier report that described cursor-based incremental
polling; verify current behavior against source, not that earlier note, if
this ever needs to be re-confirmed).

## 2. Production request/data-flow diagram

```
Authenticated browser (OpenHands frontend, served from an AtherNull-
controlled origin, added to TRUSTED_ORIGINS)
    |
    | fetch(..., { credentials: "include" })  -- real Better Auth session cookie
    v
apps/api  (NEW route group, e.g. routes/openhands-compat.ts,
           registered in app.ts exactly like jobRoutes/projectRoutes)
    |
    | requireOrgSession(request)  -- same helper every other route uses
    |   -> throws 401/403 exactly as today if session/membership invalid
    v
Authorization check passes: { userId, organizationId, role }
    |
    | resolve execution attempt, ORG-SCOPED
    |   (reuse existing job/execution queries -- already filter by
    |    organization_id; never a cross-org lookup)
    v
Execution row  { id, task_id, conversation_id, status via task, ... }
    |
    | resolve OpenHands conversation identity (see identity contract below)
    v
Return OpenHands-shaped response (AppConversation / OpenHandsEvent[])
    |
    v
Browser renders via OpenHands' own, unmodified components


-- Separate, unrelated credential path (worker, not browser) --

Agent Server (in container)
    |  SDK WebSocket, authenticated by per-execution SESSION_API_KEY
    v
Worker (agent_server_adapter.py)
    |  Bearer INTERNAL_API_TOKEN (static shared secret, worker-only)
    v
apps/api  /internal/executions/:id/{conversation,events,complete,...}
    |
    v
Postgres (executions, execution_events)
```

The two paths never intersect: the browser path is per-request,
per-customer, cookie-authenticated; the worker path is a static shared
secret with no per-user identity at all. Nothing in this design routes
browser traffic through `/internal/*`, and nothing gives the browser or the
new compat routes any reason to know `SESSION_API_KEY` exists.

## 3. Canonical identity contract

| Field | Source | Notes |
|---|---|---|
| Task ID | `tasks.id` | Org-scoped via the owning project; stable for the task's lifetime. |
| Execution ID | `executions.id` | One row per attempt. `MAX_EXECUTION_ATTEMPTS` (currently 3, `apps/api/src/routes/internal.ts`) caps automatic retries on a `"failure"` completion outcome. |
| Conversation ID | `executions.conversation_id` | **Primary key for the OpenHands-facing identity.** Nullable; set once by the worker at execution start. |
| Organization ID | `tasks` → `projects.organization_id` (existing join) | All resolution must filter on the caller's session `organizationId` — never accept a bare id without this filter. |

**Resolution rule** (primary): given a requested conversation id, first try
to find the execution whose `conversation_id` matches, scoped to the
caller's organization. **Fallback rule** (backward compatibility,
explicitly temporary): if no execution matches, try resolving the id as a
task id instead (scoped to the same organization), and use that task's
most recent execution. This mirrors the dual-resolution fix already proven
in the prototype (`spike-c-full-shell-adapter`, Spike F) — same design,
reimplemented against real, authenticated, org-scoped queries rather than
the prototype's single-session adapter. **Do not remove the task-id
fallback in this phase** — existing prototype/test data and any
not-yet-migrated caller may still depend on it.

**The resolver must make its own resolution path observable, not just
correct.** The function must return (or log) which branch actually
resolved the request — e.g. a `resolutionMethod: "conversation_id" |
"task_id_fallback"` value alongside its result — so fallback usage can be
measured (a metric/log field, not a silent internal branch) and the
fallback's actual usage rate is known before anyone decides to remove it.
Without this, "not removed yet" has no way to become "safe to remove
later."

**Retry/attempt behavior**: each retry is a new `executions` row with its
own `id` and (once the worker reports it) its own `conversation_id` — never
a reused conversation id across attempts. A task with 0 executions (still
`AWAITING_FUNDING`/`QUEUED`) has no resolvable conversation yet; the compat
layer must return an explicit empty/not-yet-started state, not a 404 that
could be confused with "wrong organization" or "doesn't exist."

**Ownership rule**: every resolution step is scoped by the session's
`organizationId`, obtained fresh from `requireOrgSession` on every request
— never cached across requests, never passed as a client-supplied
parameter.

## 4. Endpoint compatibility matrix

**Corrected inventory.** The prototype's own `metrics.json` claimed
`total_implemented: 6` while its own arrays listed 8 entries — an
unreconciled internal error, not a real count. Re-reading the adapter's
actual registered routes this session found **8 distinct OpenHands-facing
(method, path) pairs**, confirmed against the real, non-mock browser
evidence recorded in Spike C's `metrics.json`/`README.md` (plus a 9th,
`GET /health`, which is the adapter's own operational liveness probe, not
part of OpenHands' contract, and excluded from this table).

Each is categorized by the actual evidence tier: **required (proven)** —
the real browser test failed without it, with a quoted symptom;
**required (probe)** — necessary for the app to render at all, but it's a
capability/health check, not conversation data; **compatibility stub** — a
local-only implementation detail that never touches AtherNull; or
**unnecessary (kept for completeness)** — implemented, but not observed on
the actual exercised code path, with no failure evidence for its necessity.

| OpenHands-facing endpoint | Category | Evidence | AtherNull source | Auth | Org scope | Identity resolution | R/W |
|---|---|---|---|---|---|---|---|
| `GET /api/conversations/search` | Required (proven) | In original plan; is the conversation-list/sidebar's real data source, exercised throughout Spikes C–F | `tasks` + `executions` (list, org-scoped) | member | yes | emits one entry per execution | read |
| `GET /api/conversations?ids[]=` (batch) | Required (proven) | Missing it made `useActiveConversation()` resolve `undefined`, silently bouncing the user back to the conversation list — the actual conversation-detail data source, not the singular endpoint below | same, batch | member | yes | dual (conversation-id then task-id fallback) | read |
| `GET /api/conversations/:id` (singular) | **Required (proven)** — recategorized in Phase 2 | Originally implemented, kept off this phase's initial build per this document's earlier "no failure evidence" note; Phase 2's live-frontend verification against the real pinned build then observed one real call to this exact endpoint during conversation-detail navigation, contradicting that earlier conclusion. Implemented, tested, and reverified against the real frontend (the previously-observed 404 no longer occurs). | same, single | member | yes | dual | read |
| `GET /api/conversations/:id/events/count` | Required (proven) | In original plan; part of the conversation-detail load sequence exercised throughout | `execution_events` count for the resolved execution | member | yes | dual | read |
| `GET /api/conversations/:id/events/search` | Required (proven) | In original plan; the core event feed, exercised in every spike | `execution_events` for the resolved execution | member | yes | dual | read (full re-fetch each call, matching current `use-execution-events.ts` behavior — no incremental cursor claimed) |
| `GET /api/settings` | Required (probe) | Gates the *entire app* behind a "Manage backends" modal if missing or wrong-shaped — proven by observed failure, not just present in mocks | backend-registry health/capability descriptor, no AtherNull business data | member | n/a | n/a | read |
| `GET /server_info` | Required (probe) | "The other half of `validateLocalBackend()`'s health probe" — asserts a minimum agent-server version; app doesn't render without it | same health-probe family | member | n/a | n/a | read |
| `PATCH /api/settings` | Required (proven), implemented as compatibility stub | Needed so the telemetry-consent modal's confirm button succeeds instead of 404ing and getting stuck open; the prototype's own source comment confirms it is "never forwarded anywhere — purely a local adapter-side stub" | none — local-only, no AtherNull data or mutation | member | n/a | n/a | write (local-only) |

No endpoint in this table requires `owner`/`admin` privilege — every one is
satisfied by the existing member-level `requireOrgSession` check. Nothing
here needs the Agent Server, `SESSION_API_KEY`, or a live container. All 8
endpoints in this table, including the singular `GET
/api/conversations/:id`, are implemented in the production compat layer —
see the endpoint-inventory note above on why that one was added after
initial evidence suggested it could be omitted.

### Exact typed status/verification transport

The prototype used a free-form string tag with no schema. Production must
use a strict, versioned, parseable format instead — still riding on
`AppConversation.tags: string[]` (the only OpenHands field confirmed to
render arbitrary AtherNull-originated values as chips; there is no generic
structured-metadata field available), but with a defined grammar rather
than ad hoc text:

```typescript
// packages/contracts — proposed, not yet implemented
type AtherNullStatusTag = `athernull:task-status:${TaskStatus}`;
type AtherNullVerificationTag = `athernull:verification:${"PASS" | "FAIL"}`;

function parseAtherNullTags(tags: string[]): {
  taskStatus: TaskStatus | null;
  verificationOutcome: "PASS" | "FAIL" | null;
} {
  // Strict prefix match against the two grammars above; anything else is
  // ignored (may be a genuine OpenHands-native tag, not an error).
  // TaskStatus values are exactly packages/contracts/src/tasks.ts's enum —
  // an unrecognized suffix is a parse failure to be logged, not silently
  // coerced to a guessed status.
}
```

A conversation carries at most one `athernull:task-status:*` tag (the
task's current real status) and at most one `athernull:verification:*` tag
(present only once a verification run exists). This replaces every
reference to "a lossy string tag" elsewhere in this document and in
ADR-0006 — the representation is exact and round-trippable, even though the
transport mechanism (a tags array OpenHands' own UI treats generically)
is unchanged from the prototype's approach.

**Status/verification representation** (supersedes the prototype's ad hoc
string tag): the compat layer must expose the task's real status enum value
(`CREATED, AWAITING_FUNDING, FUNDED, QUEUED, RUNNING, VERIFYING,
AWAITING_ACCEPTANCE, ACCEPTED, SETTLING, SETTLED, FAILED, CANCELLED,
REJECTED, DISPUTED, REFUNDING, REFUNDED` — `packages/contracts/src/tasks.ts`)
and the latest verification outcome (`PASS`/`FAIL`, from `verificationRuns`)
through whatever OpenHands-native field is used to carry it, but that value
must be the real enum string, not a lossy collapse — a client reading it
must be able to reconstruct the real state, even if OpenHands' own UI only
renders it as a generic chip.

## 5. Proposed file-level implementation plan (Phase 2 — not built in this phase)

- `apps/api/src/routes/openhands-compat.ts` (new) — the route group above,
  registered in `apps/api/src/app.ts` alongside the existing five, using
  `requireOrgSession` exactly like `jobRoutes`. Internally reuses the
  existing job/execution query functions rather than writing new SQL.
- `apps/api/src/app.ts` — one new `app.register(openhandsCompatRoutes)`
  line.
- `packages/contracts/src/` — a new module defining the compat response
  shapes (`AppConversation`-equivalent, `OpenHandsEvent`-equivalent), if
  this codebase's convention of centralizing wire contracts there is
  followed (consistent with how `jobs.ts` contracts already live in
  `packages/contracts`).
- Environment/config: `TRUSTED_ORIGINS` gains whatever origin the
  production OpenHands frontend is served from.
- `packages/database/migrations/000N_execution_conversation_id_index.sql`
  (proposed, not required to ship) — a partial unique index on
  `conversation_id` where it's non-null, to make the "never reused across
  executions" assumption enforced rather than merely observed.
- `apps/web` — **no changes in this phase.** Hosting/serving the OpenHands
  frontend itself (a separate Vite/React Router app) alongside or instead
  of parts of `apps/web` is a Phase 2+ decision, out of scope here.
- No changes to `workers/coding-agent`, Solana/payment code, or deployment
  configuration.

## 6. Migration risks

- **Live-execution streaming is unresolved.** This phase covers historical/
  finished-execution review only. A `RUNNING` execution's live terminal/
  streaming UX needs a secure browser↔Agent-Server path that does not
  expose `SESSION_API_KEY` — not designed here, flagged in ADR-0006 as
  separate future work.
- **`conversation_id` nullability**: a worker failing to report its
  conversation id leaves that execution permanently without one under
  today's code (no retry). The task-id fallback covers this for display
  purposes, but it silently returns "the task's latest execution" rather
  than the specific one requested — acceptable as a documented, temporary
  compromise, not as a permanent contract. This is exactly why the fallback
  must be observable (§3) rather than silent.
- **No uniqueness enforcement on `conversation_id`** — nothing today
  prevents two executions from ending up with the same value (e.g. a worker
  bug re-reporting an old id). A direct query this session found zero
  duplicates in the only data that currently exists (23 dev rows, 4
  non-null, all distinct) — reassuring but not conclusive, since no
  production database exists yet. The dual-resolution logic should pick the
  most recently created match if this ever occurs, this should be
  monitored (not assumed impossible), and the proposed partial unique index
  (§5) should land before real traffic.
- **Cookie topology is a hard hosting constraint, stronger than originally
  stated here — corrected in Phase 2**: this document originally concluded
  same-site hosting (`app.athernull.io` calling `api.athernull.io`) was
  sufficient, because `SameSite=Lax` (hardcoded in the installed
  `better-auth` version, no override present) permits the cookie on a
  same-site cross-origin request. Phase 2's live-frontend verification
  found that conclusion incomplete: the pinned OpenHands frontend's own
  compiled HTTP client never sets `credentials: "include"` on its
  local-backend request path, so the browser never attaches the cookie to a
  cross-origin request in the first place, regardless of what `SameSite`
  would otherwise allow — confirmed empirically (401s with the cookie
  visibly absent from the request, serving frontend and API on different
  ports of the same host). **Same-site is not sufficient; production must
  serve the OpenHands frontend and `apps/api` from the same browser origin**
  (normally a reverse proxy in front of both), so the request is
  same-origin and the browser's own default credentials behavior attaches
  the cookie without the frontend needing to opt in. This must be enforced
  as a hosting decision before this design is implemented, not discovered
  in production. A deliberate future change to the frontend's own HTTP
  client to request `credentials: "include"` is a possible alternative but
  is a frontend source change, out of scope for this phase.
- **Query pattern at scale**: the prototype's linear-scan lookup does not
  belong in production. The real implementation must use an indexed,
  org-scoped query (`WHERE conversation_id = ? AND organization_id = ?`),
  which requires the join path from `executions` → `tasks` → `projects` →
  `organization_id` to be expressed as a real SQL query, not an in-memory
  scan over a fetched list.
- **CORS allowlist maintenance**: adding a new trusted origin is a
  deployment-config change with real security weight — it must go through
  the same review a production credentials change would, not be treated as
  routine.
- **ADR-0005's residual gap** (Docker container port publishing to all
  interfaces, not yet fixed) is unrelated to this phase's read-only design
  but becomes more urgent once a browser-facing live-streaming path is
  eventually designed, since that path will need to reason about the same
  container network boundary.
- **Upstream OpenHands version drift**: this design assumes the same pinned
  commit's REST contract (the 8 endpoints in §4, confirmed by running the
  real app, not by reading its mocks module). Upgrading the pinned commit
  requires re-verifying this contract, the same way Spike C's own
  verification did — not assuming it's stable.
