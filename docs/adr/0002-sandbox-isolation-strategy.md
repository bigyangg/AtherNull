# ADR-0002: Sandbox isolation strategy for disposable execution

Status: Proposed — blocked on confirming Coolify VPS provider's KVM/nested-virtualization support
Date: 2026-09-19

## Context

Spec §6 requires one disposable, isolated execution sandbox per active job, with no host Docker
socket, no privileged containers, and no sibling-tenant access. The spec left the exact isolation
mechanism as "dedicated host or stronger VM/microVM isolation" without picking one.

Research findings:
- OpenHands' own `DockerWorkspace` only documents "complete isolation from the host" at a
  marketing level — no documented resource-limit defaults or multi-tenant hardening. Treat plain
  Docker (runc) as container-level isolation only, not a boundary against an adversarial or buggy
  agent escaping via a kernel exploit.
- Firecracker/Kata microVMs give the strongest boundary (dedicated guest kernel per job) but
  require direct `/dev/kvm` access with nested virtualization exposed to the host. AWS standard
  (non-`.metal`) instances don't expose this; DigitalOcean, Azure and GCP often do, but this is
  provider- and plan-specific and has not been confirmed for our actual Coolify VPS.
- gVisor (`runsc`) swaps in as a Docker runtime (`--runtime=runsc`) with no bare-metal or KVM
  requirement, intercepting syscalls in userspace. It's the standard 2026 recommendation for
  multi-tenant hosts sharing node capacity across untrusted workloads (CI runners, code-execution
  sandboxes, SaaS isolation boundaries) — closer to this platform's "may be shared" infra model
  (spec §2) than Firecracker's per-tenant dedicated-host assumption. Caveat: doesn't implement
  every syscall, so the agent's actual tool use (git, package installs, test runners) needs to be
  validated against it before committing.
- Daytona ships a "Runtime for OpenHands" integration merged into OpenHands mainline: hosted,
  ephemeral, zero-trust sandboxes via an API key and one install command, no self-hosted isolation
  infra required. Useful to unblock Phase 2/3 demos without building sandbox infra first.

## Decision (proposed)

1. For the Phase 2/3 spike and early demo: use either gVisor-hardened `DockerWorkspace` on
   existing infra, or Daytona-hosted sandboxes via the OpenHands workspace integration — whichever
   unblocks the demo faster. Do not block the MVP on Firecracker.
2. Before committing to Firecracker/Kata as the production isolation layer, confirm whether the
   Coolify VPS (or whatever host is chosen for "separate worker infrastructure", spec §6) exposes
   `/dev/kvm` with nested virtualization. If not, either move worker infra to a provider/instance
   type that does, or standardize on gVisor long-term.
3. Either way: default-deny outbound network, enforce CPU/memory/wall-time/spend limits outside
   the agent process, one sandbox per execution, destroy after artifact export (spec §6 minimum
   sandbox policy).

## Consequences

- Unblocks Phase 2/3 without waiting on infra procurement.
- Defers the harder infra decision (Firecracker vs. gVisor long-term) until there's a real
  workload to threat-model against, but that decision must be made — and the VPS capability
  confirmed — before Phase 3 exit criteria ("no host or sibling-tenant access; cleanup verified")
  can be honestly claimed.
