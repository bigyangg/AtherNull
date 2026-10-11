# ADR-0017: Independent verification of builds

Status: Accepted, implemented and verified end to end locally
Date: 2026-10-11

## Context

Spec §3/§8 and PLAN.md §1: a worker reports results but cannot approve its
own work, and payment depends on verified results. Until now verification
was a privileged human clicking "Mark as passed", and the only record of a
build's change was the agent's own edit events.

## Decision

1. **The change is the artifact.** When the agent finishes, the worker
   (`org_sandbox` adapter) captures `git add -A && git diff --cached
   --binary <approved revision>` in the sandbox and submits it to
   `POST /internal/executions/:id/patch` (worker token + lease). Stored in
   `execution_patches` (migration 0017): base revision, patch, sha256,
   file/line stats; immutable once captured, one per execution. If the
   patch cannot be captured the build fails (nothing verifiable, nothing
   payable).

2. **A separate verifier service** (`services/verifier`, stdlib Python):
   claims a VERIFYING build (`/internal/verifications/claim`, leased),
   clones the repository, checks out the approved revision (no line-ending
   conversion), applies ONLY the captured patch, detects the test command
   (`npm test` for a real test script, else pytest), runs an install step
   if dependencies exist (network allowed), then the tests in a throwaway
   container with `--network none`, memory/CPU/PID limits and a timeout.
   PASS requires exit 0, at least one test, and no failing test; a patch
   that does not apply, an empty patch, no test command, a timeout or a
   verifier crash are all FAIL.

3. **Its own credential.** The verifier authenticates with
   `VERIFIER_API_TOKEN`, which must differ from the worker's
   `INTERNAL_API_TOKEN` (equal tokens disable the verifier endpoints). A
   worker can submit a patch but can never claim or report a verification.
   The verifier never receives the worker's success claim or the agent's own
   test output.

4. **The verdict moves the money state.**
   `/internal/verifications/:executionId/result` records a
   `verification_runs` row (verifier_version `athernull-verifier/1`,
   `artifact_hash` = patch sha256, tests, evidence incl. command, exit code,
   log tail) and moves the task VERIFYING → AWAITING_ACCEPTANCE (PASS) or
   FAILED (FAIL, refundable per ADR-0014), exactly once.

5. **The customer sees what was verified.** `GET /v1/jobs/:id/patch`
   (org-scoped) feeds the canvas Changes tab as a unified diff; Checks shows
   the independent evidence. Manual PASS/FAIL stays only as an owner/admin
   override.

## Verified

A real build on `examples/demo-api` (dependency-free Node notes API): the
agent added `GET /version`; the patch (2 files, +18/−1) was captured; the
verifier applied it to a fresh checkout and ran `npm test` with no
network — 5/5 including the agent's new test — and the task moved to
AWAITING_ACCEPTANCE with no human step. A deliberately breaking patch FAILs
naming the broken test. API tests cover capture, claim, verdict, tenancy
and the worker/verifier separation; verifier unit tests cover detection,
TAP/spec/pytest parsing and the strict decision.

## Consequences

- Tests are the acceptance mechanism: a repository without tests cannot pass
  verification. Acceptance criteria that tests do not cover are still
  reviewed by the customer, with the diff in front of them.
- Install steps reach the network; the test run does not.
- The verifier runs on a host with Docker; isolation of the test container
  follows ADR-0002 (Docker today).
- Per-execution (`direct`/`agent_server`) builds capture no patch and keep
  the manual path.
- The API test suite now runs files serially (`--test-concurrency=1`): the
  claim queue is global, and parallel files raced for each other's tasks.
