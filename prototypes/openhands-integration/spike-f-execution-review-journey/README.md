# Spike F — one execution-review journey through both approaches

Phase 2 of Spike F (Phase 1 was the adapter/backend feature work: mapping
each AtherNull execution attempt to its own `AppConversation`, populating
real file-diff content, and seeding a real multi-attempt journey — see
`spike-c-full-shell-adapter/service-contract.md` and this directory's
`seed-journey-data.mjs`/`seed-journey-output.json`). This phase puts Spike B
(`spike-b-selective-reuse/`) and Spike C (`spike-c-full-shell-adapter/`)
through the SAME real, seeded, multi-facet product journey — attempt
switching, a real file diff, a real status/verification badge, terminal
output, and a "return to review" link — and reports what each approach
costs to reach parity, with any genuine, unequal-scope gaps stated plainly
rather than papered over.

## Methodology (shared by both smoke tests — do not diverge)

- **One fixed viewport for both sides**: 1440×900 (matches Spike A/C's own
  precedent).
- **One seeded dataset for both sides**: the task/executions recorded in
  `seed-journey-output.json` (`taskId`, `projectId`, the two `attempts[]`
  entries' `executionId`/`conversationId`, `distinctiveObjective`).
- **One canonical assertion checklist, written once here, referenced
  identically by `smoke-test-b-journey.mjs` and `smoke-test-c-journey.mjs`**
  (each script's header comment names each item below by number rather than
  restating divergent wording):

  1. **Attempt-switching.** Spike B: via the new custom attempt-selector
     (`[data-testid="attempt-tab"]`, two tabs). Spike C: via clicking between
     the 2 real sidebar conversation cards for the 2 seeded attempts (reusing
     the click-through pattern from Spikes C/D/E's own smoke tests, driving
     the REAL, unmodified full-shell app at `spike-a-standalone-shell/upstream/`
     — built once, served statically, through the adapter, same as every
     prior spike). Pass = selecting each attempt shows that attempt's own
     distinct event count / content, not a frozen or shared view.
  2. **Real, distinct file-editor diff** for the seeded `str_replace` event
     (editing `app.ts`) on both sides — not a markdown fallback, not a crude
     before/after block. Detected via the presence of the diff visualizer's
     own row-coloring classes (`bg-status-success-bg` / `bg-status-fail-bg`)
     after expanding the relevant collapsed event group/card — not merely by
     the presence of the file path text, which a markdown fallback would also
     contain.
  3. **Real status/verification badge** for the SETTLED+PASS attempt (attempt
     2) visible and distinct from the non-verified attempt (attempt 1) — not
     a collapsed generic "finished" state. Spike B: the page's own
     `[data-testid="status-badge"]`. Spike C: the real sidebar's tag chips
     (`conversation-tag-chips.tsx`, gated by `showTagsMetadata`, confirmed
     default-on) showing the literal tag values ("SETTLED", "PASS").
  4. **Terminal events render correctly** on both sides. This is checked at
     TWO distinct places, and the two sides are NOT symmetric here (see
     "Terminal finding" below) — both checks still must pass on both sides:
     - **In the event/chat feed itself**: real command text and real
       command output text both appear (Spike C via its real, unmodified
       `bashVisualizer`; Spike B via the markdown fallback, since Spike B
       never vendored `bashVisualizer` — only the file-editor visualizer was
       in scope for this spike).
     - **In the dedicated Terminal panel/tab**: Spike B's vendored xterm
       `<Terminal>` component shows the real replayed command/output text
       (same replay-only fidelity already established in Spikes B/D). Spike
       C's real Terminal TAB is a live-PTY-only view with no historical
       replay — confirmed empirically to show its own real, unmodified empty
       state ("No terminal output yet. Commands run by the agent will appear
       here.") rather than the historical content, which is an honest
       negative result for that specific sub-check, not a test bug (see
       below).
  5. **"Return to review" link** — a real anchor element whose `href` matches
     `${webBase}/projects/${projectId}/tasks/${taskId}` (the real route,
     read from `apps/web/app/(app)/projects/[projectId]/tasks/[taskId]/page.tsx`,
     with the real seeded `projectId`/`taskId` from `seed-journey-output.json`),
     checked via DOM inspection (`getAttribute("href")`), never clicked
     through into `review-panel.tsx`. See "Return to review" below for why
     Spike C's half of this check is a minimal inline fixture rather than
     part of the untouched upstream app.
  6. **Zero new console errors.** The already-known, already-documented
     WebSocket-connection-refused / `Cannot GET /api/llm/models/verified` /
     CORS noise from serving a built SPA against a REST-only adapter (first
     documented in Spike C's own smoke test) is expected and NOT treated as
     a failure; any OTHER console error is.

## Terminal finding (asymmetry, not a bug)

OpenHands' real Terminal TAB (the dedicated xterm view, as opposed to the
command/output block already inlined in the chat feed) is fed exclusively by
a live Agent-Server PTY websocket stream (`use-terminal.ts` appends to
`command-store` only from live socket events). It has no code path that
replays a conversation's historical `TerminalAction`/`TerminalObservation`
events from `GET .../events/search`. Confirmed empirically against Spike C's
real, unmodified, adapter-backed build: opening the Terminal tab for the
seeded SETTLED+PASS attempt shows the tab's own real empty state, not the
seeded `npm run test -- metrics.test.ts` output — this is expected, correct
behavior for a statically-served build with no live backend (same category
of limitation as the already-documented WebSocket-refused noise), not
something this spike's adapter work could or should fix.

Spike B's Terminal panel, by contrast, is REPLAY-BY-DESIGN (Spikes B/D built
it specifically to seed the command store from historical events before
mount) and does show the real replayed content. This is the terminal
analogue of the diff-visualizer/attempt-switching asymmetries: each approach
got a different piece "for free" or "at a cost" depending on what it was
built to do. The full real command + real output text IS visible on both
sides somewhere in the UI — inline in the chat feed for both, additionally
in a dedicated replay panel for Spike B only.

## Attempt-switching asymmetry (restated from Phase 1 planning, now measured)

- **Spike C**: attempt-switching is FREE once each execution has its own
  `AppConversation` (Phase 1's adapter change) — the real, unmodified sidebar
  (`conversation-panel.tsx`) already lists every conversation as a card; no
  Spike-C-side frontend work was needed for this spike.
- **Spike B**: required NEW custom UI (`app/harness-journey/page.tsx`'s
  attempt-selector, `[data-testid="attempt-tab"]`) because Spike B never
  vendored a conversation-list/sidebar component in its original 125-file
  vendoring pass (only the event feed + terminal were in scope then). This is
  a genuine, reportable cost difference, not a flaw in either approach's
  existing work — it reflects what each spike chose to vendor, not a defect.

## File-diff finding

OpenHands' real `file-editor.tsx` + `diff-view.tsx` (a hand-rolled unified
line-diff, LCS-based) render correctly and identically in spirit on both
sides once fed real `old_content`/`new_content` (or `old_str`/`new_str` for
an in-flight action) — Phase 1's adapter mapping fix. Confirmed by expanding
the seeded `str_replace` event (editing `app.ts`) on both sides and finding
the diff view's own green/red row-coloring classes present (not merely the
file path or a code block). **Zero new component was invented, and zero
OpenHands source was changed** on either side — Spike C's real, unmodified
app already had the real file (never touched), and Spike B vendored the
exact same two files (`file-editor.tsx`, `diff-view.tsx`) byte-identical from
upstream (see `vendor/openhands/MANIFEST.md`'s new rows), plus their small,
already-vendoring-pattern-consistent primitive dependencies.

## Status-tag finding

`buildStatusTags()` (Phase 1, `mapping.ts`) attaches the task's real status
(`SETTLED`) and, only for the specific execution a verification run actually
matched, a real `verification_outcome` (`PASS`). `showTagsMetadata` defaults
to `true` (confirmed by reading `conversation-panel-preferences-store.ts`,
not assumed) so Spike C's real sidebar chips render both tags with no
further wiring. Spike B renders the same two raw tag values directly as a
single badge string (`"SETTLED · PASS"`) — simpler than vendoring
`conversation-tag-chips.tsx` and its icon/overflow-popover machinery for one
badge, and equally honest since it's the same real values, not styled
identically. Both sides show a genuinely distinct SETTLED+PASS state for
attempt 2 vs. a plain SETTLED (no PASS chip) for attempt 1 — proven, not
assumed, by both smoke tests.

## "Return to review" — URL-correctness only, both sides

Neither prototype hosts AtherNull's real `review-panel.tsx`
(`apps/web/components/tasks/review-panel.tsx`), and `apps/web` is never
started or modified by this spike. Both smoke tests check ONLY that a real
anchor element's `href` matches AtherNull's real route pattern
(`/projects/:projectId/tasks/:taskId`, read from
`apps/web/app/(app)/projects/[projectId]/tasks/[taskId]/page.tsx`) populated
with the real seeded `projectId`/`taskId` — never clicking through into a
rendered review screen.

- **Spike B**: the link is real, rendered UI on `/harness-journey` itself
  (`[data-testid="return-to-review-link"]`).
- **Spike C**: since upstream source is never modified (this spike's
  hardest constraint), there is no in-app slot to add this link to without
  editing the untouched real app. `smoke-test-c-journey.mjs` therefore
  injects a minimal, separate static page via Playwright's `page.setContent`
  (not a checked-in HTML file, not part of the OpenHands build) representing
  the page-chrome slot a real AtherNull product integration would wrap the
  full shell in — asserted with the exact same DOM-inspection method as
  Spike B's real link. This is explicitly a URL-construction-logic check,
  not a claim that Spike C's real app has this affordance built in. Flagged
  here plainly, not hidden.

## What's still unequal (flagged, not hidden)

- Spike C is the full real OpenHands app (real navigation chrome, real
  sidebar, real settings, a real conversation URL) driven through the
  adapter. Spike B's `/harness-journey` is still a single harness page, not
  a full app shell — it has no navigation beyond the one route, no
  onboarding, no settings. This was true before Spike F and remains true
  after it; Spike F only closes the specific, previously-identified feature
  gaps (diffs, attempts, status, terminal, review-link), not the general
  "harness vs. full app" gap.
- Spike B's terminal REPLAYS history; Spike C's dedicated Terminal tab does
  not (see "Terminal finding" above) — an intrinsic property of the real
  upstream component's live-only design, not something either spike's
  adapter/vendoring work could paper over without inventing new OpenHands
  behavior (out of scope).
- Untranslated i18n keys (`EVENT_GROUP$ACTIONS_COMPLETED`,
  `OBSERVATION_MESSAGE$WRITE`, etc.) are visible as literal text in Spike B's
  event feed — a pre-existing, already-documented consequence of Spike B's
  passthrough i18n shim (`_shims/react-i18next.tsx`, `t: (k) => k`), not a
  regression introduced by this spike's vendoring. The underlying real
  content (file paths, diffs, terminal output, thought text) is unaffected
  and fully legible.

## Results

See `metrics.json` for the measured numbers and both smoke tests' full
assertion-by-assertion pass/fail output (also written to
`smoke-test-b-journey-results.json` / `smoke-test-c-journey-results.json`
after each run). Screenshots are in `screenshots/`.

## How to reproduce

Prerequisites (same as Spikes C/D/E): `apps/api` dev server on
`localhost:3001`; `spike-c-full-shell-adapter/adapter-server` on
`127.0.0.1:4100` (`ATHERNULL_OWNER_EMAIL`/`ATHERNULL_OWNER_PASSWORD`/
`ATHERNULL_ORGANIZATION_ID` from `spike-c-full-shell-adapter/seed/seed-output.json`);
this directory's `seed-journey-data.mjs` already run once (see
`seed-journey-output.json`).

- **Spike B**: `cd spike-b-selective-reuse && npm run build && npx next start -p 3902`
  (port 3902 is the adapter's existing CORS-allowlisted origin for Spike B,
  set in `spike-c-full-shell-adapter/adapter-server/src/index.ts`), then from
  this directory: `node smoke-test-b-journey.mjs`.
- **Spike C**: Spike A's frontend built in real mode
  (`npm run build:app`, cwd `spike-a-standalone-shell/upstream/`) and served
  (`npx sirv build/ --single --port 4173`, the adapter's other allowlisted
  origin), then from this directory: `node smoke-test-c-journey.mjs`.
