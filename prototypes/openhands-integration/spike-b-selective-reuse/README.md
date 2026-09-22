# Spike B — OpenHands selective reuse

Isolated Next.js 16 + React 19 harness testing **selective reuse**: vendoring
2 specific OpenHands presentation components (the event/activity feed, and
the terminal) into a minimal standalone app, to measure the real
adapter/integration cost — as opposed to Spike A, which evaluates adopting
the full OpenHands shell wholesale.

Fully standalone. Not part of the AtherNull pnpm workspace (own
`package.json`, own lockfile, own `node_modules`) — see the repo-root
instructions this spike was built under for the isolation rules.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000/harness
npm run build       # production build (this is what was used to verify — see below)
npm run typecheck
npm run validate-fixtures   # validates both fixture sets against a verbatim copy of AtherNull's real parser
```

## What's here

- `vendor/openhands/` — 125 vendored files from
  `https://github.com/OpenHands/OpenHands` @ pinned commit
  `380fd839d6bcb1f9e1674ab0ff5c0225705118e8`. **Read `vendor/openhands/MANIFEST.md`
  first** — it has the full per-file modification log, the fidelity
  labeling (every component here is presentation-only against mocked
  providers), the genuine Next.js blockers found, and the fixture-sourcing
  search.
- `lib/fixtures/execution-events.synthetic.ts` — 9 hand-authored
  `ExecutionEvent` fixtures (AtherNull's real Agent Server row shape,
  duplicated locally, not cross-imported) covering the 9 required cases.
- `lib/fixtures/execution-events.upstream-real.ts` — 9 more fixtures, 5 of
  them genuine OpenHands protocol payloads copied verbatim from upstream's
  own fixture/test files (cited per-entry), 2 hand-constructed to real type
  shapes where no genuine upstream fixture existed for that category
  (labeled as such — see MANIFEST.md's "Fixture sourcing" section).
- `lib/adapter/execution-event-to-openhands-event.ts` (147 lines) — the
  actual reuse-cost artifact: translates AtherNull's `ExecutionEvent` shape
  into what the vendored components actually read, documenting every field
  AtherNull's real event stream doesn't track that the OpenHands type
  contract requires.
- `scripts/validate-fixtures.mts` — validates both fixture sets against a
  **verbatim copy** of AtherNull's real `parseMessage`/`parseToolCall`/
  `pairActionsWithObservations` (copied, not imported, to avoid fighting
  cross-package path-alias resolution from outside `apps/web`'s own Next
  build — `apps/web/lib/execution-events.ts` was not edited). 19/19 checks
  pass.
- `app/harness/page.tsx` — renders both fixture sets through the real
  vendored `<Messages>`, plus a `<Terminal>` seeded with a replayed
  input/output transcript.

## Headline numbers

| Metric | Value |
|---|---|
| Vendored files | 125 (87 byte-identical, 38 modified/stubbed) |
| Adapter LOC | 147 |
| Fixtures LOC | 563 (286 synthetic + 277 upstream-real) |
| Validation script LOC | 320 |
| Runtime npm dependencies added (beyond Next/React) | 18 |
| Build-tooling dependencies added | 3 (`tailwindcss`, `@tailwindcss/postcss`, `tsx`) |
| Dependency added then dropped | `@heroui/react` (see MANIFEST.md `styled-tooltip.tsx` row) |
| Shims applied | 2 (`react-i18next`, `#/i18n`) — both explicitly scope-reduction, not incompatibility fixes |
| Genuine Next.js-specific blockers | 3 categories: `?react` SVG imports (11 files, ~20 lines), `import.meta.env` (1 file/line), xterm requiring `ssr:false` (1 file) |
| Fixtures rendered without console errors | 18/18 (9 synthetic + 9 upstream-real) |
| Fixture-parser validation checks | 19/19 passed |
| `next build` | succeeds, static-prerenders `/harness` |
| Runtime console errors on load (headless Chromium) | 0 |

Full detail, every row individually justified, is in `vendor/openhands/MANIFEST.md`.

## The real finding: file count exploded far past "2 components"

The task named 2 reuse units (event feed, terminal). Tracing their actual
import graphs (not guessing) surfaced:

- The event feed's `messages.tsx` alone transitively touches ~15 other
  concerns before reaching pure presentation: a zustand model store, a
  zustand conversation store, a live agent-state hook chain (REST fallback +
  websocket-fed store), a conversation-id route hook, a TanStack Query
  config hook, an HTTP API client, 2 React contexts, a toast-dispatch
  utility, and `react-i18next`.
- Getting to a **buildable, renderable** harness required vendoring 125
  files (not 2), of which 38 needed some form of change — 19 of those are
  full stubs standing in for live-backend/app-shell wiring that a
  presentation-only harness has no business reproducing.
- A specialized rendering subtree (`tool-visualizers/` — the per-tool-kind
  diff/terminal-styled bodies for bash and file-editor calls) was stubbed
  out entirely rather than vendored, because it fans out into 4 more
  multi-file directories; this is a real fidelity loss (terminal/file-editor
  action bodies render as plain markdown, not the specialized visualizer),
  not just an inconvenience.
- Styling/theming (HeroUI's plugin system, ~1000 lines of `--oh-*` design
  tokens across 3 named themes) was declared out of scope rather than
  vendored; this harness's rendering is functional, not pixel-faithful.
- One real, unmodified vendored file (`event-message.tsx`) turned out not to
  be fully defensive against a genuinely unrecognized event shape — caught
  only because this spike's required fixture set includes a deliberately
  malformed case. See MANIFEST.md's "Adapter discovery" section.

None of this means selective reuse doesn't work — the harness builds,
renders, and passes every fixture check. It means the "select 2 components"
framing understates the true unit of reuse: in practice it pulled along a
dozen-plus files of shared type contracts, content-formatting helpers, and
UI-primitive components that don't have a clean boundary at "just these 2
components." That transitive pull, and the judgment calls about where to cut
it off (stub vs. vendor), *is* the integration cost this spike was asked to
measure.

## Deviations from the plan

- **Vendor unit 1 scope**: the plan named 4 specific files for the event/
  activity feed
  (`messages.tsx`, `event-message.tsx`, `group-events.ts`,
  `get-event-content.tsx`) plus "whatever they transitively import ... trace
  and include what's actually needed." Traced faithfully, this pulled in
  ~120 more files. Rather than vendor all of it (which would have meant
  reproducing live-backend wiring this harness explicitly excludes), files
  reaching into app-infra (query hooks, zustand stores tracking live state,
  API clients, routing/panel-state contexts) were stubbed instead of
  vendored — every stub is logged individually in MANIFEST.md with the
  real file it replaces and why. This is the single biggest judgment call
  in this spike and is flagged here explicitly.
- **`tool-visualizers/` subtree**: stubbed out wholesale (see above) rather
  than vendored, despite being directly relevant to 2 of the 9 required
  fixture categories (terminal, file-editor). The stub exercises upstream's
  own documented fallback path (return `null` → render as markdown), so
  nothing crashes, but the specialized visual rendering for those 2
  categories was not reproduced.
- **TypeScript version**: this harness uses stable `typescript@^5.7.2`
  rather than AtherNull's `apps/web` `typescript@^7.0.2` (a very recent
  native-port release) — a deliberate choice for a fully independent
  harness with its own toolchain, not a constraint carried over from
  `apps/web`.
- Everything else (fixture counts, adapter location, `next/dynamic`
  `ssr:false`, the `#/` alias mapping, the i18n shim) matches the plan as
  given.

## Spike D: wired to REAL AtherNull data (closes the §10 asymmetry)

Everything above this section is Spike B as originally built, against
**static fixtures only** (`/harness`) — untouched by Spike D. This section
covers a later addition: a second route, `/harness-live`, that renders the
same vendored `<Messages>`/`<Terminal>` components against **real AtherNull
API data**, closing the specific asymmetry `COMPARISON.md` §10 left open
(Spike C had proven real-data rendering for the full shell; Spike B never
had, only fixtures).

**Data provenance — stated precisely, once, here:** every event and every
piece of text `/harness-live` renders is a real AtherNull API response read
from a **seeded local development database**
(`spike-c-full-shell-adapter/seed/seed.ts`), created through the same
zero-cost, zero-LLM, zero-Solana internal test-only endpoints
`apps/api/test/job-lifecycle.test.ts` uses. It is **not** the output of a
paid coding-agent execution, and nothing in `/harness-live`, its fetch
module, or its smoke test implies otherwise.

### What was added

- `lib/adapter/adapter-live-client.ts` — fetches
  `GET {ADAPTER_BASE}/api/conversations?ids[]={id}` (title) and
  `GET {ADAPTER_BASE}/api/conversations/{id}/events/search` (events) from
  Spike C's adapter-server, unmodified. Does **not** reuse or duplicate
  `execution-event-to-openhands-event.ts` — that module translates
  AtherNull's raw wire `ExecutionEvent` shape for the fixture path; Spike
  C's adapter-server has already done that exact translation server-side,
  so this fetches already-`OpenHandsEvent`-shaped JSON directly.
- `app/harness-live/page.tsx` — new route, client component, fetches on
  mount, renders through the same `toUiMessages`/`<Messages>` pattern
  `app/harness/page.tsx` uses (duplicated locally, not imported, so the
  existing fixture-only page stays untouched), plus `<Terminal>` seeded
  from real fetched command/output text.
- `smoke-test.mjs` (repo root of this spike) — Playwright smoke test for
  `/harness-live`. `live-metrics.json` — the measured numbers for this
  addition, kept separate from `metrics.json` (Spike B's original,
  fixture-only record, left as-is).
- `.env.local` (gitignored, not committed) — `NEXT_PUBLIC_ADAPTER_BASE` /
  `NEXT_PUBLIC_CONVERSATION_ID`.

### Environment setup that actually worked

Next.js inlines `NEXT_PUBLIC_*` vars at **build/dev-start time**, not at
request time — dropping values into `seed-output.json` alone does nothing.
The exact mechanism used: a `.env.local` file was written (gitignored via
the repo root `.gitignore`'s `.env.*` rule) with

```
NEXT_PUBLIC_ADAPTER_BASE=http://localhost:4100
NEXT_PUBLIC_CONVERSATION_ID=91ac88b0-825b-411a-bde6-e375c48191f9
```

**before** running `npm run build` / `npm run dev`. `NEXT_PUBLIC_CONVERSATION_ID`
is `seed-output.json`'s **`taskId`**, not its `conversationId` field — the
adapter's routes key on AtherNull's task id
(`adapter-server/src/mapping.ts`: `AppConversation.id = task.id`, confirmed
by reading that file, not assumed), while `conversationId` on the execution
row is a different, Agent-Server-native id the adapter never routes on. See
`lib/adapter/adapter-live-client.ts`'s header comment for the full
explanation.

### Adapter-server security properties (verified, not assumed)

Per the task's explicit instruction to verify rather than assume, before
connecting anything:

- **Binding**: `adapter-server/src/index.ts`'s `app.listen(PORT, ...)` call
  has no host argument. `netstat -ano` while the server ran showed it bound
  to `0.0.0.0:4100` / `[::]:4100` — **all interfaces, not loopback-only** —
  and a direct `curl` to the machine's LAN IP
  (`http://192.168.1.64:4100/health`) returned `200`. This is a genuine
  deviation from an assumption in this spike's own task brief ("confirm it
  binds to loopback only") — the real behavior is broader. Recorded
  honestly here, not corrected (Spike C's source was not modified, per this
  spike's own constraints) and not something Spike D introduced — it is
  Spike C's process, run exactly as Spike C's own README already documents
  starting it (`PORT=4100 npm start`, no host override anywhere in that
  README either).
- **Credentials**: `athernull-client.ts`'s `OWNER_EMAIL`/`OWNER_PASSWORD`/
  `ORGANIZATION_ID` come from `seed-output.json`'s spike-generated dev user
  (`spike-c-eb81ec80@example.com`) and a random per-run password — no
  production credential anywhere in the process.
- **Dataset scope**: `getTasks()`/`getProjects()` call AtherNull's real
  `/v1/jobs`/`/v1/projects`, both organization-scoped by the adapter's held
  session (switched to the seeded spike-c org at sign-in) — no broader
  query path exists.
- **CORS**: `cors({ origin: true })` is fully permissive by itself — stated
  here as exactly that, a same-machine, dev-dataset-only convenience, **not
  a security guarantee**. Combined with the loopback-binding finding above,
  what actually made this safe to run for this prototype is the *combination*
  of no production credentials anywhere in the process and the approved
  seeded dev dataset being the only thing the server can return — not the
  CORS setting, and not an (incorrect) loopback assumption either.

### Rendering-contract check: one real mismatch found and fixed

Verified by `curl`-ing the adapter's real `/events/search` response for the
seeded conversation and comparing it field-by-field against
`vendor/openhands/types/agent-server/core` (not assumed) before wiring the
fetch into `<Messages>`:

- **Mismatch**: `TerminalObservation.metadata` is declared **required**
  (`CmdOutputMetadata`, no `?`) in `base/observation.ts`, but the adapter's
  real JSON for the seeded terminal pair omits it entirely. The one
  vendored call site reading it
  (`event-content-helpers/get-observation-result.ts`:
  `observation.exit_code ?? observation.metadata.exit_code ?? null`)
  doesn't crash today only because the real `exit_code` is `0` (a
  non-nullish value short-circuits `??` before `.metadata` is ever
  touched) — but would throw (`Cannot read properties of undefined`) on
  any future seeded event with a null/undefined `exit_code`.
- **Fix**: `adapter-live-client.ts`'s `normalizeEvent()` synthesizes a
  default `CmdOutputMetadata` object whenever the real payload omits it.
  Fixed in Spike B's new fetch layer only — `vendor/openhands/...` and
  `spike-c-full-shell-adapter/` were never touched, and no smoke-test
  assertion was loosened to route around it.
- Two other gaps were found and confirmed harmless (no fix needed):
  `FileEditorObservation.old_content`/`new_content`/`error` are also
  omitted by the real payload, but every vendored read site guards with
  `'old_content' in observation` first; and the real `MessageEvent` JSON
  carries an extra top-level `reasoning_content` field the type doesn't
  declare at that level (it's nested under `llm_message` instead) — never
  read at the top level by any vendored file, so it's inert excess JSON.

### Terminal pairing and store isolation

Terminal `ActionEvent`/`ObservationEvent` pairs are matched by the real
`action_id` relationship (`ObservationEvent.action_id === ActionEvent.id`,
via a `Map`), mirroring `apps/web/lib/execution-events.ts`'s
`pairActionsWithObservations` — never by array position. `useCommandStore`
is reset (`setState({ commands: [] })`) on every fetch-effect run
(including first mount) and again on unmount, so `/harness-live` and the
existing fixture-driven `/harness` can never leak terminal state into each
other if both are visited in one browser session (as happened during this
spike's own manual verification).

### Smoke test: all 5 required assertions pass

`node smoke-test.mjs` (after `npm run build && npm start -- --port 3902`,
with `.env.local` present at build time) against `/harness-live`:

| Assertion | Result |
|---|---|
| Loading actually completed (no stuck spinner) before assertions ran | PASS |
| Exact seeded conversation title present | PASS |
| Exact distinctive seeded event message text present | PASS |
| Seeded terminal command present | PASS |
| Seeded terminal output text present | PASS |
| Zero browser console errors | PASS |

**A production build was required to get a clean console.** Under `next
dev`, the page (and, independently confirmed, the existing untouched
`/harness` fixture page too) throws a pre-existing
`@xterm/addon-fit`/`xterm` runtime error ("Cannot read properties of
undefined (reading 'dimensions')") — a dev-mode-only race in vendored
`hooks/use-terminal.ts`'s fit-on-resize logic, not introduced by this spike
and not present under `next build && next start` (the same measurement
method Spike B's original `metrics.json` already used). Not patched
(vendor file).

`@playwright/test@1.62.1` was added as this project's own devDependency
(`npm install`, isolated from the pnpm workspace as this whole spike
already is) rather than borrowing Spike A's `upstream/` install the way
Spike C did — it reused the Chromium build already cached at
`%LOCALAPPDATA%/ms-playwright/chromium-1234` (matching version), so no
browser re-download was needed, and keeps the smoke test self-contained
under this directory with no cross-spike copy step.

Screenshots: `screenshots-live/01-initial-load.png`,
`02-loaded.png`, `03-event-feed-and-terminal.png`. Raw results:
`smoke-test-live-results.json`.

### Event-category coverage: honest, not implied by the pass/fail above

The smoke test's pass does **not** mean all 9 seeded events render
distinctly — only 5 of them do, at rest, with no interaction:

- **Distinctly visible, no interaction needed** (5 of 9): the user
  message, the agent's message, the `FinishAction`'s closing message (all
  3 with their full real text in the chat feed), and the terminal
  command + its output (both with full real text, but in the separate
  `<Terminal>` panel, not the chat feed).
- **Not distinctly visible anywhere on the page** (4 of 9): the 2
  file-editor action/observation pairs (`create` on `health.ts`,
  `str_replace` on `app.ts` — 4 events total). All 3 action/observation
  pairs (terminal + both file-editor pairs) collapse in the chat feed into
  a single `EventGroup` whose summary text is an **untranslated i18n key
  literal** (`EVENT_GROUP$ACTIONS_COMPLETED` — a pre-existing artifact of
  this harness's own `react-i18next` passthrough shim, not introduced or
  fixed by this spike). Clicking it expands to 3 rows, also untranslated
  keys (`OBSERVATION_MESSAGE$RUN`/`WRITE`/`EDIT`) — real per-event content
  (file paths, diffs, stdout text) never appears in the chat feed's DOM
  text, at rest or expanded. Only the terminal pair's real text is
  separately recoverable at all, via the `<Terminal>` panel.

This mirrors Spike C's own §10 finding almost exactly ("the individual
command/stdout text inside that group is not in the DOM until it's
expanded by click") — same underlying vendored grouping/i18n behavior,
now confirmed to reproduce identically against real data in the selective-
reuse harness too.

### An operational note, for completeness

While standing up this spike, `next dev`'s automatic port-picker briefly
bound port 3001 — already held by `apps/api`'s own dev server — after port
3000 turned out to be occupied by an unrelated process. `apps/api`'s
`/health` 404'd for under a minute until this was caught via `netstat` and
the conflicting Next process was killed; Next was then restarted pinned to
an explicit unused port (`--port 3902`) for the remainder of this spike.
`apps/api`'s `/health` returned `200` again immediately. No data was lost;
recorded here in the interest of not hiding it.
