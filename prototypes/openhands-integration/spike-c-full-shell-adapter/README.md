# Spike C: Full-shell adaptation cost (real AtherNull data)

Goal: using Spike A's already-working standalone OpenHands shell
(`spike-a-standalone-shell/upstream/`), test a minimal AtherNull
compatibility adapter — can its homepage, sidebar, and conversation-detail
view display real, organization-scoped AtherNull data, without replacing
AtherNull's task lifecycle or exposing Agent Server credentials to the
browser? Fixtures/read-only dev data only — no paid executions, no payment
operations.

**Result: yes.** All 5 browser-verified assertions pass (see
[`metrics.json`](./metrics.json) for full detail), with **zero OpenHands
source modifications** — the standalone app was pointed at a small,
purpose-built adapter service purely through its existing extension seam
(`VITE_BACKEND_BASE_URL`/backend-registry), exactly as the plan anticipated.
The measured cost is a new ~1650-line standalone adapter (seed script +
Express server + mapping layer), not any change to OpenHands' own code —
and that adapter's real endpoint surface turned out to be 6 endpoints, not
the 4 the plan (reasonably) inferred from OpenHands' own mocks module alone.

## Directory layout

```
spike-c-full-shell-adapter/
  README.md                 - this file
  service-contract.md       - full AtherNull -> OpenHands field mapping table
  metrics.json               - measured numbers
  smoke-test.mjs             - Playwright smoke test (source of truth; copied
                                into spike-a-standalone-shell/upstream/ to run,
                                since that's where Playwright+Chromium are
                                already installed - see "Reproduce" below)
  screenshots/                - 3 PNGs from the passing smoke test run
  seed/
    package.json, seed.ts    - standalone seed script (own deps, own npm install)
  adapter-server/
    package.json, tsconfig.json
    src/
      index.ts               - Express server entry
      athernull-client.ts    - holds ONE server-side Better Auth session
                                cookie, GET-only wrapper around AtherNull's
                                real API
      athernull-types.ts     - locally-duplicated subset of apps/web/lib/types.ts
      mapping.ts              - AtherNull -> OpenHands shape translation
                                (the measured artifact - see service-contract.md)
      routes/
        conversations.ts      - GET /api/conversations{/search,,/:id}
        events.ts              - GET /api/conversations/:id/events/{count,search}
        health.ts              - GET/PATCH /api/settings, GET /server_info
                                 (discovered-at-runtime, not in the original plan)
```

Neither `seed/` nor `adapter-server/` is in the pnpm workspace — each has its
own `package.json` and its own `npm install`, fully isolated, same pattern
Spikes A and B used.

## How to reproduce

Prerequisites already true on this machine when this spike ran (see
"Environment" below for how each was confirmed):

1. `infrastructure/docker-compose.yml`'s Postgres running, `athernull_dev`
   already migrated through `0007_execution_events.sql`.
2. `apps/api/.env` present (gitignored, pre-existing) with `DATABASE_URL`
   pointed at that local Postgres and a real `INTERNAL_API_TOKEN`.
3. `apps/api`'s dev server running: `pnpm --filter @athernull/api dev` (or
   `npm run dev` inside `apps/api/`) — unmodified, just run, on
   `http://localhost:3001`.

Then:

```bash
# 1. Seed real AtherNull data (creates 1 org/project/task/execution/9 events)
cd prototypes/openhands-integration/spike-c-full-shell-adapter/seed
npm install
INTERNAL_API_TOKEN=<value from apps/api/.env> npm run seed
# -> writes seed-output.json with the created ids + a distinctive objective
#    string + the seeded user's email/generated password

# 2. Start the adapter server, using seed-output.json's values
cd ../adapter-server
npm install
ATHERNULL_OWNER_EMAIL=<from seed-output.json> \
ATHERNULL_OWNER_PASSWORD=<from seed-output.json> \
ATHERNULL_ORGANIZATION_ID=<from seed-output.json> \
PORT=4100 npm start
# -> http://localhost:4100, proxies apps/api read-only

# 3. Build & serve Spike A's frontend in real (non-mock) mode
cd ../../spike-a-standalone-shell/upstream
npm run build:app   # VITE_MOCK_API unset - the real code path, not build:mock
npx sirv build/ --single --port 4173

# 4. Run the smoke test (copy it in first - see below for why)
cp ../../spike-c-full-shell-adapter/smoke-test.mjs ./spike-c-smoke-test.mjs
node spike-c-smoke-test.mjs
```

`smoke-test.mjs` is copied into `upstream/` rather than run from
`spike-c-full-shell-adapter/` directly because it needs the
`@playwright/test`/Chromium already installed there from Spike A's own run —
`upstream/` is gitignored, so the copy is never committed; the version under
`spike-c-full-shell-adapter/` is the source of truth. This mirrors exactly
how Spike A's own `smoke-test.mjs` worked.

## Environment (confirmed before seeding)

- `docker ps` showed `athernull-dev-postgres-1` already running, port `5433`.
- `psql -l` and `\dt` against `athernull_dev` showed both `athernull_dev` and
  `athernull_test` already existed and were already migrated through
  `0007_execution_events.sql` (17 tables present, including
  `execution_events`) — no migration step was needed.
- `apps/api/.env` already existed (gitignored, pre-existing from earlier
  work in this repo) with `DATABASE_URL` correctly pointed at
  `localhost:5433/athernull_dev`. **Confirmed local, never touched.**
- `apps/api`'s dev server was already running on `localhost:3001`
  (`curl http://localhost:3001/health` → `200`).
- No `RESEND_API_KEY`/LLM/Solana credentials were used at any point. Email
  verification was bypassed the same way `apps/api/test/job-lifecycle.test.ts`
  does: `UPDATE "user" SET "emailVerified" = true` directly against Postgres,
  via a `pg` client in `seed.ts` — not by receiving a real email.

## Findings

### 1. Zero OpenHands source changes were needed

Confirmed by `git status`/direct inspection of
`spike-a-standalone-shell/upstream/` after the whole spike: no file under it
was edited. The only addition was a copy of this spike's own throwaway
Playwright script — not a source change, and not committed (`upstream/` is
gitignored). Pointing the app at the adapter needed only:
- a normal build (`npm run build:app`, `VITE_MOCK_API` unset — the real,
  non-mock code path, confirmed by inspecting `package.json`'s scripts),
  and
- seeding `localStorage`'s `openhands-backends`/`openhands-active-backend`
  with a `"local"`-kind entry whose `host` is the adapter's URL — the exact
  extension seam the plan identified
  (`src/api/backend-registry/`, `agent-server-config.ts`).

This confirms the plan's core hypothesis.

### 2. The real endpoint contract is bigger than the mocks module alone suggests

The plan's 4-endpoint contract was drawn from
`spike-a-standalone-shell/upstream/src/mocks/conversation-handlers.ts` — a
reasonable, principled starting point, since that's literally OpenHands'
own stand-in for "what a backend must implement." But mocking intercepts
*all* `*/api/*` traffic in mock mode; running the real, non-mock frontend
surfaced 3 more calls the mocks module's presence had been quietly
absorbing:

1. **`GET /api/conversations` (plural, `ids[]=` query, not `/:id`)** — the
   actual conversation-detail view's data source
   (`use-user-conversation.ts`'s `batchGetAppConversations`), not the
   singular `GET /api/conversations/:id` the plan's contract listed. Missing
   this was the root cause of the first failing smoke-test run: clicking the
   sidebar item navigated to the right URL, then silently bounced back to
   `/conversations` with a "this conversation does not exist" toast.
2. **`GET /api/settings` + `GET /server_info`** — the backend-registry
   health probe (`validateLocalBackend()`) gates the *entire app* behind
   these two succeeding; without them the UI shows a permanent "Manage
   backends" / Disconnected modal instead of the homepage at all. Getting
   `GET /api/settings`'s *response shape* right mattered as much as its
   existence: an initial flat-shaped stub (copied from the mocks' unrelated
   *cloud*-backend settings stand-in) caused the telemetry-consent modal to
   permanently reopen over the sidebar, because the real local-backend
   shape nests preferences under `misc_settings.app_preferences`, not at
   the top level.
3. **`PATCH /api/settings`** — needed only because the modal in finding #2
   tries to write its way past itself; without a working PATCH, that write
   404s and the modal never dismisses.

All 3 are implemented as local, honestly-stubbed additions (2 of them never
touch AtherNull's real API at all — see `service-contract.md`). This is
itself the measurement: **the true adaptation cost included the specific
runtime gates the mocks module doesn't foreground**, and finding them
required actually running the app, not just reading the mock handlers.

### 3. The field-mapping cost is genuinely small, once the endpoint list is right

Once all 6 endpoints existed with the right shapes, `mapping.ts` — the part
of the adapter this spike set out to measure — turned out to be
straightforward: AtherNull's raw `ExecutionEvent` wire shape
(`{id, kind, payload, occurredAt}`) is already close to OpenHands'
`OpenHandsEvent` union for the 3 event kinds this spike's seed data
exercises (`MessageEvent`/`ActionEvent`/`ObservationEvent`), because the
AtherNull worker persists the Agent Server SDK's own event body verbatim.
Most of `mapping.ts` is renaming/flattening, not real translation. The
genuinely lossy/stubbed fields (`session_api_key`, `conversation_url`,
`metrics`, the 16→7 status collapse, etc.) are enumerated exhaustively in
`service-contract.md` — nothing was silently dropped.

### 4. WebSocket/realtime: same limitation as Spike A, not attempted to fix

The smoke test recorded 9 WebSocket connection attempts across 2 socket
paths (`/sockets/bash-events`, `/sockets/events/:id`), all failing with
`Unexpected response code: 404` — this adapter implements no WebSocket
endpoint at all, by design (out of scope per the plan; AtherNull's own real
architecture uses REST polling, not websockets, for this data —
`apps/web/lib/hooks/use-execution-events.ts`). The UI correctly shows
"Disconnected" rather than hanging. This is the same structural limitation
Spike A's own smoke test found and documented, now confirmed to reproduce
identically when talking to real (adapted) data instead of MSW mocks.

### 5. Security constraints held

- AtherNull's Better Auth session cookie lives only in
  `athernull-client.ts`'s module-level variable — never returned from any
  Express route (verified by reading every route file: none of them ever
  send `cookie` in a response body or header).
- `AppConversation.session_api_key` is unconditionally `null` — no code
  path in `mapping.ts` ever assigns it anything else.
- The Agent Server `SESSION_API_KEY` concept is never generated, read, or
  referenced anywhere in `adapter-server/` or `seed/`.
- `athernullGet()` is the *only* function that makes a network call to
  AtherNull and accepts no HTTP method parameter — it is structurally GET-only.
  The only non-GET calls anywhere in this spike are in `seed.ts` (a
  one-time setup script, never run alongside the adapter server in normal
  operation) and reproduce the exact `apps/api/test/job-lifecycle.test.ts`
  pattern (sign-up → fund → claim → complete), which is zero-cost: no LLM
  calls, no Solana activity.

## Known gaps / deviations from the plan

See `metrics.json`'s `deviations_from_plan`. In summary: the endpoint
contract grew from 4 to 6 (documented above), and `PATCH /api/settings` was
added as a local-only stub (never forwarded to AtherNull, so it doesn't
violate the "adapter is read-only against AtherNull" rule, which is
specifically about AtherNull's own API).

## Cleanup

This spike leaves 3 long-running local processes started during
investigation (the `apps/api` dev server, the adapter server, and the
static file server for the built frontend) — none are part of the spike's
own state and can be stopped independently at any time; none write outside
the local dev Postgres / this spike's own directory.
