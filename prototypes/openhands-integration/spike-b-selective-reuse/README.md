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
