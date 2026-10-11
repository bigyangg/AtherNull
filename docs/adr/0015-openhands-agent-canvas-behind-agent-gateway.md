# ADR-0015: The OpenHands Agent Canvas behind an AtherNull agent gateway

Status: Accepted, implemented and verified locally
Date: 2026-10-11
Supersedes the UI half of ADR-0006 (which chose the OpenHands frontend but
only ever wired it to a read-only compatibility layer).

## Context

The product requirement is that the workspace be *the* OpenHands canvas —
with its integrations (MCP servers, skills, plugins, git providers,
automations, canvas extensions), terminal, VS Code, files and browser — not
an imitation. A custom Next.js canvas (built first) covered AtherNull's
lifecycle but none of that.

At the pinned commit (`380fd839…`, `@openhands/agent-canvas` 1.20.0) the
OpenHands frontend is "Agent Canvas": a client for a long-lived **OpenHands
Agent Server**. Every integration lives on that server (`/api/settings`,
`/api/skills`, `/api/plugins`, `/api/settings/mcp/*`,
`/api/canvas-extensions`, …), and the canvas talks to it directly, with an
`X-Session-API-Key` and two WebSockets (`/sockets/events/:id`,
`/sockets/bash-events`) that authenticate with an in-band auth frame.
Verified live: the unmodified canvas runs against agent-server 1.49.2 (its
pinned version; minimum 1.28).

AtherNull's non-negotiables still apply: no agent work before funding, the
browser never holds sandbox credentials, tenant isolation is enforced
server-side.

## Decision

```
browser (one origin)
  /canvas/**   Agent Canvas (pinned upstream + 1 patch), static build
  /oh/**       apps/api agent gateway  ── session + org + policy ──┐
  /, /projects AtherNull app (also framed inside the canvas)        │
                                                                    v
                      org's sandboxed Agent Server (Docker, 127.0.0.1 only)
                                                                    ^
  worker (EXECUTION_ADAPTER=org_sandbox) ── funded build = conversation ┘
```

1. **One sandboxed Agent Server per organization** (`org_agent_servers`,
   migration 0015), started by `pnpm --filter @athernull/api
   sandbox:provision -- --org <id>`: Docker, published on loopback only, its
   own generated session key, NIM LLM configured, telemetry consent "no",
   and the AtherNull Builds canvas extension installed and enabled.

2. **Agent gateway** (`apps/api/src/routes/agent-gateway.ts`, mounted at
   `/oh`) is the canvas's only backend. The canvas is served from the same
   origin, so the Better Auth session cookie authenticates it with no
   frontend auth change. Per request: session + org membership, `Origin`
   check on mutations, the access policy, then the org's sandbox with its
   key injected. Whatever key the canvas sends is dropped; cookies and
   sandbox `Set-Cookie` never cross. Both sockets are terminated and
   re-opened upstream with the real key; the browser's auth frame is
   discarded.

3. **Access policy** (`agent-gateway/policy.ts`, pure, fail-closed):
   - *read* (members): GETs, except secret material.
   - *control* (owner/admin): settings, MCP, skills, plugins, profiles,
     secrets, Apps, files, bash; pause/interrupt; reads that can expose
     secrets (secret values, LLM connections, file download/archive).
   - *agent* (owner/admin **and** the conversation is this org's funded
     build that is `RUNNING`): sending messages (REST or over the events
     socket), run, ask, fork, goals, model switches.
   - *blocked*: creating conversations (only AtherNull does, after
     funding) and the server's raw LLM proxy (`/v1/*`); anything unknown.

4. **Funded build = conversation.** The worker's `org_sandbox` adapter
   (REST only, so it is independent of the SDK version pinned for the
   per-execution adapters) puts the repository into
   `/workspace/builds/<taskId>` (git clone, or an uploaded git bundle for a
   repository only the worker host can reach), starts the conversation with
   the routed model, reports its id, forwards events and token usage, and
   reports the outcome. The build appears live in the canvas, where an
   owner/admin can steer it while it is `RUNNING`.

5. **AtherNull inside the canvas.** The *AtherNull Builds* canvas extension
   (`apps/canvas/extension/athernull`) adds a rail item that frames the
   AtherNull app (same origin) for plan → budget → devnet funding → review
   → settlement; framed, the app drops its own sidebar and links running
   builds back to their canvas conversation. One upstream patch
   (`apps/canvas/patches/0001-…`) makes the canvas's "start conversation"
   hand the prompt to that page when `VITE_ATHERNULL_BUILDS_URL` is set.

6. **Pinned, patched upstream — not a silent fork.** `apps/canvas`
   holds `UPSTREAM.json` (repo + commit), the patches, `setup.mjs`
   (fetch pinned commit, apply patches idempotently, install) and
   `build.mjs` (`/canvas` base, `<origin>/oh` backend). The checkout is
   gitignored.

7. **AtherNull mode in the canvas** (`VITE_ATHERNULL`, patches 0002–0003,
   `apps/canvas/brand.mjs`):
   - No AtherNull session → the canvas redirects to AtherNull sign-in and
     back, instead of reporting a disconnected backend.
   - Product branding (logo, favicon, title, product-surface copy) is
     AtherNull's; references that are genuinely OpenHands (the OpenHands
     agent and its icon, the skills registry, OpenHands Cloud) stay.
   - Automations are disabled: they start agent runs on schedules/webhooks
     by calling the sandbox directly, which would bypass the funded-build
     rule. Also hidden: the OpenHands community Slack step and npm update
     prompts (the canvas version is pinned).

8. **Single origin locally** via `infrastructure/ingress/dev-ingress.mjs`;
   production does the same path routing in its reverse proxy.

## Consequences

- The real OpenHands canvas, integrations included, with AtherNull's money
  and authorization rules enforced server-side. Verified in a browser:
  canvas through the gateway, a funded build running as a sandbox
  conversation (NIM, 15 events, SUCCEEDED → VERIFYING) and shown natively,
  the home prompt handed to AtherNull Builds.
- Each org has an always-on container. Sandbox isolation remains ADR-0002's
  open question (Docker today; gVisor/microVM for multi-tenant hosts).
- The sandbox key is stored in Postgres (`org_agent_servers`); it unlocks
  only a loopback-bound container. The worker receives it in the claim
  response (trusted infrastructure); the browser never does.
- Single gateway instance assumption (as ADR-0007 §4b) for socket bridging.
- Not yet covered: VS Code's separate port (`/vscode` routing),
  funding-aware automations, per-org connection limits, upgrading the
  pinned canvas (1.26 is available) — each is additive.
- The per-execution `agent_server` adapter and the custom Next.js canvas
  remain for orgs without a sandbox.
