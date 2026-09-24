# Spike E: refresh/live-data workflow (narrowed, honest scope)

## Goal

The user originally asked for a "complete execution-review workflow" test
through both Spike B and Spike C, following the peer
`docs/prototype-study/report.md`'s suggestion. Exploration before committing
to a build found that 4 of the 5 originally-envisioned pieces have **no real
OpenHands-side mechanism at all** (see "Out of scope" below). What remains —
and what this spike actually tests — is the one piece OpenHands genuinely
has: **real event display plus genuine refresh** (new data appearing after a
refresh, not a one-shot snapshot), through both Spike B and Spike C.

This spike makes **no source changes to `spike-c-full-shell-adapter/` or
`spike-a-standalone-shell/`** (confirmed below — none were needed). The only
production-adjacent change is one small, additive "Refresh" action in Spike
B's own `app/harness-live/page.tsx`.

## Out of scope (explicit architectural reasons, not silently dropped)

- **Attempt selection**: OpenHands has zero concept of "execution attempts"
  — its only unit is a conversation. There is nothing to vendor; it would be
  net-new custom UI on both sides, not something either prototype
  demonstrates.
- **File diffs**: OpenHands' real diff mechanism
  (`use-unified-git-diff.ts` → `AgentServerGitService.getGitChangeDiff`)
  requires a **live** Agent Server session running `git diff` against a
  running sandbox. AtherNull destroys the task's container after execution
  (confirmed by `apps/web/components/workspace/file-changes-panel.tsx`'s own
  comment that the only diff AtherNull can show is a crude before/after
  block derived from persisted events, because there is no live checkout to
  diff against afterward). OpenHands' actual file/diff components are
  architecturally inapplicable to a finished AtherNull execution, on *both*
  Spike B and Spike C — not a vendoring-effort question.
- **Verification status**: AtherNull has real data (`verificationRuns[]` via
  `GET /v1/jobs/:id`), but OpenHands' UI has no equivalent concept anywhere.
- **"Return to review"**: neither prototype hosts AtherNull's real
  `review-panel.tsx`; simulating this would mean fake chrome, not something
  either approach actually demonstrates.

## Design

**No changes needed to `spike-c-full-shell-adapter/` or
`spike-a-standalone-shell/` source** — confirmed, not assumed: `adapter-server/src/routes/events.ts`'s
`GET /:id/events/search` calls `latestExecutionEvents()` fresh on every
request (no caching layer anywhere in the adapter), and this spike inserts
events into the *same already-seeded execution* (not a new attempt), so
`getTaskDetail(taskId).executions[0]` stays the same row throughout — no
attempt-switching logic is needed. This was verified directly: `curl`-ing
the adapter's `/events/count` immediately reflected each new event with no
adapter restart (9 → 10 → 11 → 12 across this spike's three insertions).

**The only code change is in Spike B**: `app/harness-live/page.tsx`
previously fetched once from an effect with an empty dependency array (no
refresh capability at all — confirmed during Spike D). This spike adds a
`refreshNonce` state value as the effect's only dependency, plus a
"Refresh" button (`data-testid="refresh-button"`) that increments it,
re-invoking the exact same `fetchLiveConversationAndEvents()` call — no
duplicated fetch logic, no change to `lib/adapter/adapter-live-client.ts`
(it was already reusable as-is).

### Worker-lease gotcha found while building this (not in the original plan)

`POST /internal/executions/:id/events` (`apps/api/src/routes/internal.ts`)
requires the request's `workerId` to equal the execution's current
`lease_owner` column, or it responds `409`. Completing an execution does
**not** clear `lease_owner` (confirmed by reading the `/complete` handler:
it only updates `executions.status`/`ended_at`), so the lease from Spike C's
original `seed.ts` run is still valid — but `seed.ts`'s own
`seed-output.json` never recorded the random `worker-<uuid>` value it used
at claim time. `seed-followup-event.mjs` resolves this with one read-only
`SELECT lease_owner FROM executions WHERE id = $1` against the same local
dev Postgres `seed.ts` already writes to directly for its own setup bypass
(email verification, agent-profile insert) — same pattern, read instead of
write, no schema or endpoint changes needed.

## Spike C's refresh mechanism — verified, not assumed

Per the plan's instruction to check before writing the test: read
`spike-a-standalone-shell/upstream/src/query-client-config.ts` in full. It
configures a shared `QueryClient` with a `QueryCache`/`MutationCache` for
401-handling and error-toast dedup — **it sets no `defaultOptions` at all**
(no app-wide `staleTime`, `refetchInterval`, or `refetchOnWindowFocus`).

The actual per-query behavior lives in
`upstream/src/hooks/query/use-conversation-history.ts`, which explicitly
sets:

```ts
staleTime: 0,
refetchOnMount: "always",
refetchOnWindowFocus: false,
refetchOnReconnect: false,
```

`refetchOnWindowFocus`/`refetchOnReconnect` are deliberately disabled (the
code comment explains why: flaky-network flapping would otherwise replay
the entire history). `refetchOnMount: "always"` only fires on a genuine
React **mount** — not on an interval, not on focus, not on reconnect. Under
a statically-served build (`build:app` + `sirv`) there is no WebSocket
backend and no polling loop (confirmed identically by Spikes A and C), so
nothing ever triggers a remount on its own.

**Conclusion, confirmed by testing (see Results below): the honest
equivalent of "refresh" in this environment is a full browser page
reload.** A reload genuinely remounts the conversation-detail route from
scratch, which is exactly what makes `refetchOnMount: "always"` +
`staleTime: 0` fire again — this is not a coincidental effect of reloading,
it is the actual mechanism. No in-app "Refresh" button exists anywhere in
OpenHands' own conversation view for this deployment shape, and this spike
does not fabricate one on Spike C's side (unlike Spike B, where adding one
was in scope because it's this spike's own harness code).

## Results

### Spike B (`smoke-test-b-refresh.mjs`) — all 4 assertions PASS

| Assertion | Result | Detail |
|---|---|---|
| new-event-absent-before-refresh | PASS | distinctive label not yet in DOM pre-insertion |
| new-event-present-after-refresh | PASS | exact inserted text found in DOM after clicking Refresh |
| rendered-event-count-matches-db-after-refresh | PASS | DB count 10→11, rendered "Loaded 11 real events" |
| zero-console-errors | PASS | (none) |

Full detail in `smoke-test-b-refresh-results.json`. Screenshots:
`screenshots/b-01-before-refresh.png`, `screenshots/b-02-after-refresh.png`.

### Spike C (`smoke-test-c-refresh.mjs`) — all 4 assertions PASS

| Assertion | Result | Detail |
|---|---|---|
| click-through-to-conversation-detail | PASS | reached `/conversations/<taskId>` |
| new-event-absent-before-reload | PASS | distinctive label not yet in DOM pre-insertion |
| new-event-present-after-reload | PASS | exact inserted text found in DOM after `page.reload()` |
| still-on-conversation-detail-after-reload | PASS | same URL before/after (reload, not renavigation) |

Full detail in `smoke-test-c-refresh-results.json`. Screenshots:
`screenshots/c-01-before-refresh.png`, `screenshots/c-02-after-reload.png`.

Console errors during the Spike C run include the WebSocket-404s and a
`workspace-session` CORS/credentials failure — both are **pre-existing,
already-documented limitations** from Spikes A/C (no WebSocket endpoint
implemented; out of scope by design), not new findings or regressions
introduced by this spike. They're recorded verbatim in
`smoke-test-c-refresh-results.json` for completeness, consistent with this
spike's own "report reality" instruction.

### Bottom line

**The new event genuinely appeared after refresh on both sides.** Spike B's
manual Refresh button and Spike C's browser reload both correctly picked up
data inserted into Postgres *after* the page's initial load — this is a
real data-freshness result, not a re-render of a cached snapshot. Across
the full spike (1 self-verification run + 1 run per smoke test), the seeded
execution's event count moved 9 → 10 → 11 → 12, each step confirmed by a
direct DB read inside `seed-followup-event.mjs` before any UI assertion ran.

No architecture-winner conclusion is drawn here, consistent with the rest
of this document set.

## Directory layout

```
spike-e-refresh-workflow/
  README.md                        - this file
  metrics.json                     - measured numbers
  seed-followup-event.mjs          - inserts one new, uniquely-labeled real
                                      event into the already-seeded execution
  seed-followup-event-output.json  - last run's inserted event id/text/counts
                                      (overwritten each run; consumed by both
                                      smoke tests to know exactly what text
                                      to assert for)
  smoke-test-b-refresh.mjs         - Playwright: /harness-live, before/after
                                      Refresh-button click
  smoke-test-c-refresh.mjs         - Playwright: Spike A's served build via
                                      Spike C's adapter, before/after a full
                                      page reload
  smoke-test-b-refresh-results.json
  smoke-test-c-refresh-results.json
  screenshots/
    b-01-before-refresh.png, b-02-after-refresh.png
    c-01-before-refresh.png, c-02-after-reload.png
```

Own `package.json`/`node_modules` (`pg` + `@playwright/test`, pinned to the
same `1.62.1` already cached on this machine from Spike B — no Chromium
re-download needed), same isolation pattern as spikes A/B/C/D: not in the
pnpm workspace.

## How to reproduce

Prerequisites (same as spikes C/D):

1. `infrastructure/docker-compose.yml`'s Postgres running.
2. `apps/api` dev server running on `http://localhost:3001`.
3. Spike C's adapter-server running on `http://127.0.0.1:4100` (loopback-only,
   CORS-allowlisted for `http://localhost:4173` and `http://localhost:3902`
   — see `spike-c-full-shell-adapter/SECURITY-FIX-network-binding.md`).
4. Spike B rebuilt and served with the new Refresh button:
   `cd spike-b-selective-reuse && npm run build && npx next start --port 3902`.
5. Spike A's real-mode build served via Spike C's adapter:
   `cd spike-a-standalone-shell/upstream && npm run build:app && npx sirv build/ --single --port 4173`.

Then:

```bash
cd spike-e-refresh-workflow
npm install
INTERNAL_API_TOKEN=<value from apps/api/.env> npm run smoke-test-b
INTERNAL_API_TOKEN=<value from apps/api/.env> npm run smoke-test-c
```

## Isolation / safety

- No LLM calls, no Solana/payment activity — reuses the existing zero-cost
  seed data and internal endpoints, same as spikes C/D.
- No changes to `apps/web`, `apps/api`, `packages/database`, or root config.
- No changes to `spike-c-full-shell-adapter/` or `spike-a-standalone-shell/`
  source.
- `docs/prototype-study/` untouched.
