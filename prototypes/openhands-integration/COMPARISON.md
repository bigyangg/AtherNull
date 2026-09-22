# Spike A vs. Spike B: measured comparison

Pinned upstream commit for both spikes: `380fd839d6bcb1f9e1674ab0ff5c0225705118e8`.

## 1. Scope asymmetry — read this before any number below

**Spike A measured a complete application.** It installs, builds, and
browser-tests the *entire* standalone OpenHands frontend against its own
built-in mock backend — real navigation, real REST-backed UI state, real
sidebar and conversation views.

**Spike B measured two selected components.** It vendors just the
event/activity feed and the terminal into a from-scratch Next.js harness,
rendered against static fixtures and mocked/stubbed providers — not a live
backend, not a full app.

These are different scopes measuring different things. A smaller number in
Spike B's table is not evidence that "selective reuse is cheaper than the
full shell" — it's evidence about two components, not the whole frontend.
Read every table below with that asymmetry in mind; it is restated at each
point where it matters.

## 2. Scope and non-goals (both spikes)

Excluded from both, by design, per the approved prototype plan:

- Full chat composer / live websocket send.
- Real Agent Server backend wiring (no live, paid, or authenticated
  execution was run for either spike).
- File explorer, diff viewer, browser preview, settings, skills, MCP,
  automations reuse — separate candidates from the source report, untested here.
- Better Auth / organization context integration.
- Any change to `apps/web`, `apps/api`, `app-sidebar.tsx`, or real
  AtherNull routes — confirmed via `git status`: neither spike touched
  `apps/web`, `apps/api`, `packages/database`, or root/production
  dependencies. Both live entirely under `prototypes/openhands-integration/`.
- Execution-event cursor/pagination/dedup hardening (source report's
  material gap #1–#2) — orthogonal to this comparison.
- Full i18next/posthog integration (Spike B stubs i18n explicitly; Spike A
  runs upstream's real i18n since it's the unmodified app).
- Electron desktop build target — never invoked.
- A migration-grade `docs/openhands-source-manifest.md` — Spike B's
  `vendor/openhands/MANIFEST.md` is prototype-scoped only.

## 3. Evidence quality

Everything in this document is **measured**, not estimated or statically
traced — both spikes reached their fallback gate (install/network
feasibility) successfully and completed full, real builds. Spike A's browser
smoke test is a real Playwright + Chromium run against served output, not a
simulation. Spike B's render check is a real `next build` + headless-Chromium
load, not a hand-trace of imports. Where either spike hit a genuine limit on
what it could verify (see §6), that limit is stated explicitly rather than
rounded up to a pass.

## 4. Quantitative table

| Metric | Spike A (full shell) | Spike B (2 components) |
|---|---|---|
| Install/vendor method | `npm install --ignore-scripts`, full upstream repo | Vendored 125 traced files individually |
| Install/vendor time | 81.97s | not separately timed (file-by-file vendoring, not a package install) |
| Dependency footprint | 1394 packages, 894 MB `node_modules`, 17 unremediated `npm audit` findings (10 moderate, 7 high) | 18 runtime + 3 build-tooling deps added beyond Next/React (1 added then dropped: `@heroui/react`) |
| Build | `build:mock`: 39.97s, success, 0 errors, 9.2 MB / 295 files | `next build`: success, static-prerenders `/harness`, 0 build errors |
| Library/export build | `build:lib`: 61.57s, success — but **8/8 declared export subpaths fail at runtime** (see §5, "Backend fit"). This bug affects only the *npm-library-consumption* integration path (`import`ing `@openhands/agent-canvas` as a dependency); it does not affect the *fork-and-run-from-source* path, which is what Spike A actually exercised — `build:mock` and the browser smoke test both ran directly against the checked-out source tree, never through the broken `dist/` exports. | n/a — Spike B doesn't consume the published package, it vendors source directly |
| Files touched to reach a working render | 0 (unmodified app) | 125 vendored (87 byte-identical, 38 modified/stubbed: 19 full stubs, 13 blocker/other fixes, 4 partial vendors, 2 shims) |
| Adapter/glue code written | 0 (native app, no adaptation needed to run itself) | 147 LOC (`execution-event-to-openhands-event.ts`) |
| Fixture/test code written | n/a (used upstream's own mock data + real UI) | 563 LOC fixtures + 320 LOC validation script |
| Framework-specific blockers hit | n/a (native Vite app, no port attempted) | 3 categories: `?react` SVG imports (11 files/~20 lines), `import.meta.env` (1 file), `@xterm/xterm` requiring `ssr:false` (1 file) |
| Runtime console errors on load | 2 WebSocket handshake failures (see §6) | 0 |

## 5. Qualitative comparison (source report's own criteria)

| Criterion | Spike A finding | Spike B finding |
|---|---|---|
| Routing | Untouched — native React Router 7, 27 routes confirmed working via real click-through navigation | Confirmed AtherNull's Next.js App Router coexists with vendored components once the `#/` alias and 3 Vite-only constructs (above) are worked around |
| React runtime | Single React 19 runtime, no conflict — it's the only app running | Single React 19 runtime confirmed working inside Next 16; no dual-React issues surfaced |
| State/providers | Native — all of OpenHands' zustand stores are exercised as intended (with real backend absent, mocked via MSW) | 19 files stubbed specifically because they pull live-backend-coupled state (model store, conversation store, agent-state hooks, API clients) that a presentation-only harness can't honestly reproduce — this is the concrete shape of the "hidden global stores" risk the source report flagged for approach A |
| Backend fit | **Two distinct integration paths, only one of which is broken.** (1) *Consume as an npm library* — broken: the published package's declared exports don't resolve at runtime (8/8 subpaths) even though it type-checks cleanly, a real reproduced bug. (2) *Fork and run from source* — not broken: this is what Spike A actually did, and `build:mock` plus the full browser smoke test succeeded against the source tree directly, never touching `dist/`. The export bug is a blocker for treating OpenHands as a dependency; it says nothing about the cost of forking it. | n/a by construction — Spike B never imports the package, it vendors source, so the export bug doesn't apply to it either way |
| Maintenance | One upstream app to track wholesale; any patch upstream ships applies directly (or requires a full app-level merge) | 38 of 125 files carry local modifications that must be re-diffed against upstream on every version bump; MANIFEST.md is the tracking mechanism, but it's manual |
| Product cohesion | Would replace AtherNull's entire frontend shell — strong internal cohesion, zero cohesion with AtherNull's existing dashboard/usage/projects screens without a much larger migration | Renders inside AtherNull's own Next.js app shell — cohesion with the rest of AtherNull is by construction, at the cost of the file-count/stub burden in §6 |
| Upgrade complexity | Re-run the same install/build pipeline against a new pinned commit; the 8/8 export bug and the WebSocket-under-static-serve gap would need to be re-checked each time | Re-diff 38 modified files, re-trace whether the import graph shifted, re-validate fixtures — a real per-upgrade cost demonstrated by how much judgment went into this single pass (see Spike B README's "file count exploded" finding) |

## 6. Integration fidelity — what was actually verified vs. rendered

| Tested surface | Fidelity | Evidence |
|---|---|---|
| Spike A: homepage/chat route | **Functional** (real, mock-backed app) | Playwright: real content rendered, no error boundary |
| Spike A: sidebar navigation | **Functional** | 3 real, clickable nav links found and exercised |
| Spike A: conversation detail view | **Functional for REST-backed state; not functional for realtime** | Reached via genuine UI click-through (not URL nav), title/chat UI/sidebar highlighting all real — but 2 WebSocket connections failed (`bash-events`, `events/1`), so live chat streaming and terminal realtime behavior were **not verified**; static-serving the mock build doesn't mock WebSocket traffic the way the Vite dev server does |
| Spike B: event/activity feed | **Presentation-only (mocked providers)** | Real vendored rendering logic (grouping, markdown, syntax highlighting) against static fixture arrays; no live event stream, no pagination, no reconnect logic exercised |
| Spike B: terminal | **Presentation-only (mocked providers) — explicitly not a functional terminal test** | Real `xterm` instance replays a fixed, pre-seeded transcript; no real PTY, no live input (upstream itself runs it with `disableStdin: true`), no running process. A clean render here says nothing about whether terminal integration would work against a live Agent Server session |

The asymmetry cuts both ways: Spike A's fidelity is higher for navigation but
unverified for realtime; Spike B's fidelity is uniformly presentation-only by
design, because live-backend wiring was explicitly out of scope for this
pass in both spikes.

## 7. License / provenance check

- Spike B: `vendor/openhands/LICENSE` present, verbatim copy of upstream's
  MIT license at the pinned commit. `vendor/openhands/MANIFEST.md` documents
  all 125 vendored files with upstream path, category (byte-identical / stub
  / partial vendor / modified / shim), and the reason for every
  non-identical file — satisfies the source report's requirement to preserve
  copyright notice and record modifications.
- Spike A: no source was copied — the full upstream tree was checked out
  under `upstream/`, which is gitignored and never committed; nothing from
  it is redistributed by this repository.
- Neither spike introduces a licensing obligation beyond what's already
  documented in Spike B's MANIFEST.md.

## 8. Comparability assessment — not a verdict

**No architecture winner is declared here.** The two spikes tested different,
non-comparable scopes (§1): a complete application's bootstrap and real
navigation cost, versus two components' presentation-only adaptation cost.

What the evidence actually supports:

- **Adopting the full shell wholesale (forked from source, not consumed as a
  library)** inherits an unverified realtime/WebSocket path, but also 27
  working routes, real navigation, and zero adapter code — at the cost of
  replacing AtherNull's entire frontend and reconciling it with the existing
  dashboard/usage/projects screens, which this spike did not attempt. The
  library-export bug (8/8 subpaths broken) does **not** disqualify this
  path — it only blocks the separate option of importing OpenHands as an
  npm dependency, which nothing in this document recommends.
- **Selective reuse** demonstrably works for the 2 chosen components — it
  builds, renders, and passes every fixture check, including real upstream
  event data — but this should be read as a warning against assuming
  selective reuse is lightweight, not as proof it's cheap: the true unit of
  reuse turned out to be ~125 files, not 2, with 38 requiring judgment
  calls. Fidelity was also traded away to get there — the `tool-visualizers/`
  subtree (bash/file-editor specialized rendering) was stubbed wholesale,
  degrading exactly the categories most relevant to AtherNull's existing
  Phase 2 workspace — and the terminal's "success" is explicitly a
  presentation-only replay, not a working terminal. A clean render in this
  spike establishes that reuse is *possible*, not that it has reached
  feature parity with either upstream OpenHands or AtherNull's own existing
  execution UI.

Neither finding, on its own, settles whether AtherNull should adopt the full
shell or continue selective reuse. What it does settle: the source report's
provisional lean toward selective reuse was **not** evidence-backed at the
time it was written, and it still isn't fully evidence-backed now — Spike B
shows selective reuse is *possible* at real, measured cost, but nothing here
tested the full shell's cost of being adapted *to* AtherNull (only its cost
of running standalone), so the two aren't yet compared on the same axis.

An evidence-backed architecture decision would need at least one of:
- A component-level extraction-cost audit for the full-shell approach
  (i.e., what would it cost to make Spike A's app consume AtherNull's real
  auth/org/task data instead of its own mock backend?), to compare against
  Spike B's 125-file/147-LOC-adapter cost on the same footing; or
- A functional/live-backend wiring test for Spike B's terminal and event
  feed (real websocket, real Agent Server session), to know whether the
  presentation-only success in §6 survives contact with a real backend.

## 9. Follow-ups (excluded scope, not dropped)

- Full chat composer with live websocket send (Spike B deliberately excluded
  `interactive-chat-box.tsx` — see source report §3, "no unrestricted send
  hook reuse").
- Real Agent Server backend wiring for either spike.
- `tool-visualizers/` (bash/file-editor specialized rendering) — stubbed
  wholesale in Spike B; a real fidelity loss for 2 of the 9 fixture
  categories, not yet recovered.
- File explorer, diff viewer, browser preview, settings, skills, MCP,
  automations reuse.
- Better Auth / organization context integration into either spike.
- Reconciling Spike A's WebSocket-under-static-serve gap by testing against
  `dev:mock` (a running Vite dev server) instead of a static build.
- Reproducing the 8/8 export-subpath bug's fix upstream (or working around
  it locally) before any approach that would actually `import` the published
  package rather than vendor source.
- Event-cursor/pagination/dedup hardening (source report's material gaps #1–#2).
- Full i18next/posthog integration evaluation.
- A migration-grade `docs/openhands-source-manifest.md`, promoted from Spike
  B's prototype-scoped `MANIFEST.md`, gated on whichever approach is chosen.

## 10. Spike C: full-shell adaptation cost (real AtherNull data)

§8 identified two ways to put the full shell and selective reuse on the same
footing. Spike C (`spike-c-full-shell-adapter/`) answers the first: *what
would it cost to make Spike A's app consume AtherNull's real auth/org/task
data instead of its own mock backend?* The second (a functional/live-backend
wiring test for Spike B's terminal and event feed) remains open — Spike C
did not attempt it.

**Method**: seeded one real AtherNull org/project/task/execution/9-events
through `apps/api`'s real HTTP + internal endpoints (the same zero-cost
pattern `job-lifecycle.test.ts` uses — no LLM calls, no Solana activity),
then wrote a small standalone adapter server that implements OpenHands'
expected REST contract by making real, read-only `GET` calls to `apps/api`.
Spike A's already-built standalone app was pointed at that adapter purely
through its existing `VITE_BACKEND_BASE_URL`/backend-registry extension
seam — no fork, no rebuild-from-a-different-commit. A Playwright smoke test
then clicked through the real UI and asserted the seeded, distinctive task
title and event content actually rendered (not OpenHands' own mock
fixtures). Full detail: `spike-c-full-shell-adapter/README.md`,
`service-contract.md` (field-by-field mapping), `metrics.json` (numbers).

### Result

**Zero OpenHands source files were modified.** The plan's central hypothesis
— that the backend-registry seam lets the full shell talk to a different
backend with no fork — held exactly as predicted. All 5 smoke-test
assertions passed: homepage/sidebar showed the real seeded task title;
clicking through (not a direct URL nav) reached the conversation detail
view; the detail view showed real seeded event content (a message and a
3-action collapsed group, both traceable to the seeded `execution_events`
rows); and the WebSocket/realtime gap reproduced identically to Spike A's
already-documented finding (2 socket paths, both 404ing under static
serving) — not attempted to fix, per the plan.

**But the real endpoint contract turned out to be larger than the plan's
mocks-derived estimate.** The plan scoped 4 endpoints from
`conversation-handlers.ts` (OpenHands' own MSW stand-in). Running the real,
non-mock frontend against the adapter surfaced 2 more requirements mock mode
had been silently absorbing: the conversation-detail view's actual data
source is a *plural, batch* conversations endpoint
(`GET /api/conversations?ids[]=`), not the singular one the mocks module
also happens to expose; and the entire app is gated behind a
backend-registry health probe (`GET /api/settings` + `GET /server_info`)
that has nothing to do with conversations or events at all — without it,
the UI shows a permanent "Manage backends" modal instead of anything. Both
gaps were found only by actually clicking through the built app, not by
re-reading the mocks module more carefully; a plan built purely from static
tracing of the mock handlers would not have caught either one.

### Cost, compared to Spike B's number — not apples to apples

| | Spike B (selective reuse) | Spike C (full-shell adapter) |
|---|---|---|
| OpenHands source files touched | 125 (38 modified/stubbed) | **0** |
| New non-OpenHands code written | 147 LOC adapter + 563 LOC fixtures + 320 LOC validation | ~1650 LOC (seed script + Express adapter server + mapping layer + Playwright test) |
| What that code *is* | Frontend glue translating AtherNull's wire shape into vendored components' prop shapes, running inside AtherNull's own Next.js app | A standalone backend service translating AtherNull's wire shape into OpenHands' expected REST contract, running outside AtherNull entirely |
| Endpoint/contract surface discovered | n/a (component props, not a REST contract) | 6 endpoints (4 anticipated + 2 found only at runtime) |

These numbers measure different kinds of cost — Spike B's is "how much of
OpenHands' frontend did we have to touch and re-diff on every upgrade,"
Spike C's is "how big a new backend-shaped service did we have to write and
how many of its required endpoints could we have predicted in advance." Spike
C's 0-files-touched result is a genuine, meaningful confirmation of the
plan's hypothesis about the extension seam; it is not evidence that the
full-shell path is now "cheaper" than selective reuse in some single unit,
because the ~1650 lines of new adapter code and the 2 discovered-at-runtime
endpoints are real, measured cost of their own kind, on the other side of the
ledger from "files touched."

### Still not a verdict

Consistent with §8: **no architecture winner is declared here.** Spike C
answers §8's first open question (the full shell's real-data-adaptation
cost is now measured, not just its standalone-mock cost) but the second
remains open — Spike B's terminal and event feed have still never been
tested against a live/real backend, only fixtures. Until that gap closes
too, the two approaches are each measured on one more axis than before, but
still not compared on a single common cost unit. What Spike C does settle
plainly: attaching real AtherNull data to the full shell is cheap in
OpenHands-source-change terms (zero) and moderate in new-adapter-code terms
(~1650 lines, mostly straightforward once the true 6-endpoint contract was
known) — and that true contract could only be established by running the
real app, not by reasoning from its mocks alone.

## 11. Spike D: closing the live-data asymmetry

§10 left one specific question open: Spike C proved the full-shell approach
can display real, org-scoped AtherNull data; Spike B's vendored terminal
and event feed had only ever been tested against static fixtures. Spike D
closes exactly that gap — nothing broader — by wiring Spike B's existing
`app/harness-live/page.tsx` (new route, `spike-b-selective-reuse/`) to the
**same seeded dataset and the same adapter-server Spike C already built and
proved**, not a new one. Spike C's `adapter-server/` source was read-only
for this whole spike; zero lines changed under it.

**Data provenance, stated once more since it matters for how to read every
number below:** both spikes render real AtherNull API responses read from a
seeded **local development database**, created through the same zero-cost,
zero-LLM, zero-Solana internal test-only endpoints
`apps/api/test/job-lifecycle.test.ts` uses. Neither is the output of a paid
coding-agent execution.

### The shared axis: read-only rendering of the same seeded records

Both spikes were exercised against the identical seeded task/execution (9
`execution_events`, via Spike C's `seed-output.json`), through the same
adapter-server, on this axis only:

| | Spike B (`/harness-live`) | Spike C (full shell) |
|---|---|---|
| Real seeded conversation title rendered | Yes (smoke-test asserted, exact string) | Yes (smoke-test asserted, exact string) |
| Real seeded event *message* text rendered | Yes (smoke-test asserted, exact string — the agent's 2nd `MessageEvent`) | Yes (smoke-test asserted, exact string — the agent's 2nd `MessageEvent`, same event) |
| Real seeded terminal command + output rendered | Yes (smoke-test asserted, exact strings, via the vendored `<Terminal>`/xterm panel) | Not separately asserted (Spike C's smoke test checked the chat feed's collapsed group summary, not xterm output — Spike C has no vendored `<Terminal>` component at all) |
| Real seeded file-editor events (2 pairs, 4 events) rendered distinctly | **No** — collapsed into the same `EventGroup`, summary text is an untranslated i18n key (pre-existing shim artifact), individual paths/diffs never appear in the DOM even expanded | **No** — same collapsed-group behavior Spike C's own §10 finding already documented ("the individual command/stdout text inside that group is not in the DOM until expanded by click") |
| Adapter endpoints exercised | `GET /api/conversations?ids[]=`, `GET /api/conversations/:id/events/search` (2 of the adapter's 6) | All 6 (conversations search/batch/single, events count/search, settings/server_info) |
| Zero console errors, real browser (Playwright) | Yes (under `next build && next start` — see README's dev-mode caveat) | Yes |

**On this shared axis, the asymmetry §10 flagged is closed**: Spike B's
vendored event feed and terminal now have a real, browser-verified,
Playwright-asserted rendering pass against genuine AtherNull data, not just
fixtures — the same standard of evidence Spike C already met. Both spikes
independently hit the identical underlying limitation for the file-editor
event pairs (collapsed group, no distinct per-event text without a click
this spike's own smoke test didn't require) — this is a real, shared
render-fidelity ceiling in the vendored OpenHands grouping/i18n code, not a
gap unique to either integration approach.

### What this does NOT settle

- **Spike B still has no equivalent of Spike C's full navigation/application
  shell** — no sidebar, no routing between conversations, no multi-page
  flow, no settings UI, no backend-registry onboarding. `/harness-live` is
  a single hand-fetched page rendering 2 vendored components; Spike C is a
  full standalone app. Comparing "closed" on the read-only-rendering axis
  above says nothing about that gap, which remains exactly as wide as §8/§10
  already described it.
- **Endpoint coverage is intentionally narrower.** Spike B's live path only
  needed 2 of Spike C's 6 real endpoints (it has no settings screen, no
  onboarding gate, no sidebar list to populate) — this is not evidence
  selective reuse "needs less adapter," only that this spike's scope (2
  components) needs less of the adapter's total surface than a full shell
  does, which was already expected from §1's scope-asymmetry framing.
- **No architecture winner is declared here**, consistent with §8/§10. This
  closes one specific open question — can the selectively-reused components
  render real data too — and reports plainly that they can, on the terms
  actually tested. It does not make the two spikes comparable on a single
  cost unit, and it does not revisit §10's own cost table.

### One verification-worthy finding surfaced along the way

Re-verifying Spike C's `adapter-server` security properties before
connecting Spike B to it (rather than assuming §10's characterization still
held) found that `app.listen(PORT, ...)` in `adapter-server/src/index.ts`
has no host argument and binds to **all interfaces** (`0.0.0.0`/`[::]`,
confirmed via `netstat` and a successful `curl` to the machine's LAN IP),
not loopback-only. This was not previously stated precisely in the repo.
Spike C's source was not modified (out of scope, and the binding behavior
predates this spike) — recorded here because it changes how the adapter's
already-documented permissive CORS should be read: safe for this prototype
specifically because of no production credentials + single approved dev
dataset, not because of loopback binding, which turns out not to hold.
See `spike-b-selective-reuse/README.md`'s "Spike D" section and
`spike-b-selective-reuse/live-metrics.json` for the full detail.
