# Spike A - Standalone OpenHands Frontend Shell

Goal: fairly evaluate whether AtherNull should adopt the OpenHands frontend by measuring
the standalone shell's build/bootstrap cost, and confirming it genuinely boots and
navigates as an app under its own built-in mock-backend mode - no live backend, no auth,
no AtherNull integration. This spike is fully isolated: everything lives under
`prototypes/openhands-integration/spike-a-standalone-shell/`, and `upstream/` (the
OpenHands checkout) is gitignored and never committed.

Full numeric results are in [`metrics.json`](./metrics.json). This file is the narrative
write-up.

## What was checked out

Pinned commit `380fd839d6bcb1f9e1674ab0ff5c0225705118e8` (2026-09-21) of
[OpenHands/OpenHands](https://github.com/OpenHands/OpenHands), shallow-fetched:

```
mkdir -p prototypes/openhands-integration/spike-a-standalone-shell/upstream
cd prototypes/openhands-integration/spike-a-standalone-shell/upstream
git init -q
git remote add origin https://github.com/OpenHands/OpenHands.git
git fetch --depth 1 origin 380fd839d6bcb1f9e1674ab0ff5c0225705118e8
git checkout -q FETCH_HEAD
```

Fetch took 37.3s wall clock. Checked-out tree: 30M, 2335 files. Full command log and
tree-size record is in [`commit.txt`](./commit.txt).

**Structure confirmation**: the frontend is not under a `frontend/` subfolder - the
whole repository at this commit *is* the frontend package (`package.json` name:
`@openhands/agent-canvas`, version `1.20.0`, `bin: agent-canvas`, `engines.node: >=24`).

## Environment

- Windows 11, Node v24.21.0, npm 11.19.0 (upstream declares `packageManager: npm@10.5.0`
  and `volta.node: 22.12.0`, but the newer local toolchain installed and built cleanly
  with no version-related failures).

## Step 3: `npm install --ignore-scripts`

```
npm install --ignore-scripts
```

- **Wall clock: 81.97s** (`real 1m21.970s`)
- 1394 packages added, 1395 audited
- **`node_modules`: 894M**, 890 top-level package directories
- 4 deprecation warnings (`inflight@1.0.6`, `rimraf@2.6.3`, `glob@7.2.3`, `boolean@3.2.0`) -
  transitive, not actionable at this level
- `npm audit`: 17 vulnerabilities (10 moderate, 7 high) reported, not remediated (out of
  scope for this spike; would need `npm audit fix`/`--force` review before any real adoption)
- `--ignore-scripts` successfully skipped husky/Electron/Playwright postinstall side
  effects as intended - install exited 0 with no missing-binary errors later

## Step 4: mock-backend build (`build:mock`)

```
npm run build:mock
```

This resolves to `make-i18n && cross-env VITE_MOCK_API=true react-router build`.

- **Wall clock: 39.97s** (Vite itself reports 21.59s for the client bundle + 9.18s for
  the SSR/route manifest pass, then trims it since `ssr: false`)
- **Result: success, 0 build errors.**
- The app is configured for **SPA mode** (`ssr: false` in the react-router config), so
  output lands directly in `build/` (not `build/client/` as SSR-mode React Router apps
  would produce) alongside a generated `build/index.html` and `build/mockServiceWorker.js`
  (confirms the mock worker is baked into the build).
- **Output: 9.2M, 295 files.**
- Non-fatal warnings: one `INEFFECTIVE_DYNAMIC_IMPORT` for
  `add-backend-modal.tsx` (both statically and dynamically imported, so code-splitting it
  has no effect), three similar warnings for API service modules, a few chunks over
  500kB after minification (largest is `src/i18n/translation.js` at ~1.6MB / 569kB
  gzip - the bundled translation strings), and five React Router v8 future-flag
  deprecation notices.
- **Routes discovered** (from `src/routes.ts`, the single source of truth for the route
  tree): `/`, `/conversations`, `/conversations/:conversationId`,
  `/conversations/:conversationId/panel`, `/launch`, `/customize`, `/skills`, `/plugins`,
  `/apps`, `/extensions/:extensionName/*`, `/mcp`, `/settings` (+ 8 settings sub-routes:
  `llm`, `agent`, `agents`, `condenser`, `agent-context`, `verification`, `app`,
  `secrets`), `/oauth/device/verify`, `/automations` (+ `git-sync`, `templates`,
  `new/:automationId`, `:automationId`), and `/shared/conversations/:conversationId`.
  Full list in `metrics.json`.

## Step 5: library build (`build:lib`) and export-subpath audit

```
npm run build:lib
```

Resolves to `make-i18n && react-router typegen && cross-env BUILD_LIB=true vite build && tsc -p tsconfig.lib.json`.

- **Wall clock: 61.57s** (Vite's own bundle pass: 18.7s; the remainder is `make-i18n`,
  `react-router typegen`, and the separate `tsc` declaration pass)
- **Result: success, 0 build/type errors.**
- **Output: `dist/`, 80M, 10607 files.**

### The export mismatch report - REPRODUCED, confirmed as a real bug

There was a prior *unverified* report that the library build's JS/declaration exports
were mismatched. **This was reproduced concretely and is a genuine, 8-for-8 bug**, not a
false report.

`package.json`'s `exports` map declares 8 subpaths (`.`, `./browser`, `./conversation`,
`./files`, `./settings`, `./sidebar`, `./terminal`, `./i18n`), each with a `types`,
`import`, and `require` path. For every one of the 8:

- The declared `.d.ts` file **exists exactly where declared** (e.g. `dist/index.d.ts`,
  `dist/components/browser/index.d.ts`, ...).
- The declared `.js` and `.cjs` files **do not exist** at their declared paths (e.g.
  `dist/index.js`, `dist/index.cjs` are simply absent).
- The actual JS/CJS output exists **one directory level deeper**, under
  `dist/src/...` (e.g. `dist/src/index.js`, `dist/src/components/browser/index.js`).

**Root cause**: the two build steps disagree on path-prefix handling. `vite.config.ts`'s
library build sets `rollupOptions.output.preserveModulesRoot: "src"`, intending to strip
the `src/` prefix from emitted file paths the same way TypeScript's `rootDir: "src"`
does for the separate `tsc -p tsconfig.lib.json` declaration pass - but for this entry
graph the JS/CJS output does *not* get the prefix stripped, while the `.d.ts` output
does. The result: every declaration file points at a JS/CJS sibling that was never
generated at that path.

**Runtime confirmation** (not just a file-existence check):

```
node -e "require('./dist/index.cjs')"
// -> Error: Cannot find module './dist/index.cjs' (MODULE_NOT_FOUND)

node -e "require('./dist/src/index.cjs')"
// -> resolves and loads (only fails downstream on `document is not defined`,
//    i.e. because this is browser UI code run outside a DOM - module
//    resolution itself succeeds)
```

`node -e "require.resolve('@openhands/agent-canvas' + subpath)"` was also run for all 8
subpaths using Node's own package-exports resolution algorithm; all 8 fail with
`MODULE_NOT_FOUND`.

One red herring worth flagging explicitly: `dist/package.js` / `dist/package.cjs` exist
at the dist root and could easily be mistaken for the library's root entry at a glance.
They are not - they are an incidentally bundled copy of `package.json` (something under
`src/` imports it, e.g. for a version string), and just happen to collide in name.

**Practical implication for any reuse decision**: as built at this commit, `import`ing
or `require`ing `@openhands/agent-canvas` (or any of its declared subpaths) from another
package **fails at module resolution time** in both ESM and CJS consumers, despite
TypeScript happily type-checking against the (correctly-located) `.d.ts` files. A
consumer would get clean autocomplete and then a runtime crash. Per-subpath detail table
is in `metrics.json` under `export_subpath_audit.per_subpath`.

## Step 6: Browser smoke test (Playwright) - PASS, all 3 assertions

**This ran successfully end-to-end; it was not skipped.**

- `@playwright/test` (1.62.1) was already present as an upstream devDependency from the
  `--ignore-scripts` install, so nothing extra needed to be added to `upstream/package.json`.
- `npx playwright install chromium` fetched Chrome for Testing 151.0.7922.34 in 67.45s.
- Served `build/` (the `build:mock` output) with `npx sirv-cli build/ --single --port 4173`
  (upstream's own `npm start` script is `sirv-cli build/ --single`; this mirrors it
  exactly and was more reliable for this SPA-mode output than `vite preview`, which
  expects a different directory layout).
- Wrote a throwaway script, `upstream/smoke-test.mjs` (gitignored along with the rest of
  `upstream/`), driven with plain Playwright (no test runner needed for a one-shot smoke
  check).

**Necessary workaround**: a completely fresh browser (empty `localStorage`) lands on an
"Add a backend" first-run wizard instead of the app shell - `VITE_MOCK_API=true` mocks
the REST API layer via MSW but does not, by itself, seed a "backend already configured"
client state. The script pre-seeds `localStorage` (`openhands-backends`,
`openhands-active-backend`, `openhands-onboarded`, telemetry-consent flags) before
navigating, using **the same keys and shape as upstream's own**
`tests/e2e/support/onboarding-helpers.ts` (`showOnboarding` helper) uses for its own
Playwright suite. Since MSW intercepts `*/api/*` regardless of which host is configured,
this is a faithful "user already added their first (local) backend" state, not a way of
dodging real app behavior - it's the same setup upstream's own test suite relies on.

### Assertions

| # | Assertion | Result | Detail |
|---|---|---|---|
| 1 | Homepage/chat route navigates to and renders real content (not blank, no error boundary/stack trace) | **PASS** | `rootInnerHTMLLength=147747`, `bodyTextLength=3732`, no error-boundary/stack-trace text pattern matched |
| 2 | Sidebar renders with at least one visible, clickable nav item | **PASS** | 3 visible links matched `a[data-testid^="sidebar-"][data-testid$="-link"]`: `sidebar-conversations-link`, `sidebar-skills-link`, `sidebar-automations-link` |
| 3 | Clicking through the UI (not a direct URL nav) reaches a conversation/detail route that actually mounts | **PASS** | Clicked the "My New Project" conversation list item; navigated to `/conversations/1?backend=default-local`; the conversation detail view mounted with a visible title, chat interface, and highlighted active item in the sidebar |

Screenshots (in [`screenshots/`](./screenshots/)):
- `01-homepage.png` - home dashboard: sidebar with populated conversation list,
  "Recommended automations" cards, onboarding checklist. (A first-run "Help improve
  OpenHands" telemetry-consent dialog is also visible here - our localStorage seeding did
  not fully suppress it the way it does in upstream's own Playwright config, a minor
  discrepancy worth noting but it did not block any of the 3 assertions, since it never
  overlaps the sidebar or the conversation list items that were clicked.)
- `02-sidebar.png` - same view, used for the sidebar nav-item assertion.
- `03-detail-view.png` - the mounted conversation detail view after clicking through:
  title "My New Project", chat input ("What do you want to build?"), Git actions button,
  and an "Unable to connect to server" / "Disconnected" status (see limitation below).

### A genuine limitation found, not fabricated

Two WebSocket connections failed during the run:

```
WebSocket connection to 'ws://localhost:4173/sockets/bash-events' failed: Error during WebSocket handshake: Unexpected response code: 200
WebSocket connection to 'ws://localhost:4173/sockets/events/1?resend_mode=all' failed: Error during WebSocket handshake: Unexpected response code: 200
```

MSW mocks the **REST** API layer thoroughly - the conversation list, sidebar counts,
settings, and automations all render believable mock data with no REST-related console
errors. But when `build:mock`'s static output is served by a plain static file server
(`sirv-cli`), **WebSocket traffic is not mocked**, so the conversation view correctly
shows "Unable to connect to server" / "Disconnected". This suggests WebSocket
interception in this codebase is wired through the Vite dev server (`npm run dev:mock`),
not through a mechanism that survives a static production build. **Structural
navigation and REST-backed UI state were verified end-to-end; live chat
streaming/terminal/event realtime behavior was not**, and would need `dev:mock` (a
running dev server) rather than a static `build:mock` + file-server setup to evaluate.

## Surprises / deviations from the plan

1. **SPA mode, not the `build/client/` layout the task hinted at.** `react-router build`
   with `ssr: false` writes directly to `build/`, so the "output routes" and bundle
   sizes were found by reading `src/routes.ts` and `build/index.html` directly, not by
   walking a `build/client/` tree.
2. **The export mismatch is real and total (8/8), not a partial/edge-case issue** -
   worth weighting heavily in any adoption decision, since it means the library-consumer
   path (as opposed to running the whole app) is currently broken for every subpath at
   this pinned commit.
3. **`dist/package.js`/`dist/package.cjs` are a red herring**, not the library entry -
   worth flagging so nobody re-discovers this and wastes time assuming it's the fix.
4. **The mock build's static output alone doesn't fully bypass onboarding or mock
   WebSockets.** Both required either seeding `localStorage` (documented and reused from
   upstream's own test helpers) or noting the limitation rather than working around it
   silently.
5. Local npm (11.19.0) and Node (24.21.0) are both newer than upstream's pinned
   `packageManager`/`volta` versions; no version-compatibility issues surfaced across
   install, both builds, or the browser test.

## Pointer for Spike B: mock/fixture event data locations

Not fetched or processed here (per instructions) - just the paths, so Spike B doesn't
have to re-discover them:

- **MSW request handlers**: `upstream/src/mocks/` - `handlers.ts` aggregates
  per-domain handler files: `conversation-handlers.ts` (includes `GET /events/search`
  and `/events/count`, and a pagination event generator built on an `OpenHandsEvent`
  shape), plus `agent-profiles-handlers.ts`, `analytics-handlers.ts`,
  `auth-handlers.ts`, `automation-handlers.ts`, `canvas-extensions-handlers.ts`,
  `feedback-handlers.ts`, `file-service-handlers.ts`, `git-repository-handlers.ts`,
  `mcp-handlers.ts`, `secrets-handlers.ts`, `settings-handlers.ts`,
  `workspaces-handlers.ts`.
- **MSW browser/node entry points**: `upstream/src/mocks/browser.ts`,
  `upstream/src/mocks/node.ts`.
- **Mock activation gate**: `upstream/src/mocks/should-start-mock-worker.ts` (checks
  `import.meta.env.VITE_MOCK_API === "true"`).
- **Concrete sample event payloads** (message/file-editor/etc. shaped events):
  `upstream/src/fixtures/canvas-demo-conversation.ts` - contains literal sample events
  including `kind: "FileEditorAction"` and `kind: "FileEditorObservation"` entries plus
  function-call/message-shaped entries. Also see `upstream/src/fixtures/table-demo-conversation.ts`
  and `upstream/src/fixtures/home-automations-demo.ts`.
- **Reference for how upstream's own e2e suite exercises these mocks**:
  `upstream/tests/e2e/mock-llm/` (subfolders per feature area: `conversations/`, `home/`,
  `onboarding/`, `settings/`, etc.) and `upstream/tests/e2e/support/onboarding-helpers.ts`
  (the localStorage-seeding pattern this spike's smoke test reused).

## Files in this spike

- `commit.txt` - exact checkout commands and resulting tree size
- `metrics.json` - full structured numbers for every step
- `README.md` - this file
- `screenshots/` - 3 PNGs from the Playwright smoke test (committed; only images live here)
- `upstream/` - the gitignored OpenHands checkout itself (not committed; reproducible
  from `commit.txt`)
