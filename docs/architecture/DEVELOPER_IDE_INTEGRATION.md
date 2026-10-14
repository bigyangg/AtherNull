# Developer IDE integration

Status: proposal for review. Nothing here is implemented yet.
Date: 2026-10-14.

## 1. Why

AtherNull serves two kinds of people:

| Person | Wants | Front door |
|---|---|---|
| Non-technical customer | Describe it, approve it, pay, get a verified result | **Agent-first canvas** (today) |
| Developer | All of that, plus seeing and changing the code, running it, debugging, and taking over from the agent or handing back | **Canvas + IDE** on the same workspace |

Today a developer cannot see inside a build. When a run breaks, the only remedy is a retry that starts the attempt over (see section 7). An IDE on the same workspace turns "wait and retry" into "open it, fix it, hand back".

Principle: **one workspace, two views.** The IDE is not a second product or a second agent platform. It shows the same sandbox, repository, plan, escrow and independent verification.

## 2. What already exists (verified 2026-10-14)

| Fact | Evidence |
|---|---|
| Every sandbox image ships **OpenVSCode Server** (browser VS Code, Open VSX extensions) | `/openhands/.openvscode-server/bin/openvscode-server` in `ghcr.io/openhands/agent-server@sha256:36e98f13…` |
| It **already runs** in every sandbox, on port **8001**, opening `/workspace` | Agent server log: "VSCode server started successfully on port 8001"; `GET /api/vscode/status` → `{"running":true,"enabled":true}` |
| It is protected by a **connection token** | `GET /api/vscode/url` (session key required) → `http://localhost:8001/?tkn=<64 hex>&folder=workspace`; without the token: 403 |
| Its cost is already paid | Idle sandbox including VS Code: ~460 MB |
| Our gateway **blocks** it today | `agent-gateway/policy.ts` is fail-closed; `/api/vscode/*` is not on the allow-list |
| Our gateway already proxies **WebSockets** (VS Code needs them) | `routes/agent-gateway.ts` handles upgrades for the agent's event stream |
| Port 8001 is **not published**; sandboxes sit on the isolated network | `sandbox/policy.ts`: no `-p` with `SANDBOX_NETWORK`; host firewall per `docs/runbooks/sandbox-network.md` |
| Builds live in **`/workspace/builds/<taskId>`**, and each attempt **deletes and re-clones** that folder | `org_sandbox_adapter.py` `_prepare_hosted_repository`: `rm -rf workdir && git clone … && checkout -B builds/<taskId> <start>` |
| The agent server can **pause** a conversation | Used today by usage enforcement (`POST /api/conversations/{id}/pause`) |

So phase 1 is mostly routing and security work, not building an IDE.

## 3. The developer experience

1. **Open IDE** from the canvas sidebar or a build panel. A new tab opens VS Code on the workspace. With a build selected, it opens that build's folder.
2. **Watch.** While the agent builds, files change live in the editor. The agent's chat stays in the canvas.
3. **Take over.** The developer clicks *Take over* in the build panel (or the IDE status bar):
   - the agent pauses;
   - a checkpoint commit saves its work.
4. **Work.** The developer edits, runs the app and the tests in the IDE terminal, and commits on the build's branch.
5. **Hand back** with an optional note ("I fixed the router, finish the tests"). The agent resumes from the developer's commit with a short handoff summary.
6. **Or finish it themselves.** *Submit for checks* sends the developer's commit to the same independent verifier. Accept and payout work exactly as today.

Non-technical customers never see any of this unless they click *Open IDE*.

## 4. Architecture

```
Browser ──► athernull.io/ide/<orgShortId>/…   (Traefik → ingress → apps/api)
              │  AtherNull session cookie, organization membership
              ▼
          apps/api  IDE gateway
              │  1. resolve the org's sandbox (org_agent_servers)
              │  2. GET /api/vscode/url with the session key (server-side only)
              │  3. proxy HTTP + WebSocket to <sandbox>:8001, adding the
              │     connection token itself; the browser never sees it
              ▼
          org sandbox (isolated network, firewall)
              ├─ agent server :8000   (conversations: discussion, builds)
              └─ OpenVSCode   :8001   (/workspace, incl. builds/<taskId>)
```

Design points:

- **Same-origin path, not a subdomain**: `/ide/<orgShortId>/`. The session cookie applies with no cross-site cookie work. OpenVSCode supports a base path (`--server-base-path`), which must be set when the sandbox starts (a run-policy change, so sandboxes are recreated on their own volumes; see `policy.ts` fingerprint).
- **The token never reaches the browser.** The gateway injects it, or exchanges it once for VS Code's own cookie on a gateway-controlled path. A leaked URL alone must never open someone's IDE.
- **Authorization**: organization members only. Who may edit vs view could follow org roles (owners and admins edit; members view) — decision D3.
- **Deep links**: `/ide/<org>/?folder=/workspace/builds/<taskId>` opens a build directly.
- **Idle stop** (planned, WORKSPACE_ONBOARDING.md): opening the IDE wakes a stopped workspace through the same setup screen.

## 5. Takeover protocol

The build folder is shared by the agent and the developer, so control must be explicit.

| State | Who edits | Entered by |
|---|---|---|
| `AGENT` | the agent | build start, *Hand back* |
| `DEVELOPER` | the developer | *Take over* (agent paused, checkpoint committed) |
| `CHECKING` | nobody | *Submit for checks*, or the agent finishing |

Rules:

1. **Take over**: pause the build's conversation, then `git add -A && git commit` a checkpoint on `builds/<taskId>`, then push it to the hosted repository (the existing result-bundle path). Only then does the panel say "You have control".
2. **While `DEVELOPER`**: the worker holds the build's lease, does not resume the agent, and does not count the wait against the agent's run cap or the retry budget.
3. **Hand back**: the developer's latest commit becomes the attempt's start commit (the same mechanism as change rounds: `startCommit`). The agent gets a handoff note: what the developer changed (`git diff --stat` plus their note) and what is left.
4. **The re-clone must not destroy work.** An attempt may only `rm -rf` and re-clone when the folder has no uncommitted changes, or after committing them as a checkpoint first. This is a required worker change (section 2).
5. **Timeouts**: a takeover left idle for N hours (D4) releases the lease, keeps the checkpoint, and marks the build *paused by developer*. Nothing is lost and nothing is charged.
6. **Concurrency**: one controller at a time. Two developers in the same org see who has control.

## 6. Escrow, verification and pricing

- **Verification is unchanged and independent**: whatever mix of agent and developer commits, the verifier checks the final commit, with no network, before any payout.
- **Escrow is unchanged**: funding before the build; settle on Accept, refund on Reject or failure.
- **Agent work is metered and developer work is free.** Usage events already record agent tokens per execution. Time a developer holds control is not agent time (D5: whether developer-heavy builds should have a cheaper tier).
- **Provenance**: commits record their author (agent or developer), so the delivered summary can say who did what.

## 7. Resilience: resume instead of restart

The same mechanics fix the costly restarts of today:

| Failure | Today | With this design |
|---|---|---|
| Checks fail | Fix round from the failed commit (cheap) | Unchanged |
| Agent run crashes or times out | Retry from the attempt's start, new chat, all work lost | Resume from the **last checkpoint** with a short handoff note |
| Worker restarts mid-build | Lease expires, retry from the start | Same as above |
| Developer fixes it | Not possible | Take over, fix, hand back or submit |

Checkpoints are written periodically during agent runs and on every takeover, so a crash late in a build costs minutes, not the whole build.

## 8. Developers who work locally

| Need | Approach | Phase |
|---|---|---|
| Use git from their own machine | HTTPS git endpoint for hosted repositories (`/git/<org>/<project>.git`), personal access tokens scoped to an organization, read and push to `builds/*` branches only (main stays server-controlled) | 3 |
| Stay in desktop VS Code | An **AtherNull extension**: chat with the agent, see the plan and bill, pay, take over and hand back, see checks — talking to the same API | 3 |
| A terminal workflow | `athernull` CLI over the same API (later) | 4 |

## 9. Security

| Threat | Control |
|---|---|
| Someone opens another org's IDE | Gateway checks session plus organization membership on every HTTP request and WebSocket upgrade; the org is resolved from the session, not trusted from the URL alone |
| Leaked IDE URL | The VS Code token stays server-side; the URL carries no secret |
| The IDE terminal attacks the host or other customers | It runs inside the customer's own sandbox: isolated network, host firewall, no Docker socket, dropped capabilities, CPU/memory/pid limits (`policy.ts`) |
| The terminal reads the deployment's LLM key | **Already true for the agent**; an IDE makes it one click away. The LLM proxy (PRE_LAUNCH_SECURITY_GATES G0.2) becomes **required before developer access opens**. |
| Malicious VS Code extensions | Open VSX only; an extension allow-list or "no marketplace" setting per deployment (D6); extensions run inside the sandbox, so the blast radius is that workspace |
| Developer pushes something that skips checks | Payout only follows independent verification of the final commit; the `main` branch is never developer-writable |
| Cross-site attacks on the IDE | Same-origin path; the gateway checks `Origin` on WebSocket upgrades; frame-ancestors limited to our own origin |
| Resource abuse (crypto mining in the terminal) | Per-sandbox CPU/memory limits; idle stop; usage alerts per workspace |

## 10. Phases

| Phase | Scope | Done when |
|---|---|---|
| **1. Browser IDE** | IDE gateway (HTTP + WebSocket proxy, token injection), base path in the run policy, *Open IDE* in the canvas and build panel, deep links to build folders | A signed-in member opens VS Code on their workspace from athernull.io; another org's member gets 403; the URL alone opens nothing |
| **2. Takeover and checkpoints** | Control states, pause/resume, checkpoint commits, non-destructive re-clone, handoff notes, *Submit for checks*, resume-from-checkpoint after crashes | A developer takes over mid-build, fixes, hands back, and the agent continues from their commit; a killed worker resumes from the last checkpoint |
| **3. Local developers** | Git over HTTPS with scoped tokens, desktop VS Code extension | Clone, commit and push to a build branch locally, then hand back or submit from the extension |
| **4. Developer pricing and polish** | Agent-only metering in the bill, developer tier, authorship in the delivered summary, CLI | Bills distinguish agent and developer work |

Prerequisite for opening phase 1 to external developers: the **LLM proxy** (section 9).

## 11. Risks and open questions

- **CPU contention.** On the VPS each sandbox has 1 CPU, shared by the agent server, VS Code and the agent's commands. An active IDE may slow the build; consider 2 CPUs for workspaces with an open IDE (D7).
- **Upstream coupling.** The base-path flag and `/api/vscode/*` belong to the pinned agent server; pin and test them like the canvas patches.
- **Two writers.** Section 5 rule 4 (non-destructive re-clone) is mandatory before takeover ships.
- **Mobile**: the IDE is desktop-only; the canvas stays the mobile experience.

## 12. Decisions needed

| # | Question | Proposal |
|---|---|---|
| D1 | IDE for every account, or developer accounts only? | Every account, behind an *Open IDE* button; non-technical users simply never click it |
| D2 | Path or subdomain? | Path `/ide/<org>/` (same origin, simplest cookies) |
| D3 | Who may edit? | Owners and admins edit; members view |
| D4 | Idle takeover timeout | 2 hours, then release with the checkpoint kept |
| D5 | Pricing for developer-heavy builds | Agent usage only; decide on a developer tier after phase 2 |
| D6 | VS Code extensions | Open VSX with an allow-list |
| D7 | Workspace size with an open IDE | 2 CPUs while the IDE is open, if the host allows |
| D8 | Order | Phase 1, then phase 2's checkpoint and non-destructive re-clone, then takeover |
