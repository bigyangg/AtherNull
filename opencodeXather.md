# AtherNull × OpenHands: frontend integration report

Date: 2026-09-22
Scope: report only; no application implementation, prototype, deployment, or transactions.

## Recommendation

Retain AtherNull's Next.js application, authentication, business APIs, and task lifecycle. Reuse selected OpenHands frontend source through explicit presentation and data adapters. This is approach C, implemented through selective component reuse from approach A. Do not adopt the complete OpenHands shell until an isolated prototype demonstrates that replacing its backend assumptions costs less than adapting its presentation components.

This recommendation is provisional. Source inspection establishes substantial coupling; it does not establish runtime compatibility. The requested isolated prototype is specified below but was not built because the current instruction explicitly says not to code.

## Evidence and limits

- Inspected the current AtherNull working tree, including uncommitted Phase 2 work. Git HEAD is `aab99a8f44e083658c52896a719be1284d72ece9`; HEAD alone does not capture this audit baseline.
- Read the supplied integration brief, frontend package metadata, navigation, dashboard, typed API implementation, execution hook and parsers, API session enforcement, usage route, relevant job-route sections, isolation ADR, and Solana client documentation.
- Retrieved the official OpenHands repository tree, package metadata, license, root component, and selected component imports/source at commit `380fd839d6bcb1f9e1674ab0ff5c0225705118e8`.
- This is an architecture assessment, not a complete codebase security audit. Transitive dependency closure, all feature implementations, browser behavior, package export execution, and payment integration were not exhaustively validated.
- No build or regression tests were run for this documentation-only task. Existing comments describing earlier live tests are historical evidence, not tests repeated here.

## 1. AtherNull repository assessment

| Area | Evidence | Preservation decision |
| --- | --- | --- |
| Application shell | `apps/web/app/(app)/layout.tsx`, `apps/web/components/app-sidebar.tsx` | Keep one shell; adapt navigation incrementally. Existing mobile navigation uses the same sidebar content in a drawer. |
| Authentication and organizations | `apps/api/src/session.ts`, `apps/web/lib/auth/current-org-provider.tsx`, `apps/web/lib/auth/client.ts` | Keep Better Auth and organization context. The API rechecks active membership; owner/admin roles gate privileged operations. A complete organization-management UI is not established by this inspection. |
| Projects and tasks | `apps/api/src/routes/projects.ts`, `apps/api/src/routes/jobs.ts`, `apps/web/lib/api/live.ts` | Keep existing task creation, estimates, funding, verification, acceptance, and rejection calls. |
| Real dashboard | `apps/web/app/(app)/dashboard/page.tsx` | Preserve review queue, running/verifying task activity, usage display, and repository links. |
| Usage | `apps/api/src/routes/usage.ts`, `apps/web/lib/hooks/use-usage.ts` | Preserve organization-scoped totals, daily spending, and task counts. Additional requested KPIs require explicit data coverage. |
| Execution history | `packages/database/migrations/0006_execution_conversation_id.sql`, `0007_execution_events.sql` | Preserve conversation identity and persisted event storage. |
| Phase 2 client | `apps/web/lib/api/live.ts`, `apps/web/lib/hooks/use-execution-events.ts`, `apps/web/lib/execution-events.ts` | Retain API mapping, incremental polling, defensive payload parsing, and action/observation pairing. Adapt renderers around them. |
| Execution UI | `apps/web/components/tasks/execution-list.tsx`, `components/workspace/live-conversation-panel.tsx`, `terminal-activity-panel.tsx`, `file-changes-panel.tsx` | Keep as migration baseline and fallback until equivalent views pass regression checks. |
| Mock workspace | `apps/web/lib/api/index.ts`, `apps/web/lib/api/mock.ts`, `apps/web/lib/hooks/use-workspace-state.ts` | The exported `api` is mock-backed; `dashboardApi` is live-backed. Do not present the greenfield chat/preview experience as a connected planning service. |
| Agent runtime | `workers/coding-agent/src/coding_agent/agent_server_adapter.py`, `worker.py` | Preserve per-execution runtime ownership and event forwarding. Do not introduce another orchestrator. |
| Escrow | `contracts/solana`, `packages/solana-client` | Reuse the existing program and unsigned instruction builders. Client documentation explicitly says business API integration is not connected yet. |
| Agent profiles | `apps/web/app/(app)/skill-sets/page.tsx`, `apps/api/src/routes/agent-profiles.ts` | Preserve the route and profile configuration; distinguish profiles from authored skills. |

### Material gaps affecting migration

1. **Incremental events need stronger delivery semantics.** The hook uses the last `occurredAt` as its cursor, and the route filters with `occurred_at > after`. A late insertion with an older or equal timestamp can be missed. Preserve the implementation's structure while planning a server-issued ingestion cursor, deterministic ordering, pagination, and ID deduplication. A timestamp-plus-ID cursor alone does not solve late arrival of older events.
2. **Cache isolation requires explicit verification.** The event query key currently contains execution ID, without organization or task ID. Verify cache clearing on logout and organization changes; scope future adapter state to organization/task/execution and prevent stale in-flight responses from repopulating the wrong view.
3. **Transport typing is not runtime validation.** `apiFetch<T>` casts JSON; payload parsers defensively inspect selected event shapes. Add boundary validation where required without claiming all API responses are already validated.
4. **Recorded edits are not a complete file browser.** Event-derived file changes and terminal observations do not establish an authorized file listing/content service or interactive PTY.
5. **Payments are not confirmed blockchain activity.** Existing business routes and ledger transitions must not be relabeled as confirmed Solana transactions. The API/client connection and transaction reconciliation remain separate work.
6. **Planning persistence and permissions are missing integration work.** The mock workspace is not sufficient evidence of a restricted planning agent, editable server-validated draft, or explicit planning allowance.

## 2. Upstream source baseline

Official repository: [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands). Pinned source: [380fd839d6bcb1f9e1674ab0ff5c0225705118e8](https://github.com/OpenHands/OpenHands/tree/380fd839d6bcb1f9e1674ab0ff5c0225705118e8).

The inspected revision stores the frontend in root-level `src/`, not `frontend/src/`. Its package is `@openhands/agent-canvas` version `1.20.0`. It declares React/React DOM `19.2.8`, React Router `7.18.2`, Vite `8.0.16`, TanStack Query `5.101.4`, Zustand `5.0.14`, and `@openhands/typescript-client` `1.49.2`. Node engines require `>=24`, although its Volta metadata still specifies `22.12.0`; resolve this discrepancy in the isolated environment. [Pinned package metadata](https://github.com/OpenHands/OpenHands/blob/380fd839d6bcb1f9e1674ab0ff5c0225705118e8/package.json).

AtherNull declares Next.js `^16.3.5`, React `^19.0.0`, TanStack Query `^5.103.1`, and Node `>=20`. Shared major versions do not prove compatibility. The prototype must use resolved lockfile versions and ensure a single React runtime.

The source exposes an application build and a library build separately. The user's earlier report of mismatched npm JavaScript/declaration exports remains an input finding, not a result reproduced here. Do not make the migration depend on those package exports. Inspect source and execute both build/import smoke checks in the prototype.

## 3. Source reuse map

All upstream paths below refer to the pinned commit. “Candidate” means source reuse is proposed, not independently reusable or tested. Direct dependencies are based on inspected imports where stated; remaining transitive imports must be traced before copying.

| Surface | Exact upstream source | Coupling and proposed treatment |
| --- | --- | --- |
| Application entry/root | `src/root.tsx`; library entry `src/index.ts` | Root owns React Router document APIs, configuration bootstrap, backend selection/authentication, and telemetry banner. Library entry re-exports `./lib`. Keep AtherNull's root; do not transplant this bootstrap. |
| Conversation workspace | `src/routes/conversation.tsx` | Imports React Router hooks, several conversation/agent/command stores, `wrapper/event-handler`, `contexts/websocket-provider-wrapper`, cloud resume calls, and task polling. Reuse layout descendants after separating these controllers. |
| Chat | `src/components/features/chat/chat-interface.tsx` | Imports message send/upload hooks, WebSocket context, model/goal/conversation stores, tracking, i18n, scrolling, and file refresh behavior. Extract presentation and inject AtherNull actions; no unrestricted send hook reuse. |
| Composer | `src/components/features/chat/interactive-chat-box.tsx` | Confirmed by chat-interface import. Candidate for a controlled planning composer; full dependency inspection remains pending. |
| Event rendering/activity | `src/components/conversation-events/chat/messages.tsx`, `event-message.tsx`, `group-events.ts`, `event-content-helpers/get-event-content.tsx` | Tree-confirmed candidates. Adapt normalized AtherNull events; inspect renderer dependencies and unknown-event behavior before import. |
| Sidebar/history | `src/components/features/sidebar/sidebar.tsx`, `sidebar-rail-body.tsx`, `sidebar-conversation-list.tsx` | Sidebar directly imports settings/config queries, active-backend and navigation contexts, health probes, stores, and backend-management modals. Reuse navigation presentation, replace backend controls and history sourcing. |
| Terminal | `src/components/features/terminal/terminal.tsx` | Imports `hooks/use-terminal`, `stores/command-store`, agent-state hooks, and xterm CSS. Start with persisted read-only output; inspect the terminal hook before retaining any input handling. |
| File explorer | `src/routes/files-tab.tsx`; `src/components/features/files-tab/file-tree-view.tsx`, `file-content-viewer.tsx` | Route imports file queries, mutation counters, per-conversation local storage, i18n, resizing, and Vite SVG imports. Use authorized file adapters; Next.js needs an explicit replacement for `?react` SVG loading. |
| Diffs | File route explicitly places diffs/commits in a sibling Commits tab | Exact diff renderer dependency closure is not yet verified. Retain AtherNull's `file-changes-panel.tsx` until that inspection and a real diff-data contract are complete. |
| Browser preview | `src/components/features/browser/browser.tsx`, `browser-snapshot.tsx`, `browser-chrome-bar.tsx` | Inspected panel reads URL/screenshot from `stores/browser-store` and renders a PNG screenshot. This is not evidence of an interactive application preview server. Reuse for authorized recorded screenshots first. |
| Settings | `src/components/features/settings/settings-layout.tsx`, `settings-navigation.tsx`; `src/api/settings-service/settings-service.api.ts` | Tree-confirmed. Presentation candidates; backend schemas, secret handling, and mutations require separate inspection and mapping. |
| Skills | `src/components/features/skills/skill-card.tsx`, `skill-detail-modal.tsx`, `src/api/skills-service.ts` | Tree-confirmed. Preserve distinction between AtherNull profiles and authored skills; do not enable installation by copying controls. |
| MCP | `src/components/features/mcp-page/custom-server-editor.tsx`, `installed-server-card.tsx`; `src/api/mcp-service/mcp-service.api.ts` | Tree-confirmed. Candidate organization-managed integration UI after ownership and credential contracts exist. |
| Automations | `src/routes/automations-list.tsx`, `src/routes/automation-detail.tsx`; `src/api/automation-service/automation-service.api.ts` | Tree-confirmed. Defer operational reuse until an AtherNull-authorized automation backend exists. |

Source links: [component tree](https://github.com/OpenHands/OpenHands/tree/380fd839d6bcb1f9e1674ab0ff5c0225705118e8/src/components), [routes](https://github.com/OpenHands/OpenHands/tree/380fd839d6bcb1f9e1674ab0ff5c0225705118e8/src/routes), [API services](https://github.com/OpenHands/OpenHands/tree/380fd839d6bcb1f9e1674ab0ff5c0225705118e8/src/api), [root](https://github.com/OpenHands/OpenHands/blob/380fd839d6bcb1f9e1674ab0ff5c0225705118e8/src/root.tsx).

## 4. Architecture comparison

| Criterion | A: selected components in Next.js | B: customized full upstream fork | C: AtherNull-owned shell with source reuse |
| --- | --- | --- | --- |
| Routing | Bridge/remove React Router dependencies per component | Replace authenticated application routing with upstream routes; migrate business screens | Keep Next routes and expose narrow navigation adapters |
| React | Align versions and client-only dependencies | Upstream exact pins simplify fork baseline but complicate business-component migration | Keep one resolved React runtime; validate each imported dependency |
| State/providers | Risk of importing hidden global stores | Upstream stores remain coherent but need tenant-safe resets | AtherNull query cache owns server data; imported stores limited to view state |
| Authentication | Replace service calls behind imported controls | Replace bootstrap, backend registry, credentials, and cloud assumptions | Better Auth remains authoritative throughout |
| Backend fit | Good for display components; poor for connected screens | Requires broad compatibility surface for upstream services | Existing APIs remain canonical; add narrowly scoped missing capabilities |
| Maintenance | Small copies can accumulate incompatible patches | Largest merge surface and upstream feature churn | Maintain a documented source subset and adapter contract |
| Upgrade complexity | Per-component dependency tracking | Rebase whole frontend and revalidate business routes | Pin source, record changes, upgrade selected modules deliberately |
| Product cohesion | Achievable if one shell owns navigation | Strong upstream coherence; substantial AtherNull migration | Strong AtherNull coherence while adopting chat-first patterns |

**Can the complete frontend be the primary shell?** Technically plausible, but not demonstrated. It would require replacing backend-selection/auth bootstrap, conversation controllers, service contracts, and navigation while porting AtherNull business screens. The existence of a standalone build does not make that build compatible with this multi-tenant backend. Compare its actual adapter burden against selected reuse in the prototype before deciding finally.

## 5. Unified navigation and layout

Keep the public landing page at `/`. Proposed authenticated conversation home: `/conversations/new`, headed **What would you like to build?**

| Navigation | Destination and behavior |
| --- | --- |
| New conversation | `/conversations/new`; idea, repository, questions, or continue-project entry |
| Overview | Existing `/dashboard`; preserve current dashboard while expanding verified KPIs |
| Projects | Existing `/projects` and project details |
| Agents & Skills | Existing `/skill-sets`; profiles initially, authored skills distinctly labeled when supported |
| Automations | Proposed `/automations`; show availability honestly until supported |
| Recent conversations | Organization-scoped persisted planning/execution history; requires history contract |
| Active executions | Deep-link to selected task and execution attempt, not merely the project |
| Usage & Payments | Existing `/usage`; distinguish recorded usage, budgets, funding, and confirmed transactions |
| Integrations | Existing `/integrations`; expose only authorized operations |
| Organization Settings | Proposed `/settings/organization`; role-aware membership and organization controls |

Desktop: one sidebar, spacious conversation column, collapsible contextual panel. Panel tabs should cover Plan, Activity, Terminal, Files/Changes, and supported Preview content. Mobile: one navigation drawer and a switch between conversation and contextual content. Use consistent dark tokens, keyboard focus, readable typography, reduced-motion support, and clear loading/empty/error states. Replace branding without implying OpenHands affiliation.

## 6. Planning and live-workspace contracts

Planning drafts collect objective, repository/branch, requirements, constraints, task breakdown, acceptance criteria, budget, and agent profile. Save editable revisions under the active organization. Treat model output as proposed structured input; validate it server-side against repository permissions, profile policies, supported currency, and budget limits.

A planning allowance must be explicitly authorized and enforced before model usage. Planning tools cannot dispatch coding jobs, sign payments, or modify escrow. User approval creates a task using the existing `/v1/jobs` contract; funding and dispatch follow existing authorized transitions. Draft status is conversation metadata, not a competing execution lifecycle.

Execution presentation maps organization → project → task → execution attempt → persisted conversation ID. Feed Phase 2 events into adapted OpenHands message/activity components. Unknown events get a safe fallback; refresh reconstructs persisted history. Read-only terminal output and recorded file changes can ship before interactive controls. File listing, file reads, screenshots, interruption, message sending, and terminal input each require an explicit backend capability and authorization contract.

KPI sources must be explicit: projects from repository APIs; task statuses from jobs; costs from usage; budgets from validated tasks; verification from verification runs; funding and settlement from authoritative ledger/transaction records. Do not infer active execution counts solely from task counts when attempts can differ. Display unavailable data as unavailable, not zero or fabricated success.

## 7. Security, licensing, and payment boundaries

- Every API adapter must authorize organization, task, execution, conversation, file, and artifact relationships server-side. Browser-selected IDs are selectors, not authority.
- Preserve worker-only Agent Server session keys. Do not import upstream browser backend-registration/API-key flows into AtherNull.
- ADR-0005 records a remaining all-interface container-port publication gap. Verify the installed SDK/runtime, implement an appropriate restricted binding/network configuration, and test reachability before production. The existing per-execution key is not network isolation.
- Preserve privileged funding, verification, acceptance, and settlement checks. Display-only reuse must not introduce mutation side effects.
- Establish event redaction at ingestion/read boundaries. Defensive shape parsing is not secret sanitization. Avoid displaying raw reasoning fields by default; expose intended user-facing messages and action summaries.
- Inspect Markdown/HTML/URL rendering, terminal escape handling, path traversal/symlinks, preview origins, and screenshot sizes. Isolate interactive previews from application credentials if later supported.
- Upstream metadata includes `posthog-js`; root includes a telemetry consent banner. Actual emission behavior was not traced. Disable imported telemetry until inspected and explicitly configured.
- Pin copied source and transitive dependencies, retain a modification log, and inventory assets and dependency licenses. The pinned root license is MIT, copyright OpenHands contributors (2025), and requires retaining its copyright/permission notice in copies or substantial portions. This does not establish licenses for every asset or dependency. [Pinned LICENSE](https://github.com/OpenHands/OpenHands/blob/380fd839d6bcb1f9e1674ab0ff5c0225705118e8/LICENSE).
- Existing Solana builders return unsigned instructions. Keep signing outside agent tools. Devnet work must verify cluster/program identity, instruction/account compatibility, confirmations, idempotency, and reconciliation before showing completion. No Devnet validation was performed here. No Mainnet work or real financial transactions are included.
- Keep x402 separate from task escrow, with its own authorization and allowance if later introduced.

## 8. Proposed file-by-file implementation plan

These are proposed changes, not edits performed. Imported file destinations remain conditional on the prototype's verified dependency closure.

| Stage | File or directory | Proposed change |
| --- | --- | --- |
| Prototype | `prototypes/openhands-integration/README.md` | Record pinned revision, commands, compatibility findings, screenshots, and pass/fail evidence |
| Prototype | `prototypes/openhands-integration/upstream/` | Isolated source checkout; build application and library separately |
| Prototype | `prototypes/openhands-integration/adapters/` | Compare complete-shell adapter against selected-component adapters using sanitized persisted events |
| Provenance | `docs/openhands-source-manifest.md` | Record each copied source path, commit, license, dependencies, and modifications |
| Provenance | `apps/web/vendor/openhands/LICENSE` | Preserve upstream notice with imported source |
| Presentation | `apps/web/vendor/openhands/` | Import only approved presentation subset, preserving source correspondence |
| Adapters | `apps/web/lib/openhands/event-adapter.ts` | Map existing parsed events into presentation models |
| Adapters | `apps/web/lib/openhands/navigation-adapter.ts` | Bridge approved navigation context to Next.js routes |
| Adapters | `apps/web/lib/openhands/capabilities.ts` | Describe server-authorized available controls; server remains enforcement boundary |
| Shell | `apps/web/app/(app)/layout.tsx` | Install approved view providers within existing auth/query providers |
| Shell | `apps/web/components/app-sidebar.tsx` | Unified navigation and scoped history; retain one mobile/desktop content definition |
| Home | `apps/web/app/(app)/conversations/new/page.tsx` | Chat-first planning entry backed by real draft APIs |
| Planning | `apps/web/components/workspace/planning-panel.tsx` | Editable structured draft, allowance, validation, and explicit approval |
| Planning | `packages/contracts/src/planning.ts` | Validated draft/revision/approval contracts, proposed only |
| Planning | `apps/api/src/routes/planning.ts` | Organization-scoped draft and restricted planning operations; reuse job creation business logic |
| Planning | `packages/database/migrations/0008_planning_conversations.sql` | Tentative next migration name; verify sequence before use; draft ownership/history only |
| API registration | `apps/api/src/app.ts` | Register approved new routes |
| Client | `apps/web/lib/api/types.ts`, `live.ts` | Extend typed contracts for drafts/history and approved read capabilities |
| Events | `apps/api/src/routes/jobs.ts`, `apps/web/lib/hooks/use-execution-events.ts` | Preserve existing flow while adding reliable cursor, pagination, deduplication, and scoped cache semantics |
| Parsers | `apps/web/lib/execution-events.ts` | Retain validated shapes; extend only with real fixtures |
| Workspace | `apps/web/components/tasks/execution-list.tsx` | Embed approved display components and select execution attempts |
| Deep link | `apps/web/app/(app)/projects/[projectId]/tasks/[taskId]/page.tsx` | Support selected execution navigation and preserve review/funding controls |
| Overview | `apps/web/app/(app)/dashboard/page.tsx`, `apps/api/src/routes/usage.ts` | Preserve current views; add KPIs only with verified sources |
| Skills | `apps/web/app/(app)/skill-sets/page.tsx` | Preserve profiles, add separate authored-skill UI only when backend exists |
| Isolation | `workers/coding-agent/src/coding_agent/agent_server_adapter.py` | Resolve port publication and version pinning after installed-runtime verification |
| Tests | `apps/api/test/tenant-authorization.test.ts`, `job-lifecycle.test.ts` | Add adapter/draft/capability cases without changing business invariants |
| Documentation | `docs/openhands-migration.md` | Feature inventory, rollout gates, fallback, source updates, and rollback |

No current dashboard, workspace component, or mock implementation is proposed for immediate deletion. Retire overlapping code only after consumers have migrated, behavior is covered, and the replacement is approved. Payment integration deserves its own file-level design after Devnet investigation; naming speculative signer code here would imply decisions not yet made.

## 9. Prototype and validation gates

The isolated prototype must compare both the full standalone shell and selected source reuse. It must not become a second deployed product.

1. Build the pinned standalone source with a compatible Node version and locked dependencies; record generated routes, bundle sizes, and provider requirements.
2. Execute library imports and inspect JavaScript exports versus declarations; reproduce or disprove the reported package issue explicitly.
3. Render representative persisted events through selected chat/activity/terminal components. Cover messages, terminal actions/observations, file edits, finish actions, errors, and unknown payloads.
4. Exercise a controlled Agent Server through an AtherNull-authorized backend adapter. Keep keys worker-side; do not start paid coding runs implicitly for a UI smoke test.
5. Verify Next navigation, single React runtime, client-only editor/terminal loading, i18n assets, SVG handling, CSS isolation, and provider cleanup.
6. Test refresh/reconnection, duplicate events, equal timestamps, late inserts, pagination, attempt switching, organization switching, logout, and membership revocation.
7. Verify keyboard/mobile behavior and history persistence. File/browser controls must reflect actual data availability and capabilities.
8. Produce a measured reuse inventory: copied files, adapter changes, unsupported features, dependency footprint, and full-shell versus subset maintenance cost.

Only then present the final architecture and migration diff for approval, as required by the supplied brief. Subsequent implementation should use a reversible feature flag, preserve existing routes, and use additive migrations. Rollback should restore the current presentation without deleting execution or planning history. Run build, type checks, API lifecycle/tenant tests, event integration tests, and browser regressions before rollout. No production deployment is authorized by this report.

## 10. Deliverable status

| Deliverable | Status |
| --- | --- |
| AtherNull inventory | Initial source-based assessment completed; exhaustive audit remains open |
| OpenHands reuse map | Pinned source candidates and selected direct dependencies documented; full closure/diff inspection open |
| Architecture comparison | Completed as a provisional recommendation |
| Unified layout/navigation | Proposed specification completed |
| File-level plan | Proposed changes documented; final import list depends on prototype |
| Licensing/security assessment | Initial boundaries and license evidence documented; dependency/runtime verification open |
| Isolated prototype | Not implemented under the current no-code instruction |
| Main application migration | Not started |

The next implementation milestone is the isolated compatibility prototype, followed by an evidence-backed architecture decision. Existing AtherNull functionality and Phase 2 plumbing remain the foundation throughout.


## Commit-readiness follow-up (2026-09-22)

The assessment above describes its original working-tree baseline. Subsequent
review fixes replaced timestamp-based incremental polling with ordered complete
snapshots, added task ID to the event query key, and added a final completion
fetch. The worker now flushes on a timer and preserves partial history during
failed-run cleanup. Ingestion-based pagination and organization-switch cache
verification remain future work. The mobile shell now stacks navigation above
the page, and the repository link is labeled "Source revision".

Validation after those fixes: repository typechecks, the production web build,
9 API tests, and 13 Python tests passed. Migrations 0006 and 0007 were applied to
the local `athernull_test` database for API regression coverage. Browser and live
Docker/Agent Server validation were not repeated in this follow-up.
