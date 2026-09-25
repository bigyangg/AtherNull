# ADR-0005: Agent Server execution isolation

Status: Accepted
Date: 2026-09-22

## Context

The Agent Server integration (approved scope, Phase 1) requirement 6 asked us to validate how
Agent Server instances are provisioned and destroyed per execution, without giving one tenant's
execution access to another's. This ADR records that validation.

It turns out AtherNull's worker (`workers/coding-agent`) already runs a full Agent Server per
execution today, invisibly: `run_dispatch()`'s `DockerWorkspace` (ADR-0001) launches
`ghcr.io/openhands/agent-server:latest-python` in a fresh container per task, and the SDK drives it
internally over the same REST/WebSocket API this integration now taps into directly
(`coding_agent.agent_server_adapter`). Reading `openhands/workspace/docker/workspace.py` directly
(not just its docs) surfaced two concrete facts that shape this ADR:

1. `DockerWorkspace` never sets a session key unless `SESSION_API_KEY` (or `OH_SESSION_API_KEYS_0`)
   is present in the worker process's own environment before construction — confirmed by running a
   container this way and successfully calling its API with zero auth headers. **Every task's
   container Agent Server has been running fully unauthenticated up to this point.**
2. `_start_container()`'s docker-run flags (`-p {host_port}:8000`) publish the container's port to
   all host network interfaces, not just loopback, even though the SDK's own client only ever talks
   to `127.0.0.1`. There is no public field on the installed `DockerWorkspace` to change this.

## Decision

- **Isolation boundary that already exists, unchanged by this work**: one Docker container per
  execution, provisioned by `DockerWorkspace` and torn down via `docker_workspace.cleanup()` in
  `worker.py`'s (and now `agent_server_adapter.py`'s) `finally` block. This is the same container
  model ADR-0002 already scoped ("gVisor-hardened `DockerWorkspace` on existing infra" for the
  Phase 2/3 spike) — this work does not change or replace that container-runtime decision, only
  what runs authenticated inside it.
- **Fix, enabled with `EXECUTION_ADAPTER=agent_server`**: `agent_server_adapter.py` generates a random per-execution key
  (`secrets.token_hex(32)`), sets it as `SESSION_API_KEY` before constructing `DockerWorkspace`
  (forwarded into the container automatically via its `forward_env` default), and sets
  `docker_workspace.api_key` to the same value immediately after construction — `RemoteWorkspaceMixin`
  reads `api_key` fresh on every outgoing request, so this is sufficient without patching the SDK.
  Verified live: a request without the header, or with the wrong key, gets `401`; the correct key
  passes authentication. This key never leaves the worker process — not sent to apps/api, not
  stored in the database, not reachable by the browser (apps/api and the frontend only ever see the
  conversation id and the persisted `execution_events` rows).
- **Named residual gap, not fixed by this work**: the host-interface port publishing means another
  process on the same host (or another container published the same way) could still reach a
  task's container over the network, key notwithstanding, if it can guess or intercept the key.
  Closing this fully requires overriding `DockerWorkspace._start_container`'s docker-run flags (a
  small subclass, not an SDK fork — consistent with ADR-0001's "adapter, not a fork" stance) to bind
  `127.0.0.1:{host_port}:8000` instead of `{host_port}:8000`. Tracked as a fast-follow.

## Consequences

- The default `direct` adapter does not apply this authentication fix; enable the new adapter and restart the worker to use it.
- Closes a real, previously-unrecognized gap (unauthenticated per-task Agent Servers) as a
  byproduct of this integration, not a separate hardening project.
- Multi-tenant safety for this phase rests on two layers: container-per-execution (existing) +
  per-execution random session key (new). It does not yet rest on network-level isolation between
  containers on the same host — that remains ADR-0002's open item plus the port-binding fast-follow
  above, both of which matter more once workloads run on shared infra rather than a single dev host.
- Any future move to Firecracker/gVisor (ADR-0002) or to a subclassed `DockerWorkspace` with
  loopback-only publishing composes cleanly with this decision — neither changes where the session
  key is generated or how the worker authenticates to its own container.

## Addendum (2026-09-26): the port-binding residual gap is closed

The residual gap named above — `DockerWorkspace._start_container` publishing the container's port
to all host interfaces — is fixed, as ADR-0007 Phase 3A. `coding_agent.loopback_docker_workspace.
LoopbackDockerWorkspace` (a local subclass, not an SDK fork, exactly as this ADR anticipated)
overrides `_start_container` to bind `127.0.0.1:{host_port}:8000` instead of `{host_port}:8000`,
and both of `workers/coding-agent`'s own `DockerWorkspace` call sites (`worker.py::run_dispatch`,
`agent_server_adapter.py::run_dispatch_via_agent_server`) now construct that subclass. Verified
empirically against real containers: before the fix, `netstat` showed `0.0.0.0`/`[::]` LISTENING
on the mapped port and a LAN-IP connection to the container succeeded; after the fix, `netstat`
shows only a `127.0.0.1` listener, a LAN-IP connection fails, and a localhost connection still
succeeds. Full before/after evidence, the exact pinned `openhands-workspace` version this override
is coupled to, and the required upgrade-check procedure are recorded in
docs/adr/0007-secure-realtime-execution.md's Phase 3A completion addendum.
