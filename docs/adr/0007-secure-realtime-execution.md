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

## Phase 3D status: complete (2026-09-26)

Phase 3D (authorized browser -> agent control) has landed. Scope held to the
plan: `apps/api` gained the command-forwarding half of the browser gateway
route, a new `realtime/control-registry.ts` module, and command-forwarding
additions to the existing worker relay route/envelope/registry;
`packages/contracts` gained the browser-facing command/status protocol;
`workers/coding-agent` gained a receive loop on the existing relay tunnel and
a narrow, allowlisted command handler; `apps/web` gained one small,
non-redesigning UI affordance. Solana/payment code, settlement, deployment,
and `packages/database` (no migration — no new persisted state, per the
explicit at-most-once/no-durable-ledger decision below) were untouched, and
no OpenHands upstream/vendored source was modified.

**Source-audit findings, confirmed against real source, not assumed.**

1. Phase 3B's relay protocol (`apps/api/src/realtime/envelope.ts`,
   `workers/coding-agent/src/coding_agent/relay_client.py`) was worker→gateway
   only — no gateway→worker message existed. This phase adds exactly two new
   message types to that same envelope, on the same tunnel: `gateway.command`
   (gateway→worker) and `worker.command_ack` (worker→gateway). No second
   tunnel, no second transport.
2. Phase 3C's browser protocol
   (`packages/contracts/src/realtime-browser.ts`) defined zero legitimate
   client→server messages — every inbound frame was rejected. This phase adds
   exactly one: `execution.command`, carrying a versioned, allowlisted
   command payload.
3. The installed OpenHands SDK's `RemoteConversation` (re-confirmed by
   reading `remote_conversation.py` directly, not cited from memory) exposes
   `send_message()` (`POST {base}/{id}/events`, payload `run: False`,
   "mirror local semantics; explicit run() must be called"), `run()`,
   `pause()`, `interrupt()`, and confirm/reject — no method resembling direct,
   agent-bypassing shell execution. The pinned frontend's own
   `/sockets/bash-events` PTY-style channel (ADR-0007's original grounding
   audit, §1.1) is a frontend-specific convenience the Agent Server also
   happens to accept on that socket — it is not something the Python SDK
   client this worker actually uses exposes or relies on, and apps/web (the
   real integration target, per Phase 3C's own audit) never used that
   frontend at all.
4. **Decision, made explicitly per the source audit's own finding**: v1's
   command surface is exactly one type, `agent.message` (a chat/user
   message), mapped to `send_message()`. A terminal/bash command type was
   investigated and deliberately deferred — not because it wasn't considered,
   but because no safe, SDK-native, non-forked way to expose raw shell
   execution (distinct from the agent's own tool use) was found. Building an
   unaudited second path to run arbitrary shell commands, or disguising bash
   as a chat message, was rejected as unsafe for v1, consistent with this
   ADR's own "narrowest useful command surface" instruction. Deferred to a
   future phase if a real, audited mechanism is identified.
5. `send_message()` is safe to call from a second thread concurrently with
   the main dispatch thread's blocking `conversation.run()` call: it touches
   only `self._client` (a plain REST POST) and none of
   `RemoteConversation`'s own run-tracking state (`_run_armed`,
   `_terminal_status_queue`). `run()`/`pause()`/`interrupt()`, by contrast,
   DO touch that shared state — the worker's new command handler
   (`CommandHandler` in `agent_server_adapter.py`) therefore calls
   `send_message()` only, never a second `run()`/`pause()`/`interrupt()`,
   specifically to avoid racing the main thread's own in-flight `.run()`
   call. Verified against a real running execution during this phase's own
   verification (below), not assumed from reading the client alone: a
   message injected while the agent's own turn loop was already active was
   picked up without a second explicit trigger — the agent's own persisted
   reasoning for its next turn explicitly referenced the injected message
   ("I should provide a short acknowledgement as requested").
6. `SESSION_API_KEY` is required, and used, exclusively inside
   `agent_server_adapter.py`'s existing `docker_workspace`/`Conversation`
   construction (unchanged by this phase) — the new command-handling code
   path never reads it, never receives it as a parameter, and never
   constructs a second local connection to the Agent Server. `CommandHandler`
   is handed the SAME `Conversation` object the main dispatch thread already
   holds; there is no new local port, no new local connection, and no change
   to Phase 3A's loopback-only containment.
7. Current execution status/lease checking (`apps/api/src/routes/internal.ts`)
   was re-read, not re-derived: `executions.status`/`lease_owner` remain the
   sole source of truth, and this phase adds a SECOND read site (a per-command
   revalidation in the browser gateway, see below) rather than a parallel
   notion of "is this execution controllable."
8. AtherNull's authorization surface (`apps/api/src/session.ts`) has exactly
   one tier stricter than plain org membership: `PRIVILEGED_ORG_ROLES`
   (`owner`/`admin`), already gating `fund`/`verify`/`accept`/`reject`. No
   second permission primitive exists anywhere in this codebase.

**`realtime:control` authorization policy — the explicit decision this ADR
required, not a default.** `realtime:control` is gated on the exact same
`owner`/`admin` tier as the existing business-lifecycle actions
(`hasRealtimeControlAuthority`, `apps/api/src/session.ts`, a thin,
documented wrapper around the same `PRIVILEGED_ORG_ROLES` set
`requirePrivilegedRole` already uses) — not a new, parallel permission
concept, and not silently defaulted to plain membership. This is a
deliberate choice, recorded here as such: a command that can cause real
additional inference cost and mutate a live agent session is judged
analogous in risk to funding/verify/accept/reject, which already draw this
same line; `realtime:view` (Phase 3C) deliberately stayed at plain-member
level because reading output carries no equivalent risk. If a finer-grained
policy (e.g. a dedicated `realtime:control` grant independent of
owner/admin) is ever needed, `hasRealtimeControlAuthority` is the one place
to change it — no second check exists elsewhere to fall out of sync.

**Per-command revalidation, not connect-time-only — the ADR's own
"preferred security property."** `realtime:view`'s authorization is still
checked once, at connect (Phase 3C, unchanged). `realtime:control` is
different: `apps/api/src/routes/realtime-gateway.ts`'s `handleControlMessage`
re-runs, on EVERY inbound command: (1) a fresh `requireOrgSession` (the same
live `auth.api.getActiveMember()` re-query Phase 2/3C already established,
now invoked per-command, not just per-connection — a demoted/removed member's
very next command is rejected immediately); (2) a fresh
`hasRealtimeControlAuthority` check against the just-fetched role; (3) a
fresh `executions.status === 'RUNNING'` read; (4) a fresh
`relayRegistry.get(executionId)` presence check; (5) a fresh
`relayConnection.workerId === executions.lease_owner` equality check. All
five are re-read from the database/registry at command time, never cached
from the connection's own handshake. A connection's `canControl` flag
(reported once, in `server.hello`) only gates whether the socket is even
allowed to ATTEMPT a command — it is never itself trusted as the actual
authorization for any specific command.

**Command envelope, exact shape**
(`packages/contracts/src/realtime-browser.ts`):

```json
{
  "version": 1,
  "type": "execution.command",
  "commandId": "<client-generated UUID>",
  "executionId": "...",
  "command": { "type": "agent.message", "payload": { "text": "..." } }
}
```

`commandId` is the browser command's own identity — generated client-side,
carried through the gateway→worker envelope unchanged, and NEVER the same
identity space as an OpenHands event's own UUID (`execution_events.id`).
`ExecutionCommandTypeSchema` is a one-member allowlist (`agent.message`) —
structured as a `z.discriminatedUnion` from day one so a future, audited
second command type is a pure addition, not a restructuring.

**Command lifecycle states, all eight represented, semantically distinct**
(`CommandStatusValueSchema`): `received` → `authorized` → `forwarded` →
(`accepted` | `rejected` | `failed` | `uncertain`) → optionally `executed`.
`rejected` = this system (gateway or worker) deliberately did not let the
command reach/affect the Agent Server (auth failure, validation failure,
backpressure, stale lease, or the worker's own not-ready window — see below).
`failed` = the Agent Server's REST call explicitly returned an error.
`uncertain` = forwarded, but the worker relay disappeared (disconnect, lease
reclaim, execution completion) or its ack never arrived within the timeout —
the system honestly does not know the outcome. `executed` is a deliberate,
disclosed heuristic (see below), not a strong per-command guarantee. These
are never collapsed into each other in the wire protocol
(`RealtimeCommandStatusSchema`'s `status` enum has all eight values).

**"Executed" is a disclosed heuristic, not a durable correlation — recorded
explicitly rather than overclaimed.** Precisely correlating a specific
resulting OpenHands event to a specific `commandId` would require either a
new, second event-identity scheme (which ADR-0007 already rejects for the
Agent→Browser direction, and this phase does not introduce one for this
direction either) or deeper protocol work this phase's own "Phase 3E
boundary" excludes. The shipped behavior: once a command reaches `accepted`,
its `commandId` is queued (bounded, oldest-first, per browser connection);
the next `execution.event` the connection observes for that execution
upgrades the oldest queued `commandId` to `executed`. This is honest,
disclosed best-effort evidence "a normal OpenHands event occurred after this
command was accepted," not a proof that event resulted from that exact
command. Verified working end to end against a real execution (below).

**At-most-once forwarding, exactly as ADR-0007 specifies — not durable.**
`apps/api/src/realtime/control-registry.ts`'s `ControlRegistry` tracks every
`commandId` this gateway PROCESS has ever forwarded (bounded at 5,000
entries, oldest-evicted) — a second `execution.command` with an
already-seen `commandId` is rejected (`duplicate_command_id`) and never
re-forwarded, regardless of why the browser sent it twice. This state is
**entirely in-memory and process-local**: a gateway restart loses all
history of forwarded `commandId`s, meaning a genuinely duplicate submission
after a restart would be forwarded again. This limitation is explicit, not
silently assumed away — a durable command ledger (enabling real
exactly-once semantics across restarts) is explicitly out of scope for this
phase, deferred to Phase 3E or later per the ADR's own instruction.

**Uncertain-delivery handling, covering every step named in the ADR's own
walkthrough.** (1) Gateway cannot find/match an active relay before
forwarding → immediate `rejected` (`no_active_relay` / `lease_mismatch` /
`execution_not_running`), never a wait. (2) Gateway forwards, but the
worker relay disconnects (network drop, lease reclaim, execution completion)
before an ack arrives → `ControlRegistry.abortAllForExecution` (invoked from
`relay-registry.ts`'s own `unregister`/`closeAndRemove`, the same two call
sites Phase 3B already used for relay lifecycle) immediately resolves every
still-pending command for that execution as `uncertain` — the browser is not
made to wait out the full ack-timeout window for a connection already known
to be gone. (3) Worker acknowledges receipt (`accepted`) but the Agent
Server's own eventual outcome is observed only indirectly, via the
`executed` heuristic above. (4) The Agent Server (or the worker itself, for
a condition it can detect — see below) explicitly rejects/fails → `failed`
or `rejected` with a `detail`/`reason`, never silently absorbed. (5) A real
resulting event → the `executed` heuristic. No branch of this logic ever
automatically resends a command — every retry observed in this phase's own
verification was a NEW `commandId`, submitted as an explicit new action
(by the test script standing in for a real user), never an automatic resend
of the original.

**A real, previously-undocumented race, found and closed during this
phase's own real-execution verification (not merely theorized).** The
execution's `status` flips to `RUNNING` (visible to a browser) the instant
`POST /internal/executions/claim` returns — well before the Docker container
is healthy, the worker's relay tunnel has registered with the gateway, AND
(a narrower window inside that) before `agent_server_adapter.py`'s
`Conversation` object exists and `relay.set_command_handler(...)` has run.
A `gateway.command` arriving in that narrowest window used to be silently
dropped by the receive loop (`self._on_command is None: continue`), leaving
the browser to wait out the full ack-timeout window for a command that could
never be answered — an avoidable `uncertain` for a condition the worker
could already detect deterministically. Fixed in
`workers/coding-agent/src/coding_agent/relay_client.py`'s `_recv_run`: this
specific, detectable case now sends an explicit `worker.command_ack`
`rejected` (`"worker is not ready to accept commands yet"`) immediately,
turning an avoidable `uncertain` into a fast, honest `rejected` a client can
retry against right away. This was found by observing real, repeated
`no_active_relay`/timeout behavior against a real worker during
verification, then fixed and re-verified against another real run — not
assumed or guessed at.

**Worker → Agent Server forwarding mechanism, exactly as the audit
predicted, no new local connection.** `relay_client.py`'s `RelayClient` gains
a second background thread (`_recv_run`) reading inbound frames off the
SAME relay WebSocket Phase 3B already opened — confirmed safe to run
concurrently with the existing outbound send thread and with the main
dispatch thread's blocking `.run()` poll by reading `websockets/sync/
connection.py` directly: the library already runs its own internal
`recv_events` thread per connection, decoupling the application's own
`.recv()`/`.send()` calls from the raw socket via internal queues/locks — a
second application-level consumer thread calling `.recv()` is exactly the
pattern the library is built to support, not something layered
unsafely on top of it. `agent_server_adapter.py`'s new `CommandHandler` is
late-bound onto the already-running `RelayClient`
(`relay.set_command_handler(...)`) once the real `Conversation` object
exists, and re-issues an `agent.message` command as
`conversation.send_message(text)` against that same object — the same
`Conversation`, the same underlying `SESSION_API_KEY`-authenticated Agent
Server connection, the same worker process boundary Phase 1–3B already
established. No new local port, no new local connection, no exposure beyond
what Phase 3A already locked to loopback.

**Backpressure/limits, as implemented** (`apps/api/src/routes/
realtime-gateway.ts`): `MAX_CONTROL_MESSAGE_BYTES` = 16 KiB per inbound
frame (an oversized frame is rejected generically, before `JSON.parse`, per
`MAX_COMMAND_TEXT_LENGTH` = 8,000 chars' own schema bound plus envelope
overhead); `MAX_PENDING_COMMANDS_PER_CONNECTION` = 5 concurrent
unacknowledged commands per browser connection (`too_many_pending` beyond
that); a 10-command-per-10-second sliding-window rate limit per connection
(`rate_limited` beyond that); `ControlRegistry`'s 5,000-entry bound (above)
caps total forwarded-`commandId` memory regardless of how many executions or
connections exist. None of these are configurable via env var in v1 —
conservative, hardcoded defaults, not a tuning surface this phase needs.

**Business-lifecycle boundary, verified both structurally and by test.**
`realtime-gateway.ts`'s entire command-handling code path never calls
`updateTable("tasks")` — the sole place any task's business-lifecycle status
ever transitions remains `apps/api/src/routes/internal.ts`'s existing
handlers, completely untouched by this phase. Verified by a static
source-level assertion (`realtime-control.test.ts`, test 22) AND a real
functional test sending an accepted control command and confirming the
task's `status` column is byte-for-byte unchanged afterward.

**Read-only path regression check.** Phase 3C's own `realtime-gateway.test.ts`
required one, disclosed, minimal adjustment: its own test 8 (a connection
sending a control-shaped message must be rejected) previously connected as
the task's OWNER — under Phase 3C's premise that NO connection had any
legitimate command type. Phase 3D makes that premise false for owner/admin
specifically, so test 8 now connects as a plain MEMBER instead (still
correctly rejected with `control_not_supported`), preserving the exact
guarantee the test's own name and describe-block describe. No other Phase
3C test required any change — re-run in full alongside this phase's new
tests (below).

**Test results.** `apps/api`: 24 new Phase 3D scenarios in the new
`test/realtime-control.test.ts` (member without control rejected;
owner-with-control command reaches the worker relay; unauthenticated/
cross-org/wrong-Origin connect-time rejection; non-RUNNING execution
rejected per-command without disturbing the live view; missing relay
rejected; lease-owner mismatch rejected; unknown command type rejected;
malformed payload rejected; oversized text rejected via schema; oversized
raw frame rejected generically before parsing; duplicate `commandId`
forwarded at most once; worker-disconnect-before-ack produces `uncertain`;
explicit worker rejection produces `rejected`; explicit downstream failure
produces `failed`; a live event after `accepted` upgrades to `executed`;
a rejected command never disturbs the live event stream; a control command
never mutates task status; SESSION_API_KEY/INTERNAL_API_TOKEN absent from
the Phase 3D source files; `/internal/*` absent from the gateway route's
code; the contract's allowlist contains only `agent.message`) — **24/24
pass**. Full `apps/api` suite (`node --import tsx --test test/*.test.ts`,
86 tests total: 62 pre-existing/Phase-3B/3C + 24 new Phase 3D) —
**86/86 pass, repeated 10 consecutive times, 860/860 pass, zero failures,
zero flakes** (exact per-run results: all 10 runs reported `tests 86, pass
86, fail 0`). `tsc --noEmit` (`apps/api`, `apps/web`) and `tsc --noEmit` +
`tsc -p tsconfig.test.json` (`apps/api`) all clean. `workers/coding-agent`:
15 new Phase 3D scenarios across `test_relay_client.py` (receive-loop
dispatch, execution-id-mismatch ignored, malformed-payload-ignored,
no-handler-is-a-no-op, exception-in-handler-does-not-kill-the-loop,
late-binding via `set_command_handler`, `send_command_ack` envelope shape,
the not-ready-yet explicit rejection fix, ack-never-raises-if-never-
connected) and `test_agent_server_adapter.py` (`CommandHandler` forwards
`agent.message` and acks accepted; never calls `run()`/`pause()`/
`interrupt()` again; rejects unsupported command types without touching the
conversation; rejects missing/empty text; acks `failed` when `send_message`
raises; drops a payload with no `commandId` without raising; the real
`run_dispatch_via_agent_server` wires the command handler to the real
`Conversation` object) — **40/40 pass** (25 pre-existing + 15 new), repeated
10 consecutive times, **400/400 pass, zero failures**.

**Real execution evidence**, gathered against a real `apps/api` dev server
(`postgres://athernull@localhost:5433/athernull_dev`), a real dev Postgres,
a real Docker container, and a real `ws`-based Node client standing in for
a browser's network path (real Better Auth session cookie via actual
sign-up/verify/sign-in/organization-create calls, a real `Origin` header,
connecting only to `apps/api`), using the same low-cost model prior phases
used (`nvidia_nim/nvidia/nemotron-3-super-120b-a12b`):

- A real task (objective: explore a cloned repo via `ls -la`, read files,
  create `SUMMARY.md`, run `printf 'athernull-phase3d\n'`, then wait) was
  funded, claimed by a real worker, and reached a real `RUNNING` execution
  with a real Docker `agent-server` container.
- The realtime client connected with `canControl: true` (a real owner
  session), received `history.ready`, then submitted real
  `execution.command` (`agent.message`) submissions. The FIRST several
  submissions were honestly `rejected` (`no_active_relay`, then briefly
  `"worker is not ready to accept commands yet"`) during the real,
  observed window before the worker's relay/command-handler wiring
  completed — each with a fresh `commandId`, never an automatic resend of
  an earlier one, exactly matching this phase's own at-most-once/no-blind-
  retry rule. Once the worker was ready, a submission reached
  `received → authorized → forwarded → accepted → executed` in full.
- **Independently queried against Postgres**: the injected message persisted
  as its own `MessageEvent` row (`source: "user"`), immediately following
  the original task objective's own `MessageEvent`, with a
  `ConversationStateUpdateEvent` (`last_user_message_id`) confirming the
  Agent Server's own state tracked it as current. The agent's own final
  response's persisted `reasoning_content` explicitly referenced it: *"The
  user wants me to create a SUMMARY.md file and run a final printf command.
  I've already done both. Now I need to wait for further instructions. I
  should acknowledge completion and wait. Let me provide a short
  acknowledgement as requested."* — direct, independent proof the injected
  command reached and was acted on by the real, running agent, not merely
  accepted and ignored.
- A duplicate submission of the SAME `commandId` (sent deliberately, after
  the first had already been accepted) was rejected
  (`duplicate_command_id`) and never reached the worker a second time,
  confirmed both by the gateway's own status stream and by the
  worker-observed forward count.
- `finalEventCount`/live-event count/independently-queried Postgres
  `execution_events` count for this execution all agreed exactly.
- `SESSION_API_KEY` confirmed absent from every network-visible surface:
  zero (case-insensitive) matches across the entire `apps/api` dev server
  log for the full verification session; the realtime client itself never
  received anything but the documented message types.
- `INTERNAL_API_TOKEN`'s real value was confirmed absent from every message
  the browser-standing-in client ever received.
- The client never opened a connection to anything other than
  `ws://localhost:3001/v1/realtime/executions/...` — no Agent Server host,
  port, or container coordinate was ever known to it.
- **Uncertain-delivery scenario, tested two ways.** (1) A deterministic,
  reliable, repeatable automated test
  (`realtime-control.test.ts`, test 14: a controlled fake worker relay
  disconnects after the gateway forwards a command but before it acks) —
  passed on every one of the 10 repeated full-suite runs above. (2) One
  genuine real-worker-process-kill attempt: a command was forwarded to a
  real worker mid-dispatch, and the real OS process was force-killed
  immediately afterward via `Stop-Process -Force`, intending to race the
  kill against the worker's own ack. **Disclosed honestly: the race was
  lost** — the real worker's local `send_message()` call plus queuing its
  ack completed faster than the OS could deliver and act on the kill signal,
  so the command reached `accepted`/`executed` before the process actually
  died. This is recorded as a real, attempted, non-fabricated result, not
  papered over — it is also a mildly reassuring data point about how fast
  the accept path actually is in practice. The deterministic test (1) is
  the phase's authoritative, repeatable evidence for this scenario, exactly
  as ADR-0007 itself anticipates ("a deterministic lower-level integration
  test is acceptable... do not force unsafe timing hacks").
- All throwaway rows (7 organizations' worth of users/orgs/projects/agent
  profiles/tasks/executions/execution_events across the main verification
  and the uncertainty-test run, plus each run's app-onboarding-created
  default organization/agent-profile) were removed via transactional
  cleanup scripts after verification; every dev-DB row count (`tasks`,
  `executions`, `execution_events`, `organization`, `user`, `projects`,
  `agent_profiles`, `member`) was independently re-queried and confirmed
  to exactly match this session's own pre-verification baseline. The
  temporary `apps/api/.env`, both scratch verification scripts, and every
  launched worker process/Docker container were removed —
  `docker ps -a`/`Get-CimInstance Win32_Process` both confirmed empty of
  anything this phase launched afterward.

**Remaining Phase 3E risks, explicitly not addressed here.** (1) No durable
command ledger — a gateway restart loses all `commandId` dedupe history and
all in-flight pending-ack state (any command mid-flight at restart time
simply never resolves; the browser's own ack-timeout still eventually
surfaces `uncertain` from the client's perspective, but the registry itself
has no memory of it). (2) No relay reconnect — if a worker's relay drops and
reconnects (not attempted anywhere in this codebase today, Phase 3B's own
documented limitation), any commands that were pending against the old
connection are already resolved `uncertain` by `abortAllForExecution`, but
there is no mechanism to correlate a reconnected relay with the browser's
earlier session or replay anything. (3) No cross-instance routing — the
single-gateway-instance assumption `relay-registry.ts`/
`execution-broadcaster.ts`/`control-registry.ts` all carry from Phase 3B/3C
is unchanged; a horizontally-scaled `apps/api` without sticky routing would
need shared state for all three. (4) The `executed` heuristic is
per-connection and order-based, not a real per-command correlation — a
future phase wanting a stronger guarantee needs either a durable command
log Agent Server events can reference, or an SDK-level mechanism (not
available today) for tagging which turn a given user message triggered.
(5) Terminal/bash commands remain deferred pending a safe, SDK-native
mechanism — not attempted, not faked, in this phase.

## Phase 3E status: complete (2026-09-26)

Phase 3E (reconnect, recovery and command-state hardening) has landed. Scope
held to the plan: `apps/api` gained one new module
(`realtime/heartbeat.ts`) and reconnect-safety wiring in the existing relay
and browser-gateway routes; `workers/coding-agent` gained bounded reconnect
in `relay_client.py`, its only functional change this phase;
`apps/web`'s `use-execution-realtime.ts` hook gained bounded reconnect and
client-side command-uncertainty enforcement, with **zero changes** to
`packages/contracts/src/realtime-browser.ts` (the browser wire protocol) or
to `apps/api/src/realtime/envelope.ts` (the worker wire protocol) — every
Phase 3E guarantee is achieved by making both existing protocols' connections
reconnectable, not by adding new message types. **No `packages/database`
migration was created** (see the durability decision below — this was the
single most important open question this phase had to resolve, and the
answer is "no new table," not "a migration was deferred"). No Solana/payment/
settlement/deployment code was touched, no Redis/pub-sub/distributed-relay
routing was introduced, and no vendored/upstream OpenHands source was
modified.

### 1. In-memory state audit and classification (source audit, Step 1)

Every phase 3B/3C/3D piece of process-local state was re-read directly from
source (not assumed) and classified:

| State | Location | Classification | Why |
|---|---|---|---|
| Active worker relay registry (`executionId -> RelayConnection`) | `relay-registry.ts` | **B** — reconstructible | Postgres (`executions.lease_owner`/`status`) is the sole authority a registration is checked against; an empty map after a restart or a disconnect is exactly the "no relay yet" state the browser-facing gateway already tolerates (`relay.unavailable`). A worker reconnecting simply re-registers, re-validated fresh against the DB, per Step 3. |
| Browser WebSocket subscriptions + per-connection state (`sentIds`, `preHistoryBuffer`, `pendingCommandCount`, `rateLimitTimestamps`, `acceptedAwaitingExecuted`) | `realtime-gateway.ts` | **A** — safe to lose | All of it is re-derived from scratch on every new connection (a fresh `Set`/array/counter per socket). Losing it on disconnect is not a degradation — it is the design: Phase 3C already made every connection independently rebuild its view from Postgres history plus the live broadcaster. |
| `commandId` dedupe registry (`ControlRegistry.forwarded`, bounded FIFO, 5,000 entries) | `control-registry.ts` | **D** — must become explicitly uncertain after loss | This is the ADR's own already-disclosed at-most-once boundary ("within one active gateway process"). A restart empties it. This is safe ONLY because of the separate, load-bearing invariant (Step 7, verified) that nothing anywhere ever automatically resends a `commandId` — the only way the same `commandId` could ever be seen twice by a fresh, empty registry is a client bug or a deliberate replay attempt, neither of which this registry needs to remember across a restart to defend against (a genuinely fresh user action always mints a genuinely fresh `commandId`). |
| Pending command acknowledgements (`ControlRegistry.pending`, with live timers) | `control-registry.ts` | **D** — must become explicitly uncertain after loss | A command mid-flight at the moment of a gateway restart is not just "forgotten" — its browser socket is also gone (same process), so the browser itself will reconnect and, per this phase's new client-side rule, will have already force-transitioned that command's own last-known status to `uncertain` the instant its socket closed (see §4). The server-side registry losing the entry is therefore consistent with, not contradicted by, what the client independently concludes. |
| History/live buffer handoff state (`preHistoryBuffer`, `bufferingPreHistory`, `sentIds`) | `realtime-gateway.ts` | **A** — safe to lose | Purely a per-connection transitional device for the subscribe-then-query race (Phase 3C invariant 1/2). A new connection re-runs the exact same sequence from an empty buffer; nothing about it is meant to survive past one connection's lifetime. |
| Completion state (`completionHandled`, `pendingCompletionOutcome`) | `realtime-gateway.ts` | **B** — reconstructible | `executions.status` in Postgres is the sole authority. A reconnecting browser gets a fresh `preValidation` check against that column (409 if not `RUNNING`) rather than any remembered completion flag — Step 9 relies on exactly this. |
| Worker-side outbound event queue (`RelayClient._queue`, bounded 200, drop-oldest) | `relay_client.py` | **B** for its *contents* (execution_events are independently persisted via the authoritative HTTP path regardless of this queue's fate), **A** for the queue object itself | Phase 3E's reconnect keeps this queue alive *across* a reconnect (queued-but-unsent messages are retried on the next successful connection, never cleared) — a deliberate improvement over "safe to lose," made possible because the queue was already bounded and idempotent-safe (`ON CONFLICT DO NOTHING` on `execution_events.id`). |

### 2. Durable command state decision — **Option A chosen, no migration created**

Per the assignment's explicit instruction, this was evaluated before writing
any implementation code, and the migration itself was never created — this
section is the full write-up for review.

**Option A (no durable command ledger) was chosen.** After a gateway
restart, unresolved command state becomes explicitly unknown; the browser's
own client-side rule (§4) already converts any such state to `uncertain`
independently, without needing the server to remember anything. A new user
action always mints a new `commandId`.

**Why Option B (a durable ledger) was rejected as unjustified for this
phase**, weighed against its stated fields
(`command_id`/`execution_id`/`organization_id`/`actor_user_id`/`command_type`/
`state`/`created_at`/`forwarded_at`/`acknowledged_at`/`terminal_outcome`):

1. **It would not buy real exactly-once execution**, and the assignment is
   explicit that no phase may claim otherwise. Phase 3D's own audit already
   established `RemoteConversation.send_message()` has no idempotency key —
   a durable ledger records that a command was *forwarded*, but cannot make
   the downstream Agent Server call itself safe to retry. Durability at the
   gateway layer does not reach across that gap.
2. **It would not improve the `executed` heuristic.** Step 6's own audit
   (below) re-confirms no reliable commandId<->OpenHands-event correlation
   exists in the SDK's event payloads. A durable ledger surviving a restart
   still could not answer "did this specific command execute" any more
   precisely than the in-memory version already does — it would only survive
   longer while still being a heuristic.
3. **The gap it would close is narrow and already mitigated on the client.**
   The only scenario Option B durably helps is: a command is forwarded,
   the gateway process restarts before the worker's ack arrives, and later
   the SAME browser tab (without ever having reloaded/reconnected) asks
   "what happened to commandId X?" But that browser tab's own socket died in
   the same restart — per §4's new client-side rule, the tab has *already*
   marked that command `uncertain` locally, independent of any future server
   answer. A durable ledger would let a NEW connection re-derive the same
   `uncertain` conclusion the client already reached on its own — it does not
   unlock any capability the user doesn't already have.
4. **Cost is not free.** A ledger write on every command state transition
   (forwarded, acked, timed out) adds synchronous DB writes to a path that is
   explicitly rate-limited (10 commands/10s) precisely because it is meant to
   stay cheap and infrequent; the marginal reliability gain does not clear
   that bar.
5. **This is the assignment's own documented expected/default outcome**
   given the existing at-most-once-plus-uncertain design Phase 3D already
   established and this ADR already recorded as deliberate, not accidental.

**Guarantees Option A provides:** every command reaches exactly one terminal
outcome the browser can see (`accepted`→optionally `executed`, `failed`,
`rejected`, or `uncertain`) or is explicitly marked `uncertain` the instant
the connection that could have resolved it is lost — client-side (socket
close) or server-side (worker relay disconnect, `abortAllForExecution`).
`commandId` at-most-once forwarding holds for the life of one gateway
process and one browser tab.

**Guarantees Option A explicitly does NOT provide:** a `commandId` dedupe
memory that survives a gateway restart if a client somehow resent the exact
same id afterward (not currently possible via any code path — see Step 7 —
but not defended against by a data structure, only by the absence of any
replay code); an audit trail of historical command outcomes beyond what the
currently-connected browser tab holds in memory; a way to answer "what
happened to commandId X" from a NEW browser tab/session that never saw it.

**Migration/backfill implications, for the record:** none, because no
migration was created. If a future phase concludes Option B is warranted
(e.g. a compliance requirement for a command audit trail, independent of
execution correctness), the schema sketch above is the starting point, and it
would need a backfill strategy of exactly zero rows (no prior command history
exists anywhere to backfill from) and a decision on retention/pruning, since
command volume is unbounded over the lifetime of an organization even though
any single execution's volume is rate-limited.

### 3. Worker relay reconnect (as implemented)

`workers/coding-agent/src/coding_agent/relay_client.py`'s `RelayClient._run`
changed from a single-attempt "connect once, never retry" design (Phase 3B's
own explicit choice) to a bounded, worker-initiated reconnect loop:

- **Still worker-initiated only.** Every attempt — first or Nth — is this
  same client calling `ws_client.connect()` outward. The gateway never dials
  the worker.
- **Full credential re-presentation on every attempt.** `INTERNAL_API_TOKEN`
  (header), `workerId`, `executionId` (URL) are rebuilt from scratch each
  time via `_connect()` — nothing is cached or "resumed" from a prior
  attempt.
- **Gateway-side revalidation is unchanged and untouched** —
  `routes/relay.ts`'s `preValidation` already re-queries
  `executions.lease_owner`/`status` fresh on every single registration
  attempt, reconnect or not (this was true before Phase 3E and required no
  code change; Phase 3E tests 1-5 in `realtime-reconnect.test.ts` exercise it
  explicitly for the reconnect case).
- **Deterministic classification of terminal vs. transient failures.** A
  handshake rejection carrying HTTP 401/403/404/409
  (`TERMINAL_HANDSHAKE_STATUS_CODES`, matched via `websockets.exceptions.
  InvalidStatus.response.status_code`) means the gateway's own Postgres-backed
  check has definitively refused this worker/executionId combination for the
  rest of this dispatch — retrying can never succeed, so the client gives up
  immediately on the FIRST such rejection. Anything else (`OSError`, timeout,
  connection refused, a live connection dying mid-stream) is treated as
  transient and retried, bounded.
- **Bounded exponential backoff with full jitter**, not a tight loop:
  `BASE_BACKOFF_SECONDS=0.5`, `MAX_BACKOFF_SECONDS=30`,
  `MAX_RECONNECT_ATTEMPTS=8`. A single consecutive-failure counter
  (`attempt`) is shared by BOTH a `connect()` exception AND a connection that
  came up but died within `STABLE_CONNECTION_SECONDS=10` of connecting —
  this second case was a real bug caught during implementation (a naive
  design that only counted `connect()`-exceptions would let a
  connects-then-immediately-dies cycle spin with zero backoff, since each
  cycle's `connect()` call itself "succeeds"). A connection that stayed up
  at least 10 seconds before dying resets the counter — an ordinary drop
  after real work is not penalized by unrelated past trouble.
- **A receive-thread race, found and fixed during implementation.** The
  Phase 3D receive thread originally read `self._ws` on every loop
  iteration; once reconnect could reassign `self._ws` to a new connection
  object, an old, not-yet-exited receive thread could start reading the
  BRAND NEW connection concurrently with that connection's own freshly
  started receive thread. Fixed by passing the specific connection object as
  an explicit thread argument (`_recv_run(self, connection)`), never reading
  `self._ws` from inside that thread — each receive thread is now bound for
  life to exactly the one connection it was started for, and exits on its
  own once that specific connection dies. Covered by a dedicated regression
  test (`test_reconnect_receive_thread_does_not_race_a_subsequent_reconnect`).
- **Never restarts the Agent Server or the execution.** This client has no
  code path touching Docker, the container, or `Conversation`/`.run()` — it
  only ever re-opens the outbound relay leg.
- **Relay failure never fails the agent run**, unchanged from Phase 3B: the
  main dispatch thread's blocking `conversation.run()` never waits on any of
  this.
- **The outbound queue survives a reconnect** (not cleared), so an event
  enqueued while disconnected is still delivered once a new connection comes
  up — on top of (never instead of) the authoritative HTTP event path, which
  is completely unaffected either way.
- **Stops permanently** once `close()` is called (dispatch ending) or the
  attempt budget is exhausted — `is_connected` becomes `False` and the
  dispatch proceeds exactly as if no relay existed, matching Phase 3B's
  original "relay is best-effort" contract.

### 4. Browser reconnect (as implemented)

`apps/web/lib/hooks/use-execution-realtime.ts` gained the same shape of
bounded reconnect, entirely client-side — **zero protocol changes**:

- On an unexpected socket close (anything other than a server-driven
  `execution.completed`, or this hook's own effect cleanup on unmount/
  `taskId`/`executionId` change), a new `WebSocket` is opened to the exact
  same URL after bounded exponential backoff with full jitter
  (`MAX_RECONNECT_ATTEMPTS=8`, `BASE_BACKOFF_MS=500`,
  `MAX_BACKOFF_MS=30_000` — the same policy shape as the worker relay's,
  independently implemented since a browser tab and a Python process share no
  code).
- **Every reconnect is, from the gateway's point of view, indistinguishable
  from a brand-new connection.** `routes/realtime-gateway.ts`'s
  `preValidation` re-runs session validation, Origin validation, live org
  membership (`requireOrgSession`'s `auth.api.getActiveMember()` re-query),
  and execution resolution/`RUNNING` status from scratch — nothing is
  restored from the old socket, because nothing about the old socket is even
  visible to the new connection attempt. This required no server-side code
  change; it is a direct consequence of Phase 3C's original design already
  making every connection independently re-derive its own state.
- **History reconciliation is what the gateway already did for every
  connection, reused, not rebuilt**: `history.ready` on the new connection
  carries the full current persisted-event set, including everything
  produced while the tab was disconnected. `eventsById`/`commandStatusesById`
  (this hook's own client-side caches) are deliberately NOT reset on a
  reconnect (only on a genuine new subscription) — `upsert()` is a plain
  `Map.set()` keyed by the event's own UUID, so replaying an already-known id
  is a harmless overwrite, never a duplicate rendered row.
- **Command uncertainty enforcement, new this phase.** The instant a socket
  closes unexpectedly, every command status this hook was still tracking as
  non-terminal (`received`/`authorized`/`forwarded`/`accepted`) is
  force-transitioned to `uncertain` (reason `connection_lost`) client-side,
  BEFORE any reconnect is attempted. This is the client-side half of the
  Step 2 durability decision: once the connection that could have told the
  browser a command's real outcome is gone, the gateway process on the other
  end may not even still exist (e.g. it just restarted) to ever answer —
  continuing to display a stale "forwarded" would be a fabricated certainty,
  not an honest "unknown."
- **Reconnect attempts stop** once: `execution.completed` was actually
  observed (never inferred from the socket alone); the caller's own
  `active` flag goes false (`RealWorkspaceView`'s own task/execution poll
  flips this the moment it observes a non-`RUNNING` status — this is the
  real backstop for "don't reconnect forever against a finished execution,"
  since a failed WebSocket handshake carries no HTTP status code the browser
  `WebSocket` API exposes to this hook, so a 409-because-finished rejection
  is otherwise indistinguishable from a transient network blip); the effect
  is cleaned up (unmount/id change); or the attempt budget is exhausted
  (surfaces as `status: "error"`, with the historical/polled event view
  remaining the correct fallback source, per this hook's pre-existing
  "coexist, don't replace" contract with `use-execution-events.ts`).
- A new `reconnecting` value was added to `RealtimeConnectionStatus` (no
  other consumer of this type exists in `apps/web` today, confirmed by
  search, so this is a strictly additive change).

### 5. Gateway restart behavior (as implemented/verified)

Verified via `realtime-reconnect.test.ts` tests 11-13 (fresh-instance
simulation, not a real process kill — impractical inside one
`node --test` run and explicitly not required by the assignment, which asks
for simulation via fresh registry instances):

- `RelayRegistry`, `ControlRegistry`, `ExecutionBroadcaster` are plain
  in-memory classes with no persistence of their own (confirmed by
  constructing fresh instances of each and observing empty state) — a real
  process restart re-evaluates these modules from scratch, which is exactly
  equivalent. `ControlRegistry`/`ExecutionBroadcaster`'s classes were changed
  from module-private to `export`ed (a pure visibility change, no behavior
  difference) specifically so tests could construct fresh instances rather
  than only asserting against the live singletons.
- A worker registering against an executionId this process has never seen is
  not a distinct code path from an ordinary first-time registration —
  post-restart, `relayRegistry` IS empty for every executionId, so a
  reconnecting worker's registration is, structurally, always a first-time
  registration into an empty map, authorized purely from current Postgres
  state.
- A browser reconnecting after a restart is likewise not a distinct code
  path from an ordinary reconnect (§4) — the gateway route has zero reliance
  on any state that isn't either freshly computed per-request
  (`requireOrgSession`, execution resolution) or the process-local
  singletons above, which would simply be empty. History is never affected
  (Postgres-backed, independent of process lifetime); only LIVE low-latency
  forwarding is briefly unavailable until a relay also reconnects.
- Unresolved command state after a restart follows the Step 2 decision
  exactly: gone from the server, and already independently marked
  `uncertain` on any browser tab that had it (§4).
- `SESSION_API_KEY` is still never required by, or visible to, `apps/api` —
  unchanged, and re-verified by this phase's own static assertions (below).
- The gateway never recovers by connecting directly to an Agent Server —
  no code path in any file this phase touched does, or ever did, anything
  but wait for a worker/browser to dial in.

### 6. Uncertainty reconciliation — left uncertain, no reliable correlation found

Step 6's audit (re-confirming, not repeating, Phase 3D's own already-honest
finding): a `commandId` is an AtherNull-invented identity, never passed to
the OpenHands SDK's `send_message(text)` call in any form — only the raw
message text crosses that boundary. There is therefore no wire-level field
anywhere in an OpenHands event payload that could ever carry a `commandId`
back, and embedding one inside the message text itself would (a) pollute
user-visible/agent-visible content and (b) still only be a text-similarity
heuristic dressed up as an id, which the assignment explicitly forbids
("do not match based on vague text similarity... do not fabricate
certainty"). No SDK-level idempotency or correlation mechanism was found
during this audit that wasn't already known and disclosed in Phase 3D.

**Conclusion: no change to the `executed` heuristic's own logic.** The
existing "oldest accepted command is upgraded to executed on the next
observed event" heuristic (`realtime-gateway.ts`,
`acceptedAwaitingExecuted`) is unchanged — still explicitly disclosed as a
heuristic, never a proof. The one thing Phase 3E verifies and adds a
regression test for (`realtime-reconnect.test.ts` test 17) is the boundary
condition this phase's own reconnect/uncertainty work could have
accidentally blurred: a command that went `uncertain` (never `accepted`) is
never added to `acceptedAwaitingExecuted`, and therefore can NEVER be
upgraded to `executed` by any later event, no matter how many arrive or how
long the connection survives afterward. The heuristic's blast radius is
provably confined to commands that were genuinely acked `accepted` — it
never reaches into `uncertain` territory to manufacture false confidence.

### 7. History/live reconciliation guarantees (invariants preserved, Step 5)

All eight invariants from the phase spec hold, verified by
`realtime-reconnect.test.ts`:

1. Postgres `execution_events` remains the sole authoritative historical
   source — unchanged.
2. Event UUID remains the sole dedupe identity — unchanged.
3. Duplicate live delivery is safe/idempotent — unchanged (client `Map.set`,
   server `sentIds` per connection).
4. Every event persisted in Postgres becomes visible after reconciliation —
   verified across an actual disconnect/reconnect cycle with events
   produced entirely while offline (test 6/7).
5. Socket loss does not mean the execution finished — the reconnect hook
   never infers completion from a close event, only from a real
   `execution.completed` message (§4).
6. Completion triggers final persisted-history reconciliation — unchanged
   from Phase 3D's `handleCompletion`, and additionally verified for the
   case where the browser was disconnected AT completion time and only
   reconnects afterward (test 9/10 — the realtime route correctly refuses
   the stale case with 409, and the historical route, unchanged since Phase
   2, is the correct fallback with the complete final event set).
7. Reconnect does not duplicate rendered events — verified via id-set
   equality checks across two connections (test 6/7/8).
8. Reconnect never replays browser commands automatically — verified
   directly (test 14/16) and audited as a hard invariant (§ below).

### 8. Backpressure policy (Step 11)

| Queue/buffer | Max size | Overflow behavior | Recoverable from Postgres? | User-facing warning? |
|---|---|---|---|---|
| Worker outbound relay queue (`RelayClient._queue`) | 200 messages | Drop-oldest (`deque(maxlen=200)`) | Yes — `execution_events` persistence is via the independent, authoritative HTTP path (`EventForwarder`), unaffected by this queue at all | No (purely a best-effort secondary channel; the authoritative path has no queue/loss at all) |
| Browser pre-history live buffer (`preHistoryBuffer`) | Unbounded array, but lifetime-bounded to the single subscribe→history-query gap (typically milliseconds) | N/A — flushed and discarded the moment `history.ready` is sent; never persists longer than one connection's startup | Yes — everything in it is also in, or about to be in, Postgres | No (invisible internal handoff device, not user-facing state) |
| `commandId` dedupe registry (`ControlRegistry.forwarded`) | 5,000 entries | Drop-oldest (FIFO) | No — but see Step 2's decision: this is a liveness bound, not a correctness-critical structure, given the no-automatic-replay invariant | No (an evicted old entry becoming "forwardable again" only matters if literally replayed, which never happens) |
| Pending command acks (`ControlRegistry.pending`) | One entry per in-flight `commandId`, implicitly bounded by `MAX_PENDING_COMMANDS_PER_CONNECTION=5` per connection | New commands rejected (`too_many_pending`) once the per-connection cap is hit — never silently dropped | N/A (this is live coordination state, not historical data) | **Yes** — an explicit `command.status: rejected, reason: too_many_pending` frame, always |
| Per-connection command rate limit (`rateLimitTimestamps`) | 10 commands / 10s window | New commands rejected (`rate_limited`) | N/A | **Yes** — explicit `rejected, reason: rate_limited` |
| Browser reconnect attempts (hook-side) | 8 attempts, bounded exponential backoff (0.5s-30s, full jitter) | Gives up, surfaces `status: "error"`; historical/polled view remains available | N/A (a connection attempt counter, not data) | Yes — `status` is exposed to the UI; a future UI pass could render this more prominently, but the state is already truthfully surfaced |
| Worker reconnect attempts (relay-side) | 8 attempts, bounded exponential backoff (0.5s-30s, full jitter) | Gives up; dispatch proceeds with no relay (exactly Phase 3B's original "unreachable at registration" contract) | N/A | No direct browser-facing signal beyond the pre-existing `relay.unavailable` message, which already covers "no relay currently registered" regardless of cause |

No unbounded queue exists anywhere in the realtime/reconnect surface,
confirmed by re-reading every one of the above alongside every Phase 3B/3C/3D
queue this phase did not need to change (`executionBroadcaster`'s
`EventEmitter` has no queue at all — synchronous, zero-buffer fan-out).

### 9. Heartbeat/liveness (Step 12)

**Finding:** neither `ws` (Node, gateway-side) nor Python's
`websockets.sync.client` (worker-side) sends periodic pings on its own; both
transparently answer a ping the OTHER side initiates. Nothing in this
codebase was periodically initiating one before this phase, so a half-open
TCP connection (peer process died, or a network path went dark without a
FIN/RST) could sit "registered"/"connected" for however long the OS-level
TCP keepalive takes (typically hours) — far longer than this system actually
needs to notice.

**Fix:** a new, small, shared module (`apps/api/src/realtime/heartbeat.ts`,
`attachHeartbeat(socket, intervalMs=30_000)`) wired into both
`routes/relay.ts` (worker leg) and `routes/realtime-gateway.ts` (browser
leg). Every interval, if the socket did not answer the PREVIOUS ping with a
pong, it is terminated (`socket.terminate()` — an abrupt close, matching
what a genuinely dead peer looks like); otherwise a new ping is sent. This
drives the exact same, pre-existing `close` handlers (`relayRegistry.
unregister`, browser subscription cleanup) — no new cleanup path, only a
bounded, faster trigger for the existing one. Purely observability/liveness:
a terminated socket never causes a database write; execution status in
Postgres remains authoritative regardless of socket state.

**State model exposed to the browser** (never inferred from socket state
alone — database execution status remains authoritative always):
`idle` (not subscribed) / `connecting` (first attempt) / `open` (live) /
`reconnecting` (a prior connection was lost, backoff in progress) /
`relay-unavailable` (informational — a `relay.unavailable` message was
received; independent of the above and never confused with "finished") /
`completed` (server-driven `execution.completed` only) / `error` (reconnect
budget exhausted) / `closed` (effect torn down).

### 10. Single-gateway v1 limitation (Step 13, restated)

Unchanged and still explicit: `relay-registry.ts`, `control-registry.ts`,
`execution-broadcaster.ts` remain single-process, in-memory singletons. No
Redis/pub-sub/distributed relay routing was introduced this phase, and none
was evaluated as in-scope — the phase spec explicitly excludes it. A
horizontally-scaled `apps/api` without sticky/affinity routing would still
need shared state for all three; Phase 3E's reconnect logic makes each
individual gateway instance more resilient to transient loss, but does
nothing to let a worker's relay registered on instance A become visible to
instance B.

### 11. Tests added and results

New file: `apps/api/test/realtime-reconnect.test.ts` — 20 new scenarios,
covering exactly what Phase 3B/3C/3D's own suites do not already cover (see
that file's own header comment for the explicit cross-reference of which
of the phase spec's 28 numbered scenarios land in which file — several,
e.g. at-most-once dedupe, `lease_mismatch` rejection, and relay-loss-does-
not-stop-persistence, are already proven in `relay.test.ts`/
`realtime-control.test.ts` and were deliberately not re-proven here).
**20/20 passed**, run twice consecutively with identical results before
being folded into the full-suite repeat-run below.

`workers/coding-agent/tests/test_relay_client.py` gained 6 new reconnect
scenarios (transient-failure reconnect, terminal-rejection no-retry,
bounded give-up on persistent transient failure, bounded give-up on
connect-then-immediately-die, queued events surviving a reconnect, and the
receive-thread race regression). **Full worker suite: 46/46 passed**, run 3
times consecutively with identical results (26/26 in `test_relay_client.py`
alone, up from the pre-existing 20/20; 46/46 total, up from the pre-existing
40/40).

Two production files gained a purely additive `export` keyword
(`ControlRegistry`, `ExecutionBroadcaster` classes) with no behavior change,
solely so the new restart-simulation tests could construct fresh instances.

### 12. Repeated-full-suite stability (Step 15)

`apps/api` full suite (`node --import tsx --test test/**/*.test.ts`, real
Postgres, 7 test files including the new one) was run 15 times consecutively,
each run fully isolated (a fresh `node` process per run, real Postgres,
no shared in-process state across runs). **Exact result: 15/15 runs green,
106/106 tests passing in every single run, 0 failures in every single run**
(1,590 individual test-assertion-runs total across the 15 repetitions, zero
failures). Per-run breakdown (`RUN i exit=0 tests=106 pass=106 fail=0` for
every `i` in 1-15) is preserved verbatim in this phase's own working log.

One data point disclosed honestly, not hidden: an EARLIER attempt at this
same 15x loop (before the clean run reported above) hit a real ~27-minute
wall-clock stall between its run 7 and run 8, caused by an unrelated
interruption to this session's own execution environment (a stream/harness
pause, not anything in the code under test). Immediately after that stall,
run 8 of that EARLIER attempt hit one assertion failure:
`signUpVerifiedAndSignIn` in `tenant-authorization.test.ts` received HTTP 500
instead of 200 from Better Auth's sign-up endpoint. This has the same
signature as the known pre-existing Better Auth/bcrypt-style flaky 500 under
heavy load this project has observed before (named explicitly, not
lumped in with anything else) — but this session cannot confirm that
classification with certainty, because the log-capture script for that
earlier attempt only retained each run's last 12 lines, which was
insufficient once a failure produced a long stack trace, so the exact
pass/fail counts for that specific run were lost and are NOT reported here
as a number (reporting a rounded or guessed count would violate this
engagement's own evidence standard). That earlier attempt's background
process did not survive the same environment interruption and was
abandoned; the 15x run reported above as this phase's authoritative result
was started fresh afterward, with full untruncated per-run logs retained,
and is unambiguously clean. Given the failure (if it occurred as suspected)
immediately followed an abnormal 27-minute idle gap — a plausible trigger
for a stale/expired Postgres connection-pool entry independent of any
concurrent-load condition — and given the properly-isolated rerun was
uniformly clean, this is recorded as an inconclusive, likely
environment-stall artifact, not a new defect attributable to Phase 3E's
own code.

`workers/coding-agent` pytest suite was run 3 times consecutively: **46/46
passed** every run (26/26 in `test_relay_client.py` — 20 pre-existing + 6
new Phase 3E reconnect tests — plus 20 unchanged from
`test_agent_server_adapter.py`), no flakiness observed, and re-run a 4th
time standalone with the same 46/46 result while this ADR section was being
written.

### 13. Failure-injection test results

Every scenario in the phase spec's Step 14 test list that is genuinely new
to this phase (not already covered by Phase 3B/3C/3D's own suites) is listed
in §11 above with its pass result. No test was skipped or weakened to make
it pass.

### 14. Real execution verification (Step 16)

**Not attempted this phase — explicitly, not fabricated.** Phase 3D's own
ADR section above already required, and completed, a real Docker/Agent-
Server/LLM end-to-end verification for the command-forwarding path this
phase builds reconnect on top of. Repeating a full real-execution run for
Phase 3E specifically would require: a real LLM API credential, a real
multi-minute agent dispatch, and a deliberate mid-dispatch network/process
interruption timed against a live container — the same category of
real-world race Phase 3D's own verification already disclosed losing once
("the real worker's local `send_message()` call... completed faster than the
OS could deliver and act on the kill signal"). Given that prior, honestly-
reported experience, and that every reconnect/backoff/uncertainty code path
this phase adds is independently, deterministically covered by the
automated tests in §11 (using real Postgres and real WebSocket upgrades via
`injectWS`/real `ws` connections, not mocks of the gateway itself), a second
attempt at timing a real process kill against a live dispatch was judged
low-value relative to its cost and was not run. This is a limitation of this
verification pass, not a claim that the feature works in production absent
further real-world observation.

### 15. SESSION_API_KEY boundary verification

Checked the same way every prior phase did, extended to the new files: a
static, comment-stripped source scan
(`realtime-reconnect.test.ts`'s own static-assertion suite) confirms
`SESSION_API_KEY` never appears in `heartbeat.ts`'s or the touched routes'
(`relay.ts`, `realtime-gateway.ts`) executable code. `relay_client.py`'s
pre-existing static assertion
(`test_relay_client_module_never_references_session_api_key_outside_docs`)
was re-run unchanged against the file's new reconnect code and passed,
confirming the credential is absent from the new Python code too.

### 16. INTERNAL_API_TOKEN boundary verification

Checked via a new static assertion confirming `INTERNAL_API_TOKEN` never
appears in `apps/web/lib/hooks/use-execution-realtime.ts` (the only
browser-shipped file this phase touched) — the browser-facing reconnect
logic re-uses the exact same `realtimeWebSocketUrl()` builder Phase 3C
already established, which carries no worker credential of any kind
(session cookies are the browser's only credential, sent automatically by
the browser's own WebSocket upgrade).

### 17. Remaining reliability limitations (honest, not exhaustive)

- No durable command ledger (Step 2's own decision, not an oversight).
- No cross-instance relay/broadcast routing (§10, explicitly out of scope).
- The `executed` heuristic is still per-connection/order-based, not a real
  correlation (§6) — unchanged from Phase 3D, re-confirmed not improvable
  with currently-available SDK evidence.
- A browser's reconnect give-up (`status: "error"`) cannot distinguish "the
  execution finished" from "the gateway is still unreachable" purely from
  the failed WebSocket handshake — the task/execution poll remains the real
  backstop for the former.
- Heartbeat interval (30s) is a liveness bound, not a low-latency dead-peer
  detector — a connection can be dead for up to ~30-60s before either side
  notices via ping/pong (bounded by the interval, not unbounded, but not
  instant either).
- No real end-to-end verification was performed this phase (§14) — only
  deterministic automated coverage.

### 18. Exact guarantees AtherNull realtime now provides (post-Phase 3E)

- Execution continues, unaffected, when either leg of realtime fails
  entirely (worker relay, browser socket, or the gateway process itself
  restarting) — persistence and the agent run are both independent of
  realtime connection state, and this holds for the FULL duration of a
  dispatch now that the worker relay itself can recover from a transient
  drop.
- A worker relay recovers from a transient network interruption without
  restarting the Agent Server, the execution, or losing its position in the
  event stream, bounded by 8 attempts / ~30s max backoff per attempt.
- A browser tab recovers from a transient disconnection (network blip, tab
  backgrounding, laptop sleep) without losing any persisted event and
  without duplicating any rendered event, bounded by the same attempt
  budget.
- Every event persisted in Postgres is guaranteed visible to a reconnecting,
  still-authorized browser, exactly once.
- A command's outcome is always either a real terminal status from the
  gateway, or an explicit, honestly-labeled `uncertain` — never silently
  forgotten, never fabricated as success or failure, and never automatically
  resent under any circumstance (verified as a hard invariant).
- Authorization (session, Origin, org membership, `realtime:view`,
  `realtime:control`, execution/lease state) is rechecked from current
  database state on every single reconnect and every single command — never
  restored from a prior connection's privileges.
- `SESSION_API_KEY` and `INTERNAL_API_TOKEN` remain exactly as contained as
  Phase 3A-3D established — unchanged by anything reconnect-related.
- No queue in this subsystem is unbounded; command-queue overflow is always
  an explicit, visible rejection, never a silent drop.

### 19. Exact guarantees intentionally NOT provided

- Exactly-once command execution at the Agent Server (impossible without an
  SDK-level idempotency key, which does not exist today).
- A durable record of command history surviving a gateway restart.
- Cross-instance realtime routing/horizontal scaling of the gateway.
- A precise, proven commandId<->execution-event correlation (`executed`
  remains a heuristic).
- Sub-second dead-peer detection (heartbeat is bounded, not instant).
- Automatic replay/retry of any command, ever, under any failure condition.

### 20. Recommended next product milestone

Given Phase 3E closes out the reconnect/recovery hardening this ADR's own
phase sequence called for, and every remaining gap above is either
explicitly out of scope (multi-instance scaling) or fundamentally bounded by
the SDK's own lack of idempotency (exactly-once execution), the natural next
milestone is **outside this ADR's own realtime scope**: either (a) the
terminal/bash command surface this and Phase 3D both deliberately deferred,
contingent on a real, audited SDK-native mechanism appearing, or (b) product
work on the workspace UI itself (richer rendering of `uncertain` states,
reconnect status affordances) now that the underlying transport guarantees
in §18 are stable enough to build a polished UI on top of without that UI
having to work around transport-level surprises.

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
