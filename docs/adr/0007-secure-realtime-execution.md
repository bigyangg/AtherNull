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

## Phase 3B status: complete (2026-09-26)

Phase 3B (worker -> apps/api outbound relay, no browser-facing surface) has
landed. Scope held exactly to the plan: `apps/api` gained a new route/plugin,
an in-memory registry, and a shared event-persistence helper;
`workers/coding-agent` gained a new relay-client module and
`agent_server_adapter.py` wiring; `apps/web`, Solana/payment code,
`packages/database` (no migration — this is in-memory state), and vendored
OpenHands source were untouched.

**Transport: WebSocket, confirmed against the audit, not assumed.** SSE was
rejected (one-way; this leg needs no bidirectional traffic yet, but a
one-way transport would need replacing the moment Phase 3C+ needs
server->worker messages — the ADR's own requirement not to design something
that "structurally can't support" that). Plain long-polling was rejected: it
cannot hold a single live registration open the way a heartbeat/liveness
check needs, and would reintroduce request-per-poll overhead for what is
fundamentally a continuous event stream. Raw TCP was rejected: WebSocket
already gives framing, a standard close handshake, ping/pong, and (on the
`apps/api` side) `@fastify/websocket`'s hook into Fastify's own request
lifecycle — reimplementing any of that over raw TCP would be strictly worse
for no benefit here. `@fastify/websocket@11.3.1` (peer: `fastify: '5.x'`,
confirmed by reading its own `fp()` registration, not just its README)
paired with Fastify `^5.12.5`; the Python side reuses `websockets==15.0.1`
(already a direct dependency for `resync_events`), specifically
`websockets.sync.client`, matching the worker's synchronous, non-asyncio
style (`ADR-0007`'s own grounding audit).

**Authentication and lease verification, as implemented.** `GET
/internal/relay/:executionId?workerId=<id>` with `Authorization: Bearer
<INTERNAL_API_TOKEN>`. `apps/api/src/routes/relay.ts` runs
`requireInternalToken()` (reused verbatim), then queries
`executions.lease_owner`/`status` by id — the execution's own `status`
column (confirmed: it is set to `'RUNNING'` at claim and to
`'SUCCEEDED'`/`'FAILED'` at complete; this is the correct column to check,
not the parent task's `status`, which can legitimately be `RUNNING` across
retries while an individual execution attempt is not) — inside a
`preValidation` hook, matching `internal.ts`'s existing per-route
duplicated-check convention rather than extracting a shared helper. Because
`@fastify/websocket` only performs the actual WebSocket upgrade
(`wss.handleUpgrade`) from inside the route's `handler`, and Fastify's
request lifecycle runs `preValidation` before `handler`, a `reply.status(...)
.send()` from `preValidation` prevents the 101 Switching Protocols response
from ever being sent — confirmed by reading
`@fastify/websocket`'s own source, not assumed. An unauthorized attempt
never gets a live socket.

**Lease-change handling: periodic re-validation deferred, with the exact
race documented.** Rereading `internal.ts`'s claim handler settled a
question the original ADR text left ambiguous: `lease_owner` is never
`UPDATE`d for an existing `executions` row — a reclaim after lease expiry
always inserts a *new* execution row (its own id) and only flips the old
row's `status` to `'LEASE_EXPIRED'`. So "the lease changes owner for the
same execution id" cannot happen in this codebase as implemented; what
actually happens is "this execution id's status moves off `RUNNING` while a
zombie worker might still hold a relay open for it." Phase 3B mitigates this
reactively rather than with a polling loop: the claim handler's reclaim
branch now calls `relayRegistry.closeAndRemove(oldExecutionId,
"lease-expired")` the moment it reclaims an orphaned lease, and
`POST .../complete` calls `relayRegistry.closeAndRemove(id,
"execution-completed")` unconditionally. The residual race this leaves open:
between the actual lease timeout and the moment another worker's `claim()`
call reclaims it, a genuinely-still-alive zombie worker's relay keeps
working, undetected, for up to `EXECUTION_LEASE_SECONDS` (default 300s).
This is accepted for Phase 3B specifically because the blast radius is
worker-internal bookkeeping only — a few opportunistically-persisted
`execution_events` rows for an execution that's about to be superseded — not
customer-facing control, since no browser can attach to any relay in this
phase. Full periodic re-validation of an open relay's lease is deferred to
Phase 3D/3E, alongside the browser-facing connection lifecycle it will need
anyway.

**Message envelope, exact shape** (`apps/api/src/realtime/envelope.ts`;
`workers/coding-agent/src/coding_agent/relay_client.py` implements the
identical JSON shape independently in Python — duplicated by necessity, not
shared code, kept in sync by hand):

```json
{
  "version": 1,
  "type": "execution.event",
  "executionId": "<uuid>",
  "eventId": "<the OpenHands event's own id>",
  "payload": { "id": "<same id>", "kind": "...", "occurredAt": "...", "payload": { ... } }
}
```

`type` is one of `worker.ready`, `execution.event`, `execution.completed`,
`relay.heartbeat` (the latter three are lifecycle-only in this phase — the
worker sends `worker.ready` on connect and `execution.completed` before
closing; `relay.heartbeat` is defined but not yet emitted, since WebSocket
close/error detection was sufficient for every test scenario exercised —
left as an available message type for Phase 3C+ rather than wired up
speculatively). `eventId` reuses `execution_events.id` (the OpenHands
event's own uuid) — no second event-identity scheme, per the ADR's own
requirement.

**Relay registry and lifecycle, as implemented**
(`apps/api/src/realtime/relay-registry.ts`): an in-memory `Map<executionId,
connection>`. Single-gateway-instance assumption carried over unchanged from
the ADR's original text — this map lives in exactly one `apps/api` process's
memory; cross-instance routing is not solved here. **Replacement policy
(explicit choice): a second successful registration for an executionId
REPLACES the previous connection** (closed with code 4000), rather than
being rejected. Justification: only the execution's actual current
`lease_owner` can ever pass registration, and `lease_owner` is immutable per
row (see above) — so a second registration for the same executionId can only
be the same worker reconnecting after a network blip, never a second,
distinct worker. Replacing a presumptively-stale socket is what keeps "one
active relay per execution" true at every instant, which is the property
that actually matters. Disconnect (`close`/`terminate`) and execution
completion both deterministically remove the registration (verified by
tests 7/8 below); `unregister()` only removes a registration if the closing
socket is still the one currently registered, guarding against a stale
handler from an already-replaced connection deleting a newer one.

**Failure/backpressure, as implemented.** Gateway unreachable or
registration rejected at connect time: `RelayClient.start()` is
non-blocking and every failure is caught and logged — `run_dispatch_via_
agent_server` proceeds identically either way. Relay disconnects mid-run:
`send_event()` becomes a silent no-op once `_connected` clears; no
reconnect is attempted for the rest of that dispatch (matching the worker's
single-attempt, non-asyncio style — a future dispatch gets a fresh
`RelayClient`). Slow gateway/event burst: a bounded `collections.deque
(maxlen=200)` on the worker side drops the oldest queued message once full
(`dropped_count` tracks this, observable but never consulted by dispatch
logic) — `send_event()` never blocks on network I/O, so a stalled relay can
never slow the agent run itself. Malformed message at the gateway: caught at
three layers (oversized frame, invalid JSON, schema mismatch) and logged and
ignored — the connection and process are never affected (verified by test
suite's malformed-message case, which confirms a later valid event on the
same socket still persists). Duplicate event id: the relay's opportunistic
persistence goes through the exact same `persistExecutionEvents()` helper
(`apps/api/src/execution-events.ts`) and the same `ON CONFLICT (id) DO
NOTHING` the authoritative HTTP path already used — extracted into one
shared function specifically so there is never a second, competing dedupe
mechanism. Worker shutdown: `RelayClient.close()` flushes what it can, sends
`execution.completed` if ever connected, and joins its thread with a bounded
timeout — never blocks dispatch completion.

**Test results.** All 14 required scenarios pass — 12 as automated
`node:test` cases in `apps/api/test/relay.test.ts` (registration success;
missing/invalid token; workerId/lease mismatch; unknown executionId;
non-RUNNING execution; replacement policy; disconnect removes registration;
completion removes registration; event envelope reaches and persists at the
gateway; duplicate event ids collapse to one row; a relay failure does not
affect the ordinary claim/events/complete path; the SESSION_API_KEY
source-level assertion) plus a matching Python suite in `workers/
coding-agent/tests/test_relay_client.py` (connect/send/close semantics,
drop-oldest queueing, `RelayEventCallback` bridging, and the equivalent
SESSION_API_KEY source-level assertions scoped to `relay_client.py` and to
`agent_server_adapter.py`'s `RelayClient(...)` construction site). The
remaining two (no new listening port; Phase 3A loopback containment holds)
were verified empirically, not just by test, against a real Docker
container and a real dev Postgres — see below. Full existing suites:
`apps/api` — 40/40 `node:test` cases pass (26 pre-existing + 14 new),
`tsc --noEmit` and `tsc -p tsconfig.test.json` both clean. `workers/
coding-agent` — 25/25 `pytest` cases pass (13 pre-existing + 12 new); no
`[tool.ruff]`/`[tool.mypy]` config exists in `pyproject.toml` (re-confirmed;
still true as of Phase 3A).

**Real execution evidence**, gathered against a real `apps/api` dev server
(`postgres://athernull@localhost:5433/athernull_dev`) and real Docker
containers, using the same cheap test model Phase 3A used
(`nvidia_nim/nvidia/nemotron-3-super-120b-a12b`):

- Three independent real dispatches through `run_dispatch_via_agent_server`
  with the relay wired in, each ending `outcome=success`, task status
  `VERIFYING`, container stopped/removed (`docker ps` confirmed empty
  afterward each time).
- Execution `4848121c-d1b7-40bb-8410-2169b454418e`: relay registered
  (gateway log: `"relay registered"` with the correct executionId/workerId),
  stayed open for the full ~34s run, cleanly disconnected at dispatch end
  (`"relay disconnected"`); 24 events persisted in total after the post-run
  `resync_events()` gap-fill.
- Execution `07c33b75-45cd-4de2-9ca3-a80306d1c4db` (with per-event relay
  logging added): **20 events observed arriving through the relay** at the
  gateway (`"relay event persisted"` log lines) vs. **21 events persisted in
  total** in `execution_events`. The one-event difference is exactly the
  gap `resync_events()` exists to close — its own code comment
  ("Replay all events: the SDK can deliver older events late") already
  anticipated this, and `EventForwarder`'s HTTP path independently confirms
  it: this is expected, not a defect, per this phase's own instruction not
  to expect these two counts to be equal.
- Execution `3d6cd39b-f068-4639-b04a-18277103884f` (same instrumentation,
  run specifically to capture `netstat` mid-dispatch — see below): 17
  relay-observed vs. 18 persisted — the same one-event pattern.
- `SESSION_API_KEY` confirmed absent from every surface across all three
  runs: zero (case-insensitive) matches in the `apps/api` dev server log;
  the only matches in the worker's own stdout are the SDK's pre-existing
  redacted `docker run` argument echo (`SESSION_API_KEY=<redacted>`, from
  `execute_command`'s own logging, unrelated to this phase) and the Agent
  Server container's own pre-existing deprecation warning about the
  `session_api_key` *parameter name* (never the value); a direct query
  against the persisted `execution_events.payload` for both instrumented
  executions confirmed no row contains the string.
- Empirical no-new-listening-port check (test 13): `netstat -ano` captured
  while the third dispatch's container was live and healthy showed the
  container's own port only as `127.0.0.1:<port>` (owned by Docker's own
  port-forwarding process, not the worker), `apps/api`'s dev server on
  `0.0.0.0:3001` (pre-existing, expected), and Postgres on `5433`
  (pre-existing, expected) — neither worker `python.exe` process (confirmed
  by PID via `Get-CimInstance Win32_Process`) owned any `LISTENING` entry.
  Cross-checked against source: `workers/coding-agent/src` contains zero
  `.listen(`/`socket.socket(`/`HTTPServer`/`socketserver` occurrences.
- Empirical Phase 3A regression check (test 14): the same `netstat`/`docker
  ps` capture showed the container's port bound to `127.0.0.1` only across
  all three runs — no `0.0.0.0` or `[::]` entry for any container port —
  confirming Phase 3A's loopback containment was not disturbed by this
  phase's changes.
- All throwaway DB rows (3 tasks + their executions/events, 3 scratch
  projects, 3 scratch agent profiles), scratch git repos, the temporary dev
  `apps/api/.env`, and all launched processes/containers were removed after
  verification; `tasks` count in the dev DB returned to its pre-verification
  baseline (26).

## Phase 3C status: complete (2026-09-26)

Phase 3C (authenticated browser realtime viewing, read-only) has landed.
Scope held to the plan: `apps/api` gained a new browser-facing WebSocket
route, an in-process fan-out broadcaster, and a shared Origin-allowlist
helper; `packages/contracts` gained the browser-facing protocol's Zod
schema; `apps/web` gained one new hook and a small, non-visual integration
into the existing real workspace view. No `realtime:control`, no
chat/bash forwarding, no command envelope — every inbound browser message is
rejected explicitly (see below). Solana/payment code, `packages/database`
(no migration — no new persisted state), and vendored/upstream OpenHands
source were untouched.

**Source-audit finding: `apps/web` (not the vendored OpenHands frontend) is
confirmed as the integration target.** Read
`apps/web/app/(app)/projects/[projectId]/workspace/page.tsx` in full:
`RealWorkspaceView` is exactly the real, currently-shipping execution view
ADR-0006 itself says apps/web remains the customer-facing surface for, and
its `useExecutionEvents` hook (`apps/web/lib/hooks/use-execution-events.ts`)
already reads `GET /v1/jobs/:id/executions/:executionId/events` on a 2s poll
— a pre-existing route in `routes/jobs.ts`, distinct from Phase 2's
`/api/conversations/*` compat surface. The pinned OpenHands frontend under
`prototypes/openhands-integration/spike-a-standalone-shell/upstream/` was
never touched, confirming the brief's own strongest-candidate hypothesis.

**Transport: the already-installed `@fastify/websocket`, a second route on
the same plugin registration — not a new library.** `apps/api/src/app.ts`
now registers `realtimeGatewayRoutes` immediately after Phase 3B's
`relayRoutes`, both riding the one `await app.register(websocket, {...})`
call already made for the worker-relay leg. No second WebSocket plugin, no
new dependency.

**Fan-out plumbing (the piece this phase genuinely adds, not something
Phase 3B already had).** `apps/api/src/realtime/execution-broadcaster.ts` is
a new, small in-process `EventEmitter`-backed pub/sub keyed by
`executionId`, with the identical single-gateway-instance/no-cross-instance-
routing assumption `relay-registry.ts` already carries (documented in the
new file's own header comment, not silently inherited). Two publish call
sites, not just the one point named in the brief:
`routes/relay.ts`'s `handleRelayMessage`, right after an
`execution.event` is persisted (the required fan-out point); and
`routes/internal.ts`'s authoritative `POST /internal/executions/:id/events`
handler, right after its own `persistExecutionEvents` call — added so a
subscribed browser still receives live pushes for events delivered via the
*authoritative* HTTP batch-ingestion path (worker running
`EXECUTION_ADAPTER=direct`, or a relay that has already disconnected), not
only for events that happen to arrive via a live relay. A third call site,
`routes/internal.ts`'s `POST /internal/executions/:id/complete`, publishes
completion — the same call site that already invokes
`relayRegistry.closeAndRemove(id, "execution-completed")`, not a separate,
independently-derived status check. All three publishes are safe to fire
unconditionally: an id already delivered is deduped by the browser gateway
(and again by the client), per this protocol's own stated invariant.

**Browser authorization, in order, and why the order departs from this
ADR's own prose list.** `apps/api/src/routes/realtime-gateway.ts`'s
`preValidation` hook (which, like Phase 3B's `relay.ts`, runs and can reject
*before* `@fastify/websocket` ever calls `wss.handleUpgrade` — re-confirmed,
not just cited from Phase 3B) checks, in this order: (1) `Origin`, against
`apps/api/src/trusted-origins.ts`'s `getTrustedOrigins()` — a new shared
helper `app.ts`'s CORS setup now also calls, so the WS gate and the CORS
allowlist can never silently drift apart into two different lists; a
missing `Origin` is rejected identically to a wrong one (a real browser
WebSocket upgrade always sends one; a request without one is either a
non-browser client or a forged request, and this codebase has no reason to
special-case it). (2) `requireOrgSession` — the identical Better Auth
session + live `auth.api.getActiveMember()` re-query every other business
route already uses; a removed member is rejected on their very next
subscribe attempt, reusing Phase 2's own already-proven mechanism verbatim.
(3) `resolveConversationTarget(id, organizationId)` — Phase 2's exact
resolver, no second implementation; a cross-org id and a genuinely unknown
id both resolve to `null` and both produce the same 404, preserving Phase
2's non-distinguishing guarantee. (4) the resolved execution must have
`status === "RUNNING"` (a finished execution is refused with a message
pointing at the existing historical view — nothing new needed there,
exactly as ADR-0007 specified). This order (`Origin` before session) is a
deliberate deviation from this ADR's own five-item prose list, not an
oversight: `requireOrgSession` inseparably bundles "session" and "live org
membership" into one call in this codebase, so those two items cannot be
checked as separate steps in the first place, and checking the free,
DB-free `Origin` gate before spending any auth work on a request is
strictly safer, never weaker, than the reverse order.

**`realtime:view`'s authorization rule, decided explicitly.** No privilege
tier stricter than plain active org membership exists anywhere in this
codebase for read access to execution data — re-confirmed this phase, not
just cited from Phase 2's own prior finding. `realtime:view` is therefore
exactly `requireOrgSession`'s own bar: any active member of the task's
organization, no owner/admin requirement, identical to every historical
read route. This is recorded as a decision, not an omission — a future
phase that needs a stricter rule has one concrete place
(`realtime-gateway.ts`'s `preValidation`) to add it.

**History<->live handoff, and how the four invariants were proved, not
assumed.** The gateway subscribes to `executionBroadcaster.onEvent(...)`
*before* issuing the Postgres `execution_events` query, buffers anything
received during that query into `preHistoryBuffer`, sends `history.ready`
with the query's own result (recording every id into a `sentIds` set), then
flushes the buffer through a single `sendEventOnce()` gate that is a no-op
for anything already in `sentIds`. The same subscription (never re-created)
continues delivering everything live through that identical gate from then
on — one code path, not two that could drift apart. This was proved with
two real, deterministic races in `apps/api/test/realtime-gateway.test.ts`
(tests 10/11), not a timing assumption: the test publishes directly to
`executionBroadcaster` synchronously, in the same tick the WebSocket
connects, which is guaranteed to land before the gateway's Postgres round
trip (real network I/O) can possibly resolve — proving invariant 1 (nothing
lost) when the event was never persisted at all, and invariant 2/4
(duplicate-safe, id-keyed dedup) when the same id is both persisted *and*
re-delivered live during that exact window. Invariant 3 (Postgres remains
the reconnect source of truth) is structural: `loadPersistedEvents()` is the
only place history or the final completion reconciliation is ever read
from, never the broadcaster's own transient state.

**Browser-facing protocol, exact shapes**
(`packages/contracts/src/realtime-browser.ts`, genuinely shared — both
`apps/api` and `apps/web` import the same Zod schema/types, unlike Phase
3B's hand-duplicated Python/TypeScript relay envelope): `server.hello`
`{version, type, executionId, taskId, executionStatus}`; `history.ready`
`{version, type, executionId, events: RealtimeExecutionEvent[]}`;
`execution.event` `{version, type, executionId, event: RealtimeExecutionEvent}`;
`execution.completed` `{version, type, executionId, outcome, finalEventCount}`;
`relay.unavailable` `{version, type, executionId, reason}`; `error`
`{version, type, code, message}` (`code` is one of `control_not_supported`,
`invalid_message`, `internal_error`). `RealtimeExecutionEvent` is
`{id, kind, occurredAt, payload}` — `id` is `execution_events.id` (the
OpenHands event's own uuid) reused verbatim, no second identity scheme.
There is deliberately no client->server message type defined at all in this
phase — see below.

**Control messages: rejected explicitly, not silently ignored.** The
gateway defines zero legitimate inbound browser message types in this
phase. Every inbound WebSocket frame — control-shaped or not — is answered
with `{type: "error", code: "control_not_supported", ...}` and logged at
`warn` with the execution/task id and frame size. Verified against a real
running execution (not just the unit test), see below.

**Relay-unavailable behavior, as implemented.** `relayRegistry.get(executionId)`
is checked once, right after `server.hello`; if no relay is currently
registered, `relay.unavailable` is sent immediately, and `history.ready`
(from Postgres, unconditionally) follows regardless. This is informational
only — it is never conflated with completion, and a relay registering later
in the same connection's lifetime (a real, benign race: the browser can
connect before the worker's own relay handshake finishes) simply starts
delivering live events with no further signal needed.

**Completion-reconciliation behavior, as implemented.** On observing
`executionBroadcaster`'s completion event (published from the same
`POST /internal/executions/:id/complete` call site that already closes the
Phase 3B relay), the gateway re-queries `execution_events` one more time
(covering any event that only landed via the worker's post-run resync
gap-fill), sends any still-unsent ids through the same `sendEventOnce` gate,
sends `execution.completed` with the real, freshly-queried
`finalEventCount`, then closes the socket with code `1000`. Guarded by a
`completionHandled` flag so a completion observed mid-history-fetch is
deferred until after `history.ready` has gone out, never raced ahead of it,
and never double-processed regardless of when it arrives. Business-lifecycle
state (`VERIFYING`/`SETTLED`/etc.) is untouched by any of this — `outcome`
is exactly the worker's own `"success"`/`"failure"` report, nothing more.

**Test results.** All 17 required scenarios pass, plus 2 additional edge
cases (a task with zero executions yet; an `executionId` query-param
mismatch against the resolved execution), as `node:test` cases in
`apps/api/test/realtime-gateway.test.ts` (19 tests total): same-org
subscribe; unauthenticated rejected; removed-member rejected; cross-org
rejected non-distinguishingly (same 404 as a genuinely unknown id); wrong
Origin rejected; missing Origin rejected; a live relay-forwarded event
reaches the browser; a control-shaped message is rejected explicitly, not
silently; a duplicate relay-delivered event id renders exactly once; the
history-fetch-window race loses no event (test 10) and dedupes correctly
when the same id is both persisted and buffered live (test 11); a `RUNNING`
execution with no relay still serves history and surfaces
`relay.unavailable` without hanging or misreporting completion; execution
completion triggers final reconciliation and a clean `1000` close;
`SESSION_API_KEY`/`INTERNAL_API_TOKEN` never appear in this phase's actual
code (stripped-comment static assertions, same convention as
`openhands-compat.test.ts`); no browser-facing route calls anything under
`/internal/*`; and Phase 3B's own relay registration/event-forwarding/
disconnect behavior is unaffected by this phase's fan-out wiring changes to
`relay.ts`/`internal.ts`. Full existing suite:
`node --import tsx --test test/*.test.ts` — **59/59 pass**, run twice in a
row (26 pre-existing job-lifecycle/tenant/openhands-compat + 14 Phase 3B
relay + 19 new Phase 3C, all against the shared persistent
`athernull_test` Postgres instance) — no cross-run isolation regressions,
the exact risk category Phase 3B had already found and fixed once. `tsc
--noEmit` (both `apps/api` and `apps/web`) clean.

**Real execution evidence**, gathered against a real `apps/api` dev server
(`postgres://athernull@localhost:5433/athernull_dev`), a real dev Postgres,
real Docker containers, and a real `ws`-based Node client standing in for a
browser's network path (real Better Auth session cookie obtained through
actual sign-up/sign-in/organization-create calls, a real `Origin` header, no
cookie/session shortcuts, connecting only to `apps/api`, never to the Agent
Server or any `/internal/*` route) — using the same low-cost model Phases
3A/3B used (`nvidia_nim/nvidia/nemotron-3-super-120b-a12b`):

- **An operational finding this session surfaced and had to work around, not
  a Phase 3C code defect.** The first two real dispatch attempts (tasks
  `999214bf-.../6e1dae33-...` and `4b2b73bb-.../89775941-...`) each completed
  with `outcome: success` but **zero** events ever reached `execution_events`
  — the gateway correctly reported `execution.completed` with
  `finalEventCount: 0` for both, an honest reflection of what was actually
  persisted, not a misreport. Root cause, traced via the worker's own logs:
  running `python -m coding_agent.worker` makes that file execute as
  `__main__`; `worker.py`'s `main()` then does
  `from coding_agent.agent_server_adapter import run_dispatch_via_agent_server`
  *inside* the function body, and `agent_server_adapter.py` in turn does
  `from coding_agent.worker import (..., WORKER_ID, log, clone_repository, ...)`.
  Because `coding_agent.worker` (the dotted module name) is not yet in
  `sys.modules` — only `__main__` is, a distinct module identity for the same
  file — Python imports it a **second** time under its real name, re-running
  every module-level statement again, including
  `WORKER_ID = os.getenv("WORKER_ID", f"coding-agent-{uuid.uuid4().hex[:8]}")`.
  With no `WORKER_ID` env var set, this silently produces a **second, random
  worker id** that every function `agent_server_adapter.py` imports by name
  (`log`, `clone_repository`, and — critically — every call site that closes
  over `WORKER_ID`, including `EventForwarder`, `RelayClient`'s registration,
  and the post-run `resync_events` gap-fill) then uses instead of the id the
  outer polling loop actually claimed the execution under — so every relay
  registration, event-forward, and resync call from inside
  `agent_server_adapter.py` was rejected with a correct, working-as-designed
  `409 Lease no longer owned by this worker` (`internal.ts`'s existing
  lease-ownership check, doing exactly its job against a second, illegitimate
  identity). `POST .../complete` still succeeded because it is called
  directly from `worker.py`'s own `main()` (the `__main__` copy, holding the
  *correct* `WORKER_ID`), which is why both dispatches still reported
  `success` despite persisting nothing. **This is a pre-existing
  `workers/coding-agent` behavior, not something Phase 3C introduced or
  touched, and out of this phase's file scope to fix** (worked around for
  this verification instead, per below); it did not manifest in Phase 3B's
  own real-execution evidence because that session's launches evidently set
  `WORKER_ID` explicitly (an explicit env var is read identically by both
  module copies, so the double-import produces no observable mismatch).
  **Flagged as a concrete, recommended fix for a future pass**: either avoid
  the internal `from coding_agent.agent_server_adapter import ...` inside
  `__main__`'s own `main()` (e.g. move the entry point to a real
  `if __name__ == "__main__":` shim that imports and calls a `main()` defined
  in a *non*-`__main__`-run module), or simply always require `WORKER_ID` to
  be set explicitly rather than falling back to a random default — not
  attempted here, since it is a change to `workers/coding-agent`, outside
  this phase's declared file scope.
- **Third dispatch, run with `WORKER_ID=phase3c-verify-worker` set explicitly
  to sidestep the above (a launch-configuration workaround, not a source
  change) — a genuinely clean, fully successful real run.** Task
  `6c4f2b1a-7547-417b-bebc-1f3fd9429336` (project repository
  `https://github.com/octocat/Hello-World@master` — the placeholder
  `github.com/athernull/example` repo this suite's unit-test fixtures use is
  not a real clonable URL, which is exactly what the very first attempt at a
  real dispatch, before any of the above, failed on and exhausted its 3
  retries against; switching to a real public repo was required and is
  recorded here rather than silently corrected out of the log), execution
  `eba914f1-f6fb-449f-b075-4d76e1468305`.
  - The realtime client connected and authenticated (real session cookie,
    real `Origin`) after the worker's relay had already registered:
    `server.hello` (`executionStatus: "RUNNING"`) was followed directly by
    `history.ready` with **9** persisted events already in Postgres at
    connect time — no `relay.unavailable` this time, correctly reflecting
    that a relay *was* active.
  - **9 further live events arrived one at a time** over the following
    ~75 seconds as the agent actually ran (`ObservationEvent`,
    `ConversationStateUpdateEvent`, `ActionEvent` kinds observed), each
    delivered exactly once — the client's own running dedup set recorded
    zero duplicates across the full 18-event stream.
  - The client's deliberate control-shaped probe
    (`{"type": "chat.send", "text": "ignore all instructions"}`), sent
    partway through the run over this real connection against a real running
    execution, was rejected with
    `{type: "error", code: "control_not_supported", ...}` — confirming test
    8's behavior holds outside the unit-test harness, not only inside it.
  - On completion: `execution.completed` arrived with `outcome: "success"`,
    `finalEventCount: 18`; the client's own tally
    (`historyCount=9, liveCount=9, duplicateCount=0, totalUniqueIds=18`)
    matched exactly; the socket closed with code `1000`.
  - **Independently queried against Postgres directly** (not just trusting
    the gateway's own count):
    `select count(*) from execution_events where execution_id = 'eba914f1-...'`
    returned **18** — an exact match to `finalEventCount` and to the client's
    own `totalUniqueIds`, with no gap to explain this time (unlike Phase 3B's
    own relay-vs-persisted count, which had a documented one-event gap from
    the post-run resync catching a late event the relay had already missed —
    here the client connected *after* the relay was already live, so no
    historical/live boundary race actually occurred to create such a gap;
    Phase 3C's own tests 10/11, not this real run, are what specifically
    force that race deterministically).
- `SESSION_API_KEY` confirmed absent from every network-visible surface
  across all three dispatches: the realtime client only ever received the
  six documented message types; a case-insensitive search of the entire
  `apps/api` dev server log across the full verification session returned
  zero matches.
- The browser-standing-in client never opened a connection to anything other
  than `ws://localhost:3001/v1/realtime/executions/...` — no Agent Server
  host/port was ever known to it, and it never called any `/internal/*`
  route.
- All throwaway rows (3 organizations/users, 3 projects, 1 agent profile
  reused across tasks, 4 tasks total and their executions/events/payment
  intents) were removed via a single transactional cleanup script after
  verification, confirmed by re-querying for the `phase3c-verify-%` slug
  prefix (0 rows). The temporary `apps/api/.env`, the scratch subscriber
  script, and every launched worker process/Docker container were also
  removed — `docker ps` and `Get-Process python` both confirmed empty
  afterward, leaving only the persistent dev Postgres container running (its
  standing baseline state, unrelated to this verification).

Phases 3D–3E remain not started.

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
