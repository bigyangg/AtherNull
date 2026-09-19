# ADR-0001: Integrate OpenHands as a pinned SDK dependency, not a fork

Status: Accepted
Date: 2026-09-19

## Context

The coding-agent worker needs an autonomous coding agent implementation. We could fork OpenHands
and modify it directly, or depend on its published SDK. A fork gives unlimited control but means
we own merge conflicts against upstream forever; a dependency is easier to upgrade but limits us
to published extension points.

Research confirmed the SDK is a good fit for a dependency-based approach:
- `openhands-sdk` / `openhands-tools` are released as a matched pair on PyPI (current: 1.42.1,
  Aug 2026), Python >=3.12, MIT licensed.
- The package already splits into `openhands.sdk` (core), `openhands.tools`, `openhands.workspace`
  (Local/Docker/Remote sandbox abstractions), and `openhands.agent_server` (REST/WebSocket) —
  matching the separation of concerns this platform already wants (spec §3, §6).
- `DockerWorkspace` upgrades a `Conversation` to a `RemoteConversation` automatically, streaming
  events over WebSocket while keeping the LLM/credentials in the trusted outer process — this
  lines up with the non-negotiable rule that an agent never gets host SSH/Docker socket/prod
  credentials.

## Decision

Install `openhands-sdk` and `openhands-tools` as pinned dependencies (exact versions, upgraded
together deliberately) inside `workers/coding-agent`. Build our own adapter module around the
SDK's `Agent`/`Conversation`/`Tool` API rather than forking. Only evaluate the standalone Agent
Server deployment if a remote-lifecycle requirement (e.g. horizontally scaled sandbox fleet)
specifically justifies it later.

Package/API compatibility must be re-checked against whatever release we pin before each version
bump — this ADR records the strategy, not a permanent version lock.

## Consequences

- Upgrades are `pip install -U openhands-sdk openhands-tools` plus a compatibility check, not a
  rebase against a diverged fork.
- Our public platform API (`packages/contracts`) stays insulated from OpenHands' internal
  signatures because worker-internal calls go through our own adapter (spec §7).
- We inherit any SDK-level bugs/behavior changes on their release cadence; mitigate by pinning
  exact versions and testing before bumping, not tracking `latest`.
