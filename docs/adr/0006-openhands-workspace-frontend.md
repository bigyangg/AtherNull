# ADR-0006: OpenHands as AtherNull's execution workspace frontend

Status: Accepted
Date: 2026-09-25

## Context

`opencodeXather.md` (2026-09-22) was a report-only architecture assessment
that leaned toward reusing selected OpenHands (https://github.com/OpenHands/OpenHands)
frontend components inside AtherNull's Next.js app, but explicitly flagged
that recommendation as provisional and not evidence-backed, and specified an
isolated prototype as the required next step.

Six prototype spikes followed (`prototypes/openhands-integration/`,
`COMPARISON.md` is the full evidence record; summarized here):

- **Spike A** — the standalone OpenHands shell builds and runs from source
  against its own mock backend; browser-verified navigation (homepage,
  sidebar, conversation detail). Reproduced one real bug: the published
  `@openhands/agent-canvas` package's declared npm exports don't resolve at
  runtime (8/8 subpaths). This blocks *consuming OpenHands as a library
  dependency* — it does not affect *forking and running it from source*,
  which is what every subsequent spike did.
- **Spike B** — vendoring 2 OpenHands components (event feed, terminal) into
  a Next.js harness works, but pulled in 125 files (38 modified/stubbed) to
  reach a working render — evidence that "selective reuse" understates its
  true integration surface.
- **Spike C** — pointed Spike A's standalone shell at real, org-scoped
  AtherNull data (seeded via zero-cost internal test endpoints, no LLM/Solana
  activity) through a purpose-built compatibility adapter, with **zero
  OpenHands source changes**. Also found and fixed a real security bug in
  the adapter itself (bound to all network interfaces, not loopback) —
  the same class of mistake ADR-0005 independently found and fixed in the
  Docker sandbox's port publishing. That repetition is itself a signal:
  any new network-facing adapter in this codebase needs its binding/CORS
  posture checked explicitly, not assumed.
- **Spike D/E** — proved genuine data-freshness (new persisted events appear
  after a refresh, not a cached snapshot) on both the vendored-component path
  and the full-shell path.
- **Spike F** — the decisive experiment: one real, multi-facet
  execution-review journey (attempt-switching, a real file diff, real
  status/verification display, terminal output, a review hand-off link)
  through both approaches, on the same seeded data, same viewport, same
  assertion checklist. Result: full feature parity on all 5 facets, but with
  starkly unequal cost. Every facet was **free** on the full-shell side once
  the compatibility adapter fed it real data — attempt-switching via
  OpenHands' own native conversation sidebar, the file diff via OpenHands'
  own real, unmodified `diff-view.tsx`, status via OpenHands' own tag-chip
  display. The vendored-component side required new custom UI or new
  vendoring for every one of those facets. Neither side was blocked or
  degraded on any facet; the full-shell side simply already had the
  machinery built and it worked once the adapter spoke its language.

## Decision

**Adopt the full OpenHands frontend, forked and run from source at a pinned
commit, as the foundation of AtherNull's execution workspace UI.** Do not
pursue the selective-component-reuse path further as the primary frontend
strategy.

**Responsibility split**, per the evidence above:

- **OpenHands owns**: conversation/execution presentation, agent-message and
  tool-activity rendering, file diffs, and live execution UX (chat feed,
  terminal display, event grouping) — the surfaces Spikes A–F showed it
  already implements correctly once fed real data through a compatibility
  layer, with zero source modification required.
- **AtherNull owns**: authentication, organizations, projects, tasks,
  execution attempts, budgets, verification, review/acceptance, settlement,
  and deployment — everything that touches money, customer authorization, or
  business state. OpenHands has no concept of any of this and must never be
  given one.

**AtherNull's business lifecycle states must never collapse into OpenHands'
generic `finished`/`execution_status` bucket.** `VERIFYING`,
`AWAITING_ACCEPTANCE`, `SETTLED`, `REFUNDED`, and `FAILED` are materially
different states that gate real customer actions and real money movement.
Spike F proved a lossless path exists (surfacing the real status as adapter
metadata OpenHands already renders, e.g. a tag). Production must use an
exact, versioned, parseable grammar for this — not the prototype's ad hoc
string — specified in the companion design doc §4 ("Exact typed
status/verification transport").

**Canonical identity mapping**: one AtherNull execution attempt maps to
exactly one OpenHands conversation, keyed by AtherNull's own real
`executions.conversation_id` (already stamped by the worker via `POST
/internal/executions/:id/conversation` at execution start) — not by task id.
A task id resolves to its *current/latest* execution's conversation only as
an explicit, documented backward-compatibility fallback for pre-this-phase
data, not the primary contract. See the companion design doc for the full
identity contract and fallback rules.

**The historical-terminal asymmetry is accepted as a permanent, structural
constraint, not a bug to fix.** OpenHands' real dedicated Terminal tab is
live-PTY-only by upstream design (confirmed empirically in Spike F: it shows
its own genuine empty state under any non-live serving, with no replay
path). For a finished AtherNull execution — whose sandbox is always
destroyed after the run — the terminal review experience is the chat feed's
real, unmodified bash tool-visualizer (confirmed working), not the dedicated
tab. The dedicated tab only has meaning during a still-`RUNNING` execution
with a reachable live Agent Server session, which this phase does not
address (see Consequences).

**Prototype limitations that must not enter production, named explicitly**:

- The prototype adapter authenticated to AtherNull's API using **one
  configured owner's stored session** — acceptable for a local,
  single-developer prototype, never acceptable for production. Production
  must authenticate every request as the real signed-in customer, using
  AtherNull's existing session/organization checks (see companion doc).
- The prototype adapter defaulted to binding all network interfaces until a
  dedicated fix bound it to loopback and restricted CORS to an explicit
  allowlist. Any production compatibility surface's network exposure must be
  reviewed explicitly at design time, not discovered after the fact.
- The prototype's per-execution conversation lookup used an in-process
  linear scan across an organization's tasks — fine for a handful of
  prototype rows, not a production-scale query pattern.
- The prototype encoded AtherNull's status as a free-form string tag on an
  OpenHands metadata field with no schema. Production needs a defined,
  typed contract for this, even if it still rides on the same underlying
  OpenHands field.

## Consequences

- AtherNull's Next.js `apps/web` workspace UI is not replaced in this phase
  and continues to be the customer-facing surface until a production
  OpenHands-based workspace has passed regression testing against it. This
  ADR records the architecture decision and the production contract
  (see companion design doc); it does not itself migrate any UI, and no
  Solana/payment logic or customer deployment flow changes are in scope.
- A production compatibility layer must be designed and built (companion
  design doc) before any real customer traffic reaches an OpenHands-served
  workspace. It must live inside AtherNull's own trust boundary (`apps/api`,
  authenticated per-request via the existing Better Auth session/org checks)
  rather than as a separately-authenticated service, and rather than as any
  modification to OpenHands' own source.
- **Open risk, explicitly deferred, not solved by this ADR**: how a browser
  would ever reach a *live*, still-running Agent Server session for
  real-time terminal/streaming UX without exposing the per-execution
  `SESSION_API_KEY` (worker-and-container-only today, by ADR-0005's design)
  is unresolved. This phase is read-only/historical-execution-review only;
  live-execution streaming architecture is future work and needs its own
  ADR before it's attempted.
- `executions.conversation_id` is nullable today with no uniqueness
  constraint and no retry if the worker's report-conversation-id call fails.
  Production identity resolution must handle a null conversation id
  gracefully (fall back to the execution id itself, made observable per the
  design doc §3); a follow-up migration to make this more robust (e.g. a
  partial unique index) is recommended but not required to ship this
  phase. A direct query this session found zero duplicates in the only
  data that currently exists — reassuring, not conclusive, since no
  production database exists yet.
- **The production OpenHands frontend must be served from the same browser
  origin as `apps/api`** (normally a reverse proxy in front of both) —
  corrected in Phase 2 from this ADR's original, weaker same-registrable-
  domain statement. Better Auth's session cookie is `SameSite=Lax` with no
  override in this codebase, which does permit a cookie on a same-site
  (e.g. `app.athernull.io` calling `api.athernull.io`) cross-origin request
  — but Phase 2's live-frontend verification found the pinned OpenHands
  frontend's own compiled HTTP client never sets `credentials: "include"`
  on its local-backend request path, so the browser never attaches the
  cookie to a cross-origin request at all, regardless of what `SameSite`
  permits. Confirmed empirically (401s with the cookie absent from the
  request when frontend and API were served on different ports of the same
  host). Same-site hosting alone is therefore not sufficient; only a true
  same-origin arrangement makes the browser's default credentials behavior
  attach the cookie without any frontend change. See design doc §1 for the
  full mechanism and finding.
- Upgrading the pinned OpenHands commit remains a real, ongoing maintenance
  cost under this decision — the full-shell approach was cheaper to *adapt*
  in Spike F, not cheaper to *track upstream forever*. This should be
  revisited if upstream's release cadence or breaking-change rate turns out
  to be higher than assumed.
