# Vendor manifest — Spike B (selective reuse)

Source: `https://github.com/OpenHands/OpenHands` @ pinned commit
`380fd839d6bcb1f9e1674ab0ff5c0225705118e8`, package `@openhands/agent-canvas`,
frontend root `src/`. `LICENSE` in this directory is the upstream repo's
`LICENSE` at that commit, copied verbatim.

**Spike F addendum (execution-review journey):** 8 new files vendored, at
the same pinned commit, to bring in OpenHands' real file-editor diff
visualizer (`file-editor.tsx` + `diff-view.tsx`) — the two target reuse
units this addendum exists for — plus their direct, previously-unvendored
dependencies. 2 already-vendored files (`dispatcher.tsx`,
`markdown-file-preview.tsx`) were also modified further; see their rows
below for what changed and why. New file count: 133 total (93 byte-identical
+ 40 modified/stubbed/partial). No file vendored in the original A-E pass
was removed or reverted.

**Dispatcher-vs-direct-call decision (documented in `dispatcher.tsx`'s row
below):** rather than vendoring upstream's full `./index` visualizer
registry (which would additionally pull in `bash/`, `search/`, `task/` — 3
more multi-file trees, none needed for this spike's diff-view goal), this
addendum special-cases the 4 file-editor action/observation kinds inside the
existing `dispatcher.tsx` stub and calls the newly-vendored
`fileEditorVisualizer.Body` directly. This is the task brief's explicitly
offered simpler alternative to vendoring the full dispatch mechanism, and is
equally faithful: the `Body` component invoked is the same real, unmodified,
byte-identical `file-editor.tsx` upstream itself would resolve through that
registry for these exact 4 kinds. Terminal (bash) events are unaffected —
neither this spike nor the original pass vendors `bashVisualizer`; both
Spike B's harness pages render terminal content via the separate Terminal/
xterm panel (`components/features/terminal/terminal.tsx`, already vendored)
plus, in the chat feed, the pre-existing markdown fallback path.

Fetched via a shallow, sparse `git fetch --depth 1 origin
380fd839d6bcb1f9e1674ab0ff5c0225705118e8` (GitHub allows fetching a public
repo by exact commit SHA) into a scratch clone, sparse-checked-out to `src`,
`scripts`, and a few top-level docs — not `raw.githubusercontent.com`
fetches, since a git clone let transitive imports be traced by reading the
real directory tree rather than guessing paths one file at a time.

## Fidelity labeling — read this before the tables below

**Every vendored component in this harness runs against mocked/stubbed
providers and static fixture data. None of it is wired to a live backend,
auth, or a real Agent Server websocket connection.** Specifically:

- **Event feed (`Messages` / `EventMessage` / the whole
  `conversation-events/chat` tree)** — presentation-only (mocked providers).
  Renders real vendored logic (grouping, thought-hoisting, markdown, syntax
  highlighting, task-tracking cards, skill-ready lists) against two static
  `OpenHandsEvent[]` arrays built by `lib/adapter/`. No live event stream, no
  pagination, no websocket reconnect logic exercised.
- **Terminal (`Terminal` / `useTerminal` / `useCommandStore`)** —
  presentation-only (mocked providers). `app/harness/page.tsx` seeds the
  (stubbed, static) command store with a fixed input/output transcript
  before mount, and the real `xterm` instance renders it. **This is a REPLAY
  of static text, not proof of a functional terminal** — there is no real
  PTY, no live input (the real terminal is deliberately configured
  `disableStdin: true` even upstream), and no running process behind it. A
  clean render here says nothing about whether xterm integration would work
  against a live Agent Server session.
- Every stub listed below that returns a fixed/static value (agent state,
  conversation id, config, settings, model store, ...) reinforces this: the
  harness is a snapshot render, not an integration test against real
  backend behavior.

## Modified / stubbed / partial-vendor files (40 of 133)

Most files below are annotated in place with a `SPIKE-B ...` comment
explaining the change (`grep -rln "SPIKE-B" vendor/openhands` finds 39 of the
40; the exception, `i18n/declaration.ts`, is instead documented inline via
its own `*(generated, not tracked upstream)*` category, same as in the
original pass). The 2 Spike-F-modified rows are marked in place as
`SPIKE-B UPGRADED FROM PARTIAL VENDOR — Spike F` (`markdown-file-preview.tsx`)
and `SPIKE-B MODIFIED (see MANIFEST.md ...)` (`dispatcher.tsx`); the new
`file-path-chip.tsx` carries a `SPIKE-B MODIFIED (blocker fix ...)` comment,
same convention as the rest of this table.
Categories:

- **STUB** — not copied from upstream; a small harness-local replacement
  with the same exported signature, because the real file requires a live
  backend, auth, routing, or app-shell state this presentation-only harness
  doesn't have.
- **PARTIAL VENDOR** — real upstream logic, but only the subset a vendored
  caller actually needs; the rest of the real file (which pulls in unrelated
  app-wide concerns) was left out.
- **MODIFIED (blocker fix)** — real upstream logic, a small mechanical edit
  to work around a genuine Next.js/Turbopack incompatibility (not a scope
  reduction).
- **MODIFIED (other)** — real upstream logic, edited for a reason specific
  to that file (documented per-row).
- **SHIM** — the task brief's explicitly-requested `react-i18next` /
  in-app-i18n passthrough.

| Local path (under `vendor/openhands/`) | Upstream path @ `380fd83` | Category | Modification | Why |
|---|---|---|---|---|
| `_shims/react-i18next.tsx` | *(no direct upstream file — replaces the `react-i18next` npm package)* | SHIM | New passthrough `useTranslation()`/`Trans`/`initReactI18next` (`t: (k) => k`) | Task brief's explicit scope-reduction shim; wired via `next.config.ts`'s `turbopack.resolveAlias` + a matching `tsconfig.json` `paths` entry so every vendored `import ... from "react-i18next"` is unmodified. |
| `i18n/index.ts` | `src/i18n/index.ts` | SHIM | Replaced the real `i18next` + `i18next-http-backend` + `i18next-browser-languagedetector` instance with `{ t: (k) => k, language: "en", exists: () => false }` | Same shim, for the 2 files (`get-action-content.ts`, `error-message.tsx`) that call `i18n.t()`/`i18n.exists()` directly instead of via the `useTranslation()` hook. |
| `i18n/declaration.ts` | `src/i18n/declaration.ts` | *(generated, not tracked upstream)* | None — regenerated verbatim by running upstream's own `scripts/make-i18n-translations.cjs` against upstream's own `src/i18n/translation.json` | This file is `.gitignore`d upstream (`# i18n translation files make by script`) and doesn't exist in a checkout; running the real generator against the real translation data reproduces the exact ~2470-key enum a live upstream build would produce, rather than hand-authoring a partial one. |
| `api/agent-server-config.ts` | `src/api/agent-server-config.ts` | PARTIAL VENDOR | Kept only the `DEFAULT_WORKING_DIR` constant `path-utils.ts` reads | Real file also builds live agent-server base URLs from runtime config. |
| `api/conversation-service/conversation-service.api.ts` | `src/api/conversation-service/conversation-service.api.ts` | STUB | `{ getCurrentConversation: () => null }` | Real file is an HTTP client. Its only call site (`user-assistant-event-message.tsx`'s "branch from here" handler) never fires in this harness — see `contexts/active-backend-context.ts` row. |
| `components/conversation-events/chat/event-message-components/collapsible-thinking.tsx` | same path | MODIFIED (blocker fix) | `#/icons/{angle-down,angle-up,lightbulb}.svg?react` → `lucide-react` `ChevronDown`/`ChevronUp`/`Lightbulb` | `?react` is a Vite/SVGR resourceQuery convention; no Next equivalent configured (see "Genuine Next.js blockers" below). |
| `.../critic-result-display.tsx` | same path | MODIFIED (blocker fix) | Same icon swap (`ChevronDown`/`ChevronUp`) | ” |
| `.../event-group.tsx` | same path | MODIFIED (blocker fix) | Same icon swap | ” |
| `.../generic-event-message-wrapper.tsx` | same path | MODIFIED (blocker fix) | `#/icons/skills.svg?react` → `lucide-react` `Sparkles` | ” |
| `.../user-assistant-event-message.tsx` | same path | MODIFIED (blocker fix) | `#/icons/repo-forked.svg?react` → `lucide-react` `GitFork` | ” |
| `components/conversation-events/chat/task-tracking/task-item.tsx` | same path | MODIFIED (blocker fix) | `#/icons/u-{circle,check-circle,check-circle-half}.svg?react` → `lucide-react` `Circle`/`CheckCircle2`/`CircleDashed` | ” |
| `.../task-list-section.tsx` | same path | MODIFIED (blocker fix) | `#/icons/lesson-plan.svg?react` → `lucide-react` `ClipboardList` | ” |
| `components/features/chat/error-message.tsx` | same path | MODIFIED (blocker fix) | Icon swap (`ChevronDown`/`ChevronUp`) | ” |
| `components/features/chat/generic-event-message.tsx` | same path | MODIFIED (blocker fix) | Icon swap (`ChevronDown`/`ChevronUp`) | ” |
| `components/shared/buttons/copy-to-clipboard-button.tsx` | same path | MODIFIED (blocker fix) | `#/icons/{checkmark,copy}.svg?react` → `lucide-react` `Check`/`Copy` | ” |
| `components/shared/loading-spinner.tsx` | same path | MODIFIED (blocker fix) | `#/icons/loading-outer.svg?react` → `lucide-react` `Loader2` | ” |
| `components/features/chat/goal-status-content.tsx` | same path | STUB | Renders `status` as plain text | Real file needs `useGoalStore` (zustand), `useOptionalConversationId`, toast dispatch. Not exercised by any of the 9 required fixtures (none is a `GoalConversationStateUpdate` event). |
| `components/features/chat/model-messages.tsx` | same path | STUB | Always returns `null` | Real file needs `useModelStore` (seeded empty, see `stores/model-store.ts`) + a live `useFreeModels` query; upstream's own component already returns `null` when the store has nothing for this conversation — this stub reproduces exactly that branch. |
| `components/features/chat/plan-preview.tsx` | same path | STUB | Renders `planContent` as plain text | Real file needs 3 routing/panel-state hooks. Not exercised by any required fixture (no `PlanningFileEditorObservation`). |
| `components/features/chat/tool-visualizers/dispatcher.tsx` | same path | MODIFIED (Spike F, was STUB) | `resolveVisualizerBody()` special-cases `FileEditorAction`/`StrReplaceEditorAction`/`FileEditorObservation`/`StrReplaceEditorObservation` and calls the newly-vendored `fileEditorVisualizer.Body` directly for those 4 kinds; every other kind still returns `null` (unchanged pre-Spike-F behavior) | Original A-E pass stubbed this to always return `null` rather than vendor upstream's full `./index` registry (which fans out into `bash/`, `file-editor/`, `search/`, `task/` — each its own multi-file tree). Spike F needs a real diff view for file-editor events specifically; rather than now vendoring the full registry (and `bash`/`search`/`task` alongside it, none needed here), this calls the one needed visualizer's `Body` directly — the task brief's own offered "simpler, equally faithful" alternative. Terminal/search/task actions still render via the markdown fallback, unchanged. |
| `components/features/chat/tool-visualizers/primitives/markdown-file-preview.tsx` | same path | MODIFIED (Spike F, was PARTIAL VENDOR) | Now also vendors the real `MarkdownFilePreview` UI component (previously dropped), verbatim except the same icon swap as `file-path-chip.tsx` below (`#/icons/file.svg?react` → lucide-react `File`) | Spike F's real, unmodified `file-editor.tsx` imports `MarkdownFilePreview` directly (for `create`d `.md` artifacts) — a real compile-time dependency the original A-E pass never had, since no vendored caller rendered it back then. Not exercised by the seeded str_replace journey fixture (a non-Markdown file), but present so the component compiles and behaves identically to upstream for any `.md` `create` event. Pulled in `plan-components.tsx` (new file, below) as a result — the same file the original pass's row here predicted this component would need. |
| `components/features/images/image-carousel.tsx` | same path | MODIFIED (other) | Replaced `ImagePreview`/`ImageLightbox`/`Thumbnail`/`RemoveButton` chain with a plain `<img>` grid, same prop signature | That chain is unrelated to either target reuse unit and no fixture carries image attachments; vendoring it would have added 4+ more files for a path never exercised. |
| `components/shared/buttons/conversation-confirmation-buttons.tsx` | same path | STUB | Always returns `null` | Real file needs 5 live-state hooks/stores for a pending-confirmation UI. Upstream's own component already returns `null` when nothing is pending — reproduces that branch. |
| `components/shared/buttons/styled-tooltip.tsx` | same path | MODIFIED (other) | Re-implemented with a native `title` attribute instead of `@heroui/react`'s `<Tooltip>` | Avoids pulling in HeroUI's whole theming plugin (`hero.ts`, `tailwind.config.js`, ~300 lines of `--heroui-*` CSS vars) for one tooltip, in a harness that already declined to reproduce OpenHands' real theme system (see "Styling / theming" below). The real file's line `const disableAnimation = import.meta.env.MODE === "test";` is also a **genuine Next.js blocker** (Vite-only `import.meta.env`; Next uses `process.env`) — moot here since the whole file was replaced for the HeroUI reason, but logged since it's a real, independent finding. |
| `context/navigation-context.ts` | same path | STUB | `navigate()` logs to console, no-op | Wraps React Router; this harness has one static route. |
| `contexts/active-backend-context.ts` | same path | STUB | Fixed `{ backend: { kind: "cloud" } }` | Fixing "cloud" makes `user-assistant-event-message.tsx`'s "branch from here" button never render (upstream gates it on local-only), which is what makes the `use-fork-conversation` / `conversation-service.api` / `custom-toast-handlers` stubs below safe to leave minimal — their real call sites never fire. |
| `hooks/mutation/use-fork-conversation.ts` | same path | STUB | No-op `mutate`, `isPending: false` | See `active-backend-context.ts` row. |
| `hooks/query/use-config.ts` | same path | STUB | `{ data: undefined, isLoading: false }` | Real file is a TanStack Query hook against a live Agent Server. |
| `hooks/query/use-settings.ts` | same path | STUB | Static `agent_settings.verification.enable_iterative_refinement: null` | Same; the one real caller (`critic-result-display.tsx`) only reads that one nested field. |
| `hooks/query/use-workspace-files.ts` | same path | STUB | `{ data: undefined, isLoading: false }` | Real file chains a TanStack Query hook through a runtime service, a cloud file-listing API, and an active-backend registry. Makes chat-markdown workspace-path-linking a no-op; doesn't affect whether a message renders. |
| `hooks/use-agent-state.ts` | same path | STUB | Fixed `AgentState.FINISHED` | Task brief explicitly names this as a stub candidate. Real file reads a live REST fallback + a websocket-fed zustand store. |
| `hooks/use-conversation-id.ts` | same path | STUB | Fixed `"spike-b-harness-conversation"` | Real file reads a React Router route param; this harness has one static route. |
| `services/canvas-ui.ts` | same path | STUB | `openWorkspaceFile()` logs to console, no-op | Real file writes into 2 live app-shell panel-state stores neither of which exists here. |
| `stores/command-store.ts` | same path | STUB (zustand, harness-local) | Same zustand store shape, but nothing appends to it live — `app/harness/page.tsx` seeds it once via `useCommandStore.setState(...)` | Task brief explicitly names `useCommandStore` as a stub candidate. Real store is appended to by a live Agent Server PTY websocket stream. |
| `stores/conversation-store.ts` | same path | STUB (zustand, harness-local) | Reduced to the 2 fields real callers read (`planContent`, `setMessageToSend`) | Real store tracks live per-conversation UI state synced with the Agent Server. |
| `stores/model-store.ts` | same path | STUB (zustand, harness-local) | Seeded permanently empty (`entriesByConversation: {}`) | Task brief explicitly names `useModelStore` as a stub candidate. |
| `utils/constants.ts` | same path | PARTIAL VENDOR | Kept only `METADATA_PREFIXES`, verbatim | Real file is 785 lines of unrelated app-wide constants. |
| `utils/custom-toast-handlers.ts` | same path | STUB | `displayErrorToast()` logs to console | Real file dispatches a styled UI-chrome toast; only reachable from the never-firing "branch from here" error path. |
| `utils/utils.ts` | same path | PARTIAL VENDOR | Kept only `cn()`, verbatim | Real file is 785 lines of unrelated app-wide helpers with their own app-specific type imports (settings, git providers, i18n-keyed status formatting, ...). |
| `components/features/chat/tool-visualizers/primitives/file-path-chip.tsx` | same path | MODIFIED (blocker fix, Spike F) | `#/icons/file.svg?react` → lucide-react `File` | Same `?react` SVG-import blocker as the original pass's 11 icon-swap rows above (Vite/SVGR-only, no Next/Turbopack equivalent configured) — new row because this file itself is new to this vendoring pass (a real, direct dependency of the newly-vendored `file-editor.tsx`). |

## Byte-identical files (93 of 133)

Every file below was copied unmodified from the pinned commit at the exact
same relative path under `src/` (only the `#/*` → `./vendor/openhands/*`
`tsconfig.json`/nothing-else path mapping makes them resolve — see "Genuine
Next.js blockers" below for the mapping itself). No content was touched.

```
components/conversation-events/chat/event-content-helpers/create-skill-ready-event.ts
components/conversation-events/chat/event-content-helpers/get-acp-tool-call-content.ts
components/conversation-events/chat/event-content-helpers/get-action-content.ts
components/conversation-events/chat/event-content-helpers/get-action-event-title.ts
components/conversation-events/chat/event-content-helpers/get-event-content.tsx
components/conversation-events/chat/event-content-helpers/get-invoke-skill-items.ts
components/conversation-events/chat/event-content-helpers/get-observation-content.ts
components/conversation-events/chat/event-content-helpers/get-observation-result.ts
components/conversation-events/chat/event-content-helpers/get-skill-ready-content.ts
components/conversation-events/chat/event-content-helpers/parse-message-from-event.ts
components/conversation-events/chat/event-content-helpers/shared.ts
components/conversation-events/chat/event-content-helpers/should-render-event.ts
components/conversation-events/chat/event-message-components/error-event-message.tsx
components/conversation-events/chat/event-message-components/finish-event-message.tsx
components/conversation-events/chat/event-message-components/hook-execution-event-message.tsx
components/conversation-events/chat/event-message-components/index.ts
components/conversation-events/chat/event-message-components/skill-item-expanded.tsx
components/conversation-events/chat/event-message-components/skill-ready-content-list.tsx
components/conversation-events/chat/event-message-components/thought-event-message.tsx
components/conversation-events/chat/event-message.tsx
components/conversation-events/chat/event-thought-helpers.ts
components/conversation-events/chat/group-events.ts
components/conversation-events/chat/hooks/use-plan-preview-events.ts
components/conversation-events/chat/index.ts
components/conversation-events/chat/messages.tsx
components/conversation-events/chat/task-tracking/task-tracking-observation-content.tsx
components/features/chat/chat-markdown-path-code.tsx
components/features/chat/chat-message.tsx
components/features/chat/is-in-event-group-context.ts
components/features/chat/mono-component.tsx
components/features/chat/path-component.tsx
components/features/chat/pending-stop-icon.tsx
components/features/chat/success-indicator.tsx
components/features/chat/tool-visualizers/define.ts
components/features/chat/tool-visualizers/file-editor/file-editor.tsx
components/features/chat/tool-visualizers/primitives/code-block.tsx
components/features/chat/tool-visualizers/primitives/diff-view.tsx
components/features/chat/tool-visualizers/text-content.ts
components/features/chat/user-message-body.tsx
components/features/chat/waiting-for-runtime-message.tsx
components/features/conversation-panel/runtime-waiting-state.tsx
components/features/conversation/conversation-tab-empty-state.tsx
components/features/markdown/anchor.tsx
components/features/markdown/blockquote.tsx
components/features/markdown/code.tsx
components/features/markdown/headings.tsx
components/features/markdown/horizontal-rule.tsx
components/features/markdown/list.tsx
components/features/markdown/markdown-renderer.tsx
components/features/markdown/markdown-table-scroll.tsx
components/features/markdown/paragraph.tsx
components/features/markdown/plan-components.tsx
components/features/markdown/remark-github-alerts.ts
components/features/markdown/syntax-highlighter.ts
components/features/markdown/table.tsx
components/features/terminal/empty-terminal-message.tsx
components/features/terminal/terminal.tsx
components/shared/buttons/copyable-content-wrapper.tsx
components/shared/hook-execution-event-message.tsx
components/shared/text-shimmer.tsx
constants/canvas-ui.ts
constants/child-conversation.ts
hooks/use-terminal.ts
types/agent-server/core/base/action.ts
types/agent-server/core/base/base.ts
types/agent-server/core/base/common.ts
types/agent-server/core/base/critic.ts
types/agent-server/core/base/event.ts
types/agent-server/core/base/index.ts
types/agent-server/core/base/observation.ts
types/agent-server/core/events/acp-tool-call-event.ts
types/agent-server/core/events/action-event.ts
types/agent-server/core/events/condensation-event.ts
types/agent-server/core/events/conversation-state-event.ts
types/agent-server/core/events/hook-execution-event.ts
types/agent-server/core/events/index.ts
types/agent-server/core/events/message-event.ts
types/agent-server/core/events/observation-event.ts
types/agent-server/core/events/pause-event.ts
types/agent-server/core/events/streaming-delta-event.ts
types/agent-server/core/events/system-event.ts
types/agent-server/core/index.ts
types/agent-server/core/openhands-event.ts
types/agent-server/type-guards.ts
types/agent-state.tsx
ui/typography.tsx
utils/event-logger.ts
utils/format-event-timestamp.ts
utils/get-language-from-path.ts
utils/is-markdown-file-path.ts
utils/parse-terminal-output.ts
utils/path-utils.ts
utils/scroll-fade-state.ts
```

Note: `types/agent-server/**` (19 files above) is the full OpenHands event
type contract — vendored wholesale rather than trimmed, since these are pure
type/type-guard definitions with no app-infra dependencies of their own
(beyond the 2 tiny `constants/` files, also vendored whole) and trimming
them file-by-file would have meant hand-maintaining a fork of a generated-ish
type system.

## Genuine Next.js-specific blockers (not scope reductions)

1. **`#/...` TypeScript path alias.** Fixed with a `tsconfig.json`
   `"paths": { "#/*": ["./vendor/openhands/*"] }` mapping (per the task
   brief's instruction) — every vendored file's `#/foo` import resolves
   automatically because this harness's `vendor/openhands/` mirrors
   upstream's `src/` layout 1:1. No per-file edits needed for this one.
2. **`*.svg?react` SVG imports.** Vite/SVGR's resourceQuery convention
   (`import Icon from "./icon.svg?react"` produces a React component) has no
   Next.js/Turbopack equivalent configured in this harness. Found and fixed
   in the 11 files listed in the table above (~20 individual import lines
   total — the exact files/lines are each in that table's "Modification"
   column); each fixed by swapping to a visually-equivalent `lucide-react`
   icon rather than vendoring an SVGR webpack/turbopack pipeline for 11
   icons. Many more `?react` imports exist elsewhere in the OpenHands
   codebase (~90+ hits across files this spike never vendored) — not fixed,
   since those files were never pulled in.
3. **`import.meta.env.MODE`** in `components/shared/buttons/styled-tooltip.tsx`
   line 35 (upstream) — Vite-only; Next.js has no `import.meta.env`, uses
   `process.env.NODE_ENV`/`process.env.NEXT_PUBLIC_*` instead. Moot in this
   harness because the whole file was replaced for an unrelated reason (see
   its row above), but logged as a genuine, independently-confirmed blocker.
4. **`@xterm/xterm` requires `ssr: false`.** `terminal.tsx` reaches for
   `document`/`window` at module scope (via `@xterm/xterm`'s `Terminal`
   class); Next's server render crashes without deferring it. Fixed in
   `app/harness/page.tsx` via `next/dynamic(() => import(...), { ssr: false })`
   — not a vendored-file edit.
5. **`react-i18next` resolution.** Not a Next incompatibility per se (the
   real npm package installs and works fine under Next) — this is the task
   brief's requested shim (see the SHIM rows above), listed here only
   because the *mechanism* used to wire it in (`turbopack.resolveAlias` in
   `next.config.ts`, plus a matching `tsconfig.json` `paths` entry so
   TypeScript agrees) is itself a Turbopack-specific pattern worth recording.

No `import.meta` usage (beyond #3) or other Vite-only syntax was found in
any of the 125 vendored files.

## Adapter discovery: a real, unmodified vendored file isn't fully defensive

`event-message.tsx`'s final fallback branch
(`!isActionEvent(event) && !isObservationEvent(event)`) treats **any** event
that doesn't structurally look like an action or observation as a
`MessageEvent`, and renders it via `UserAssistantEventMessage`, which reads
`event.llm_message.content` with no guard on `llm_message` itself being
present (only the separate `parseMessageFromEvent` helper guards `.content`
with `message?.content`). Fixture 9 (a truly unrecognized event kind, with
no `llm_message` field at all — exactly what a real future SDK event would
look like before AtherNull's parser knows about it) reproduced this as a
`next build` prerender `TypeError: Cannot read properties of undefined
(reading 'content')`. This is a real latent fragility in the **unmodified**
upstream file, discovered by this spike's malformed-event fixture, not
introduced by vendoring. Worked around in `lib/adapter/execution-event-to-openhands-event.ts`
(always synthesizes a syntactically-valid empty `llm_message` for
unrecognized-kind events) rather than by patching the vendored file — see
that file's inline comment for the full account.

## Styling / theming — explicitly out of scope

Upstream's real theme system (`src/tailwind.css`, `src/index.css`,
`src/themes/color-themes.ts`, a `hero.ts` HeroUI plugin, `tailwind.config.js`
— roughly 1000 lines total, 3 named color themes, `@heroui/react`
integration) was **not** reproduced. `app/globals.css` in this harness
defines a minimal, self-authored, single flat dark-theme token set standing
in for it, so the vendored components' Tailwind utility classes
(`bg-surface-raised`, `text-foreground`, `text-muted`, ...) resolve to
*something* legible. This is a deliberate scope cut (see that file's header
comment) — the harness's screenshots are functional, not pixel-faithful to
production OpenHands. `@heroui/react` itself was dropped as a dependency
entirely (see `styled-tooltip.tsx` row above).

## Fixture sourcing (task step 4b)

Searched, in order: `src/mocks/` (MSW request handlers — settings/auth/git/
canvas-extensions/etc.; none carry an `OpenHandsEvent[]` conversation
history), `src/fixtures/` (2 files, both used below — genuine, complete,
shipped fixture data used to drive OpenHands' own mock-mode UI), any
`.test.tsx` file under `src/` (unit test factories; one item below —
`get-event-content.test.tsx` — has a complete malformed-event object used
verbatim in an upstream assertion), `tests/e2e/` (Playwright specs + a mock
LiteLLM HTTP server for scripted LLM responses — response bodies, not
frontend event-stream fixtures, so nothing usable there).

`lib/fixtures/execution-events.upstream-real.ts` documents, per entry,
which of its 8 events are genuine (5, copied verbatim from
`src/fixtures/canvas-demo-conversation.ts`,
`src/fixtures/table-demo-conversation.ts`, and
`src/components/conversation-events/chat/event-content-helpers/get-event-content.test.tsx`,
all @ `380fd839d6bcb1f9e1674ab0ff5c0225705118e8`) versus hand-constructed to
real type shapes (2, labeled as such — no genuine upstream fixture for
`ExecuteBashAction`/`TerminalAction` or `FinishAction` was found anywhere in
the checkout).
