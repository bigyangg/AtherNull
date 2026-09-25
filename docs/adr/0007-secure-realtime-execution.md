# ADR-0007: Secure realtime execution access

Status: Accepted
Date: 2026-09-26

## Context

ADR-0006 adopted the full OpenHands frontend for **historical** execution
review only, and explicitly deferred live-execution streaming as unresolved
future work: *"how a browser would ever reach a live, still-running Agent
Server session for real-time terminal/streaming UX without exposing the
per-execution `SESSION_API_KEY`... is unresolved... needs its own ADR
before it's attempted."* This ADR is that work.

The question is specific: **how can an authenticated AtherNull user watch
and interact with a currently running OpenHands execution in real time,
without ever exposing `SESSION_API_KEY` to the browser and without
directly exposing the Agent Server's Docker container to the network?**

This phase is design-only. No implementation code is written here — see
the companion design doc
(`docs/openhands-workspace-integration-phase3-design.md`) for the
grounding audit and the specific technical answers this ADR's decisions
rest on.

### What this session confirmed, by reading real source (not assumed)

- **The pinned OpenHands frontend's live sockets are genuinely
  bidirectional, not display-only.** `/sockets/bash-events` lets the
  browser submit a shell command to run; `/sockets/events/:id` lets the
  browser submit a chat message directly over the socket. This is a real,
  load-bearing product requirement for parity with upstream OpenHands, not
  an optional nice-to-have this design can skip.
- **The credential for both sockets travels inside the first WebSocket
  message frame** (`{"type": "auth", "session_api_key": ...}`), not the
  handshake URL, a header, or a subprotocol — identical on both the
  frontend and the Python SDK client. A gateway that wants to mediate this
  safely cannot be a transparent byte-for-byte proxy; it must terminate the
  browser's socket itself and speak its own, separately authenticated
  connection to whatever holds the real key.
- **The Agent Server's own action surface (send message, run, pause,
  interrupt, confirm/reject) is REST, not WebSocket**, on the SDK's side —
  the WebSocket the SDK opens is receive-only except for that one
  authentication frame. The frontend's own direct WS-send behavior for
  chat/bash is a frontend-specific convenience the Agent Server also
  accepts on those same sockets, separate from the SDK's usage pattern.
- **The container is alive and reachable from the worker process for the
  execution's entire `RUNNING` span** — `DockerWorkspace(...)` blocks until
  the container is healthy, and teardown (`cleanup()`) only happens in the
  dispatch's `finally` block, after `.run()` returns. The worker process
  already holds the per-execution `SESSION_API_KEY` in memory for exactly
  this same span. Today's worker is a single-dispatch, outbound-polling
  loop with no listening server of its own — it has never needed to accept
  an inbound connection.
- **ADR-0005's residual gap is still open.** `DockerWorkspace`'s installed
  code still runs `docker run ... -p {host_port}:8000`, publishing the
  container's Agent Server port to all host interfaces, not loopback —
  confirmed by reading the currently-installed SDK source directly, not by
  trusting the ADR's historical description. No subclass or override
  exists anywhere in `workers/coding-agent`.
- **`apps/api` has zero realtime infrastructure today** — no WebSocket
  library, no pub-sub, no broker. This is a from-scratch build, though
  Fastify (already in use) has first-party WebSocket support available to
  add.
- **The historical event log is already the right foundation for
  reconnect.** `execution_events.id` is the OpenHands event's own UUID;
  ingestion is already `ON CONFLICT (id) DO NOTHING`, and the worker
  already does a post-run gap-fill resync against the container. A
  realtime design does not need a new event log — it needs a live tail on
  top of the one that already exists.

### Clarifications required before acceptance

The initial (Proposed) version of this ADR was reviewed and returned with
five required tightenings before acceptance. All five are load-bearing
decisions, folded into the Decision section below, not appendices:

1. `requireOrgSession` establishes identity and org membership, but must
   not be treated as sufficient authorization to send commands into a
   running execution — a separate `realtime:control` capability is
   required, distinct from `realtime:view`.
2. The claim "the existing `execution_events` table solves reconnect" is
   only true for the Agent→Browser direction. Browser→Agent commands need
   their own explicit delivery semantics (an envelope with an id and a
   terminal outcome), because a dropped connection after sending a command
   leaves genuine uncertainty about whether it executed — this must be
   decided intentionally, not left implicit.
3. The worker-to-gateway tunnel must not authenticate as "the worker for
   execution X" on possession of the shared `INTERNAL_API_TOKEN` alone —
   it must be checked against the execution's own `lease_owner`, the same
   primitive `apps/api/src/routes/internal.ts` already uses to prevent one
   worker from acting on another's claimed execution.
4. Cookie-authenticated WebSocket upgrades are not protected by ordinary
   CORS the way `fetch` calls are — the gateway must explicitly validate
   `Origin` on the upgrade request, not rely on same-origin hosting alone
   to imply it.
5. The history→live handoff (the moment a browser's replay-from-Postgres
   catches up to the live tail) needs explicit invariants, not an assumed
   clean cutover — an event occurring in the gap between "fetch history"
   and "attach to live" must not be silently dropped.

## Decision

**Adopt a worker-mediated relay topology**: the coding-agent worker — not
`apps/api`, and never the browser — is the only process that ever
originates a connection to the container's Agent Server, and it does so
using the `SESSION_API_KEY` it already generates and holds today. The
worker gains a new, additional responsibility during a `RUNNING`
execution: maintain an **outbound**, authenticated tunnel to `apps/api`
(matching the existing trust direction — the worker already only ever
calls out to `apps/api`'s `/internal/*` routes, never the reverse), over
which it relays the container's live event stream one way and accepts
translated action commands (chat message, run-bash, interrupt) the other
way, re-issuing them against the container using the real, in-memory
session key exactly as `agent_server_adapter.py` already does for its
existing REST calls.

`apps/api` hosts a **realtime gateway** that:

1. Authenticates the browser exactly as the historical compatibility layer
   does today — a real Better Auth session, `requireOrgSession`, no new
   credential type.
2. Resolves execution ownership using the same org-scoped resolver
   (`resolveConversationTarget`) already built and tested in Phase 2 — no
   second resolution implementation, no new identity concept.
3. Rejects the connection outright unless that execution is currently
   `RUNNING` and has an active worker tunnel; otherwise directs the client
   back to the existing historical view (nothing new needed there).
4. Brokers between the browser's WebSocket and the owning worker's tunnel
   for that specific execution only — translating and re-authorizing every
   inbound browser action before relaying it, never passing it through
   unexamined.
5. Never receives, stores, or logs `SESSION_API_KEY`. The gateway's leg to
   the worker uses its own credential (an extension of the existing
   `INTERNAL_API_TOKEN` trust boundary, scoped per-execution — exact
   mechanism is implementation, not decided here), and the worker's leg to
   the container uses the real key, which never leaves the worker process.

**Rejected alternative: `apps/api` or the browser connecting directly to
the container.** This would require exposing the container's network
reachability beyond the worker's own host, would reintroduce exactly the
kind of network-boundary risk ADR-0005 already flagged as unresolved, and
would force the credential-forwarding problem onto a component (`apps/api`
or the browser) that this integration's entire design principle says must
never hold it. The worker already holds the key and already owns the only
process boundary where holding it is acceptable — reusing that boundary is
strictly safer than creating a new one.

**Corollary — the port-exposure gap is now a blocking prerequisite, not a
tracked nice-to-have.** ADR-0005 accepted `DockerWorkspace`'s
all-interfaces port publishing as a residual gap on the reasoning that the
container was an internal implementation detail. Making a running
container's liveness and responsiveness a customer-facing, revenue-gating
feature (rather than an invisible backend detail) raises the stakes on
that same gap substantially. **This ADR requires the loopback-only port
fix to land as its own phase (Phase 3A, §"Phase sequencing" below) before
any relay implementation begins.**

**View and control are two distinct, separately checked capabilities —
`requireOrgSession` alone authorizes neither.** `requireOrgSession`
establishes who the user is and which org they belong to; it does not by
itself mean a member may send commands into a running execution. This ADR
defines two capabilities:

- `realtime:view` — subscribe to the event stream, observe tool activity,
  watch terminal output. Gated on `requireOrgSession` plus the existing
  org-scoped execution resolver, matching Phase 2's read-only bar.
- `realtime:control` — send a chat message, execute a command, or
  otherwise mutate a running execution. Gated on everything `view`
  requires, **plus** an explicit control-authorization check (the concrete
  RBAC rule is an implementation decision, following AtherNull's existing
  authorization model — not specified here), **plus** `execution.status ==
  RUNNING` and a currently-valid lease. A connection with only `view`
  authorization must have inbound command messages rejected by the
  gateway, not silently downgraded to a no-op.

**Browser-to-agent messages are permitted under `realtime:control` only,
and only as an AtherNull-owned authorization decision — never an OpenHands
one.** The frontend's real behavior (chat-send and bash-exec are
genuinely interactive, not read-only) is accepted as a real requirement.
But every such action is intercepted and re-validated by the gateway
before being relayed — including whether the caller currently holds
`realtime:control`, and whether the task's business state makes customer
intervention appropriate at all. OpenHands has no concept of AtherNull's
authorization rules; the gateway is where those rules are enforced, per
ADR-0006's original responsibility split.

**Every browser→agent command needs an explicit delivery envelope and a
terminal outcome — the existing event log does not cover this
direction.** `execution_events` (idempotent by event UUID) fully solves
replay for the Agent→Browser direction: it is the real, persisted history,
and nothing new is needed there. It does **not** by itself resolve what
happens when a browser sends a command and the connection drops before an
acknowledgement arrives — retrying blindly risks double execution,
which matters more once a command can be a chat message that triggers
further agent work, not just a terminal keystroke. Every interactive
request must therefore carry at minimum `{commandId, executionId, type,
payload}`, and the gateway must respond with an explicit terminal outcome
(`accepted` / `rejected` / `executed` / `failed`) rather than silence. This
ADR requires that decision to be made explicitly during implementation —
at-most-once delivery with uncertainty surfaced honestly to the user is
one acceptable v1 answer; a small durable command-envelope store enabling
idempotent retry is another — but it must be a deliberate choice, not an
implicit assumption inherited from the output-side persistence model.

**The worker-to-gateway tunnel authenticates as a specific execution's
current lease holder, not merely as a valid worker.** Possession of the
shared `INTERNAL_API_TOKEN` proves a process is a legitimate AtherNull
worker; it does not prove it is *this execution's* worker. The tunnel
registration must present `{INTERNAL_API_TOKEN, workerId, executionId}`,
and `apps/api` must verify `executions.lease_owner == workerId` and
`executions.status == RUNNING` before registering that connection as the
active relay for that execution — reusing the exact lease primitive
`apps/api/src/routes/internal.ts` already enforces for claim/heartbeat/
complete, rather than introducing a parallel notion of worker identity.

**The browser WebSocket upgrade must validate `Origin` explicitly, not
rely on same-origin hosting alone.** ADR-0006's corrected topology finding
means production serves the frontend, `apps/api`, and this gateway from
one origin — but ordinary CORS protections do not apply to a WebSocket
upgrade the way they do to `fetch`, and a cookie-authenticated upgrade
from an unexpected `Origin` is a real cross-site risk this design must
close, not assume away. The gateway checks, in order: Better Auth session,
`Origin`, organization membership, execution ownership/scope, and the
view/control capability — same-origin hosting and explicit `Origin`
validation are complementary, not substitutes for each other.

**Reconnect and event reconciliation build on the existing, already-proven
persistence for the Agent→Browser direction, with explicit invariants for
the history→live handoff.** On any connection or reconnection, the
gateway must guarantee: no event disappears during the transition from
"replay persisted history" to "attach to the live tail"; duplicate
delivery across that transition is safe; persisted `execution_events`
remains the reconnect source of truth; and the event's own UUID remains
the deduplication identity throughout. One acceptable mechanism (not
mandated) is for the gateway to begin buffering the live tail before
fetching persisted history, then dedupe-and-release the buffer once
history is loaded — the exact mechanism is an implementation choice, but
these four invariants are not.

**Execution completion is a server-driven, authoritative event, not a
client-inferred one.** The gateway must observe the same
task/execution-status transition `apps/api`'s own `/internal/.../complete`
handler already produces and use it to close every browser connection
attached to that execution with an explicit terminal reason, falling back
automatically to the existing historical compatibility view. The browser
must never be responsible for deciding an execution is "done."

**Tenant isolation carries over unchanged in kind, but realtime introduces
a new resource-exhaustion risk polling never had**: a gateway connection
is a held resource, not a stateless request. Per-organization connection
and rate limits are required as part of this design, not an optional
hardening pass added later.

**This design assumes one realtime gateway instance, or deterministic
connection affinity, for v1 — explicitly, not by oversight.** A browser's
socket and its execution's worker tunnel must currently land on the same
`apps/api` process; nothing here provides cross-instance routing. If
`apps/api` is ever horizontally scaled behind a load balancer without
sticky/affinity routing, a browser and its worker tunnel could land on
different instances with no way to bridge them, and this design would
need shared pub/sub or session routing added. **Not solved in this phase**
— recorded here so it is a known, intentional boundary rather than a
surprise.

## Phase sequencing

Implementation is split into five sub-phases, each independently
verifiable, with the security-and-reliability-heaviest step (browser→agent
control) deliberately last:

- **Phase 3A — fix Agent Server network exposure.** Bind the container's
  Agent Server port to loopback (or a narrower Docker-network-only design,
  if the runtime allows it) instead of `0.0.0.0`. Blocking prerequisite for
  everything below. Acceptance is empirical, the same evidentiary bar
  Spike C's adapter fix used: a `localhost` connection to the container
  succeeds; a LAN-IP connection to the same port fails; no `0.0.0.0`
  listener exists for that port; a real worker execution still succeeds
  end to end; the OpenHands SDK's own run still succeeds; event
  persistence still succeeds. Must not rely on the host firewall as the
  actual containment mechanism. If closing this requires a controlled
  patch around the pinned OpenHands SDK's `DockerWorkspace`, that must be
  documented explicitly as a patch, not carried as a silent, undocumented
  fork.
- **Phase 3B — worker → gateway outbound relay.** The worker's new
  outbound tunnel, authenticated per the lease-aware mechanism above, with
  no browser-facing surface yet.
- **Phase 3C — authenticated browser realtime viewing (read-only).**
  `realtime:view` only. Proves the full path — real execution → worker →
  gateway → browser — before any control surface exists. No
  `realtime:control`, no command envelope, nothing that can mutate a
  running execution.
- **Phase 3D — authorized browser → agent interaction.** `realtime:control`,
  the command-delivery envelope and its terminal-outcome semantics, and the
  control-specific authorization check. Deliberately sequenced after 3C
  because this direction carries materially greater security and
  reliability consequences than viewing does.
- **Phase 3E — reconnect, replay, failure, and completion hardening.** The
  history→live handoff invariants, connection-drop/reconnect behavior
  under real network conditions, and the server-driven completion/close
  path, exercised end to end.

## Phase 3A status: complete (2026-09-26)

Phase 3A (the blocking prerequisite above) has landed, scoped to
`workers/coding-agent` only, with no changes to `apps/api`, `apps/web`, or
any vendored/upstream source under `.venv/`.

**Implementation.** `coding_agent.loopback_docker_workspace.
LoopbackDockerWorkspace` subclasses the installed `DockerWorkspace`
(pinned `openhands-workspace==1.41.0`, matching
`workers/coding-agent/pyproject.toml`) and overrides `_start_container` —
the only available override point, since the vendored method builds its
docker-run flags inline with no smaller overridable hook — to publish the
container's port as `127.0.0.1:{host_port}:8000` (and the `extra_ports`
VSCode/VNC mappings the same way) instead of publishing to all host
interfaces. Both of AtherNull's own `DockerWorkspace` call sites
(`worker.py::run_dispatch`, `agent_server_adapter.py::run_dispatch_via_agent_server`)
now construct this subclass instead of stock `DockerWorkspace`.

**Empirical evidence**, gathered against real containers on the dev host,
per §3.10's acceptance bar:

- *Before* (stock `DockerWorkspace`, reproduced fresh this session, not
  just cited from history): `docker run ... -p <port>:8000`; `netstat`
  showed `TCP 0.0.0.0:<port> ... LISTENING` and
  `TCP [::]:<port> ... LISTENING`; `curl` to the container's `/health`
  succeeded (HTTP 200) both from `127.0.0.1` and from the host's real LAN
  IP.
- *After* (`LoopbackDockerWorkspace`): `docker run ... -p 127.0.0.1:<port>:8000`;
  `netstat` showed only `TCP 127.0.0.1:<port> ... LISTENING` — no `0.0.0.0`
  or `[::]` entry for that port; `curl` from `127.0.0.1` still succeeded
  (HTTP 200); `curl` from the LAN IP failed to connect (curl exit 7, no
  response) — the bind address itself is the containment mechanism, not a
  host firewall rule.
- A real end-to-end dispatch through `run_dispatch_via_agent_server` (model
  `nvidia_nim/nvidia/nemotron-3-super-120b-a12b`, this repo's existing
  cheap test-model configuration) succeeded under the fix: the container
  started and reported healthy, the SDK's WebSocket authenticated and
  connected, the agent ran and edited the workspace, `conversation_id` was
  persisted to `executions.conversation_id`, events were persisted to
  `execution_events`, the post-run `resync_events()` gap-fill pass
  completed, and `docker_workspace.cleanup()` removed the container
  (confirmed absent via `docker ps`/`docker inspect` afterward).
  `worker.py`'s plain `run_dispatch` (`EXECUTION_ADAPTER=direct`) was also
  confirmed to start a healthy container under the same subclass.
- `workers/coding-agent`'s existing pytest suite passes unchanged,
  including `tests/test_agent_server_adapter.py`, which mocks the
  workspace class directly and was confirmed unaffected (its mock target
  was renamed from `DockerWorkspace` to `LoopbackDockerWorkspace` to match
  the new call-site symbol).

**Upgrade check required.** This is a full-method override — the vendored
`_start_container` has no smaller overridable seam — copied verbatim from
and coupled to `openhands-workspace==1.41.0`. `loopback_docker_workspace.py`
asserts this exact installed version at import time (via
`importlib.metadata.version("openhands-workspace")`) and raises loudly if
it does not match. **If `openhands`/`openhands-sdk`/`openhands-workspace`
is ever upgraded, `LoopbackDockerWorkspace._start_container` must be
re-diffed against the new `DockerWorkspace._start_container` and the
empirical checks above re-run before the version pin is bumped** — the
assertion must not be silenced or removed to unblock an upgrade.

Phases 3B–3E remain not started.

## Consequences

- The coding-agent worker gains real scope it does not have today: it must
  become able to accept/relay control commands during a dispatch it is
  actively running, not just poll-and-report. This is a materially larger
  change to `workers/coding-agent` than anything done in Phases 1–2, which
  only added persistence and authentication around an otherwise-unchanged
  worker loop.
- `apps/api` gains its first realtime/stateful-connection surface. It has
  none today (confirmed: no WebSocket library, no broker). This is new
  operational surface area — connection lifecycle, backpressure, and
  per-tenant limits are new failure modes this codebase has not had to
  reason about before.
- The ADR-0005 port-binding fast-follow is promoted from a tracked,
  low-urgency residual gap to Phase 3A — its own sub-phase, empirically
  verified, landing before any relay code is written.
- Two new capabilities (`realtime:view`, `realtime:control`) and a
  lease-verified worker-tunnel registration are now part of this system's
  authorization surface, alongside the existing member/owner/admin model —
  future authorization review must account for both.
- A single worker process today handles one dispatch at a time
  (confirmed: `worker.py`'s main loop is sequential claim → blocking
  dispatch → complete). Whether a worker mid-execution can also hold open
  a realtime relay session without blocking its own heartbeat/dispatch
  loop is an implementation-level concurrency question this ADR does not
  resolve — flagged for the implementation phase, not decided here.
- This ADR specifies the worker tunnel's *authorization* mechanism
  (`INTERNAL_API_TOKEN` + `workerId` + `executionId`, verified against
  `lease_owner`/`RUNNING`) but not its exact wire protocol or transport
  (WebSocket vs. some other bidirectional channel) or the browser→agent
  command envelope's precise schema/durability choice (§"command-delivery
  envelope" above names the decision, not its resolution). That remains
  implementation work, explicitly out of scope for this design-only phase.
- Nothing in this ADR changes the historical compatibility layer
  (`apps/api/src/routes/openhands-compat.ts`, Phase 2, already committed).
  A `RUNNING` execution with no active realtime connection still degrades
  gracefully to that same historical view; this ADR only adds a live path
  on top, it does not replace or modify the existing one.
