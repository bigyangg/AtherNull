# Workspace onboarding

How a new user's private agent workspace (an org sandbox, ADR-0015/0018) gets ready, and why it is fast and safe.

## The problem (measured 2026-10-13)

| Step | Time |
|---|---|
| Canvas JS + account/organization checks | 1-3 s, blank page |
| Provisioner picks up the request | up to 2 s |
| `docker run` | ~6 s |
| Agent server unpacks itself (PyInstaller one-file binary, 174 MB into `/tmp`, 2 CPUs) | ~30 s |
| Agent server boots | ~11 s |
| Configure (LLM, telemetry off, Builds extension) and register | < 1 s |

About 50 s per workspace, and the provisioner handled one at a time: the third of three simultaneous sign-ups waited for two full builds. The workspace was only requested once the canvas opened.

## The design

1. **Requested at first sign-in.** `auth.ts` `databaseHooks.session.create.after` records the request. Sessions exist only for verified users (`requireEmailVerification`), so an unverified sign-up never starts a sandbox. It never blocks or fails a sign-in.
2. **Warm pool.** The provisioner keeps `SANDBOX_WARM_POOL_SIZE` generic sandboxes booted and configured (`sandbox_pool`). A new organization is handed one in a single transaction: lock (`FOR UPDATE SKIP LOCKED`), health-check, delete from the pool, write `org_agent_servers`. About 1 s from sign-in to ready.
3. **Parallel provisioning.** `SANDBOX_PROVISIONER_CONCURRENCY` loops claim requests with `SKIP LOCKED`; Docker calls are async so the loops really overlap.
4. **Visible progress.** The provisioner records a phase (`QUEUED`, `STARTING`, `BOOTING`, `CONFIGURING`, `READY`). `GET /v1/agent-sandbox` returns it with the queue position, whether a quick start is available, and whether the host is at capacity. The canvas setup screen (patch 0009) is on screen at once, shows real steps and an elapsed timer, and hands over to the app without a reload.

The pool refills only when no request is waiting or being set up, so a spare never competes with a customer's workspace for CPU and memory.

## Security decisions

| Concern | Decision |
|---|---|
| Fake sign-ups starting containers | Workspaces are requested only for verified users (first session), never at sign-up. |
| One user starting many sandboxes by creating organizations | At most `SANDBOX_MAX_PER_USER` (default 3) requests per user across organizations; more returns 429. |
| Host exhaustion | At most `SANDBOX_MAX_RUNNING` sandboxes (organizations' plus pool's). Past it, a new organization waits in line (the setup screen says so) unless a pool sandbox is ready. |
| A pool sandbox reaching two organizations | Handout is one transaction with the row lock; the row is deleted as the organization's row is written. Tested with two concurrent handouts. |
| Organization data in a pool sandbox | A pool sandbox holds only what every sandbox gets: the deployment LLM settings and the Builds extension. Pool sandboxes are never recycled: once handed out they belong to that organization for life. |
| Existing organizations | Never get a pool sandbox: their data is on their own volume, so their sandbox is recreated in place. |
| Outdated pool sandboxes | Each carries a policy fingerprint (image, limits, network) and a configuration fingerprint (model, key hash, extension files). Mismatches are never handed out and are removed. |
| Crash mid-handout or mid-warm | Pool containers are labelled `athernull.pool=1`. Reconcile removes rows whose container is gone or stuck warming, and labelled containers that belong to neither the pool nor an organization. |
| Operator detail leaking to customers | A failed request shows "Your workspace could not be started." The provisioner's error stays in the database for operators. |
| Setup screen injection | Server values are written with `textContent` only. |
| Firewall | Pool sandboxes go through the same `assertFirewall` and run policy as every sandbox. |

Session keys are stored as before (`org_agent_servers`, now also `sandbox_pool`) and never reach a browser. Encrypting them at rest is the open Phase 0 item.

## Sizing

An idle sandbox uses about 250-450 MB of RAM; a booting one needs its full CPU allowance for about 40 s. On one host:

- `SANDBOX_WARM_POOL_SIZE`: 1 for a small VPS, 2-3 when sign-ups come in bursts.
- `SANDBOX_PROVISIONER_CONCURRENCY`: about cores / 2 (each boot is CPU-bound).
- `SANDBOX_MAX_RUNNING`: (RAM available to sandboxes) / 0.5 GB, leaving headroom for builds.

Every organization's sandbox keeps running. Stopping idle sandboxes and waking them on demand is the next step before more than a handful of active users.
