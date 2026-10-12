# ADR-0019: Commits as the record of work (AtherNull-hosted repositories)

Status: Accepted — steps 0 and 1 implemented and verified end to end locally; steps 2–4 planned
Date: 2026-10-12

## Context

Today a build's change exists only as a captured patch (ADR-0017). Nothing
is ever committed: an accepted build is not saved anywhere the customer can
use, a customer needs an existing *public* repository URL to start, private
repositories fail (no credentials), and a non-technical customer cannot use
AtherNull at all.

We want one model for every customer: **every accepted build is a commit.**
A customer with no GitHub account still gets a versioned project; a
customer who links GitHub additionally gets the same commits as a pull
request.

## Decision

### 1. AtherNull hosts a git repository for every project

- One bare repository per project at `REPOS_ROOT/<organizationId>/<projectId>.git`
  (`REPOS_ROOT` defaults to `apps/api/.data/repos` in development; a
  persistent volume in production). Paths are derived from ids only, never
  from user input.
- Only the API process reads or writes these repositories, through one
  module (`apps/api/src/repos/`): the `git` CLI via `execFile` (no shell),
  always with `core.autocrlf=false`, and a per-repository Postgres advisory
  lock around anything that moves a ref.
- `main` is the project's official version. **`main` moves only when a
  customer accepts a verified build, or undoes one** — never because of an
  agent.
- New project: the repository is created with an initial commit holding a
  README and a default `.gitignore` (dependencies, build output, `.env*`),
  so even an empty project has a base commit and secrets/dependencies are
  not committed by accident.
- Import (a public URL, or a local path in development): the default branch
  is fetched once into `main`. Existing projects are imported lazily the
  first time a build is set up for them.

### 2. Code moves as git bundles; the sandbox never gets credentials

There is no git server and no repository credential in any sandbox. The
worker carries code in both directions as git bundles over the internal API
it already uses (worker token + execution lease, like patch capture):

- `GET  /internal/executions/:id/repo-bundle` — bundle of the build's
  `base_commit`; the worker uploads it into the sandbox and clones it
  (the existing bundle path in `org_sandbox_adapter._prepare_repository`).
- `POST /internal/executions/:id/result-bundle` — when the agent finishes,
  the worker squashes the work into **one commit** on `builds/<taskId>`
  (`git reset --soft <base>` + commit), authored `AtherNull Agent
  <agent@athernull.io>`, message = build title, trailers `Build-Id` and
  `Execution-Id`; bundles that branch (`builds/<id> ^<base>`) and submits it.
- The API accepts the bundle only if: it verifies, it contains exactly
  `refs/heads/builds/<taskId>`, the head's parent is the build's
  `base_commit`, and it is under the size cap (50 MB). It fetches it into
  the project repository as `builds/<taskId>` and records `result_commit`.
- The patch (ADR-0017) is now *derived*: `git diff base_commit..result_commit`
  is written to `execution_patches`, so the Changes view and existing
  records keep working unchanged.

### 3. The verifier checks the exact commit

- `GET /internal/verifications/:executionId/bundle` (verifier token) — a
  bundle of the commit under verification. The verifier clones it and checks
  out that commit; it no longer applies a patch (removing the line-ending
  failure class seen in ADR-0017's rollout). Everything else in ADR-0017
  (no-network container, strict PASS rule, separate token) is unchanged.

### 4. Accept merges; the money and the repository stay consistent

On `POST /v1/jobs/:id/accept`, under the repository lock:

- **`main` is still `base_commit`** → fast-forward candidate = `result_commit`.
- **`main` moved** (another build was accepted meanwhile) → three-way merge
  into a candidate commit. Clean → the candidate is **re-verified** before
  anything happens (the task shows *Updating*; acceptance completes when it
  passes). Conflict → the task shows *Needs update* and cannot be accepted
  (v1 has no conflict tooling; a follow-up build on the new `main` resolves
  it).
- With a verified candidate: the payout decision commits in the database
  (`decidePayout`, unchanged) together with `merged_commit`, then `main` is
  moved to it. The database is the intent; a startup reconciliation moves
  any `main` that lags its latest `merged_commit`. Reject/refund never
  touches `main`; the build branch is kept as the record.

### 5. Versions, download and undo

- `GET  /v1/projects/:id/versions` — first-parent history of `main`
  (version number, title, build id from the trailer, date).
- `GET  /v1/projects/:id/archive?commit=` — zip of any version (`git archive`).
- `POST /v1/projects/:id/versions/:commit/undo` (owner/admin) — a revert
  commit on top of `main`, verified like a build before `main` moves; no
  agent, no charge. Nothing is ever deleted or force-pushed, so an undo can
  itself be undone.

### 6. Data model (migration 0020)

- `projects`: `repo_kind` (`hosted` | `github`, null = not yet imported),
  `default_branch` (default `main`); later `github_installation_id`,
  `github_repo`.
- `tasks`: `base_commit`, `result_commit`, `merged_commit`, `merge_state`
  (null | `VERIFYING` | `CONFLICT`); the build branch is always
  `builds/<task id>`. `base_commit` is pinned on the build's first dispatch
  (the task's approved revision if it names a commit, else the current
  `main`) and, like `merged_commit`, is immutable once set (trigger). Task
  status values are unchanged; acceptance completes only once merged.
- `execution_patches.result_commit`: the commit the verifier checks out;
  null for patches captured before this ADR (still verified by applying
  the patch). A project AtherNull cannot host yet (e.g. a private
  repository before GitHub is linked) dispatches without a base commit and
  keeps the ADR-0017 path.
- Git is the source of truth for content; the database caches commit ids.

### 7. GitHub is a mirror at both ends (phase 2)

A GitHub App: pick a repository instead of typing a URL; private
repositories are imported with a short-lived installation token held by the
API only; before each build `main` is refreshed from GitHub; on accept the
build branch is pushed and a pull request opened (optional per-project
auto-merge). The hosted repository stays the record either way.

## Implementation steps (each ends green and demoable)

| Step | Scope | Done when |
|---|---|---|
| 0 ✅ | `repos/` module: create (initial commit), import, bundle out/in, ancestry check, merge (ff/clean/conflict), revert, archive, lock | unit tests on temp repos pass on Windows and Linux |
| 1 ✅ | Migration 0020; lazy import of the project repository; `base_commit` pinned on first dispatch; repo-bundle / result-bundle / verifier bundle endpoints; worker squash-commit + bundle; derived patch; verifier checks out the commit | done 2026-10-12: the demo `/version` build ended as one commit `a49f94a` by AtherNull Agent on `builds/<id>` (parent = base, main untouched), verifier PASS 5/5 on that exact commit |
| 2 | Accept = fast-forward / merge + re-verify / conflict; reconciliation | accepting moves `main` by exactly one commit; a moved `main` re-verifies; a conflict blocks acceptance |
| 3 | UI: "New project" / "Use a public repo" in the build dialog; Versions panel with Download and Undo | a new account builds, accepts, downloads a zip and undoes, with no repository URL |
| 4 | GitHub App: import, private repos, PR on accept | an accepted build appears as a PR on the linked repository |

## Consequences

- Every customer gets durable, versioned results; a non-technical customer
  never sees git terms.
- No credentials reach a sandbox; the API is the only writer of `main`.
- Storage grows with projects; repositories need backup with the database.
- The API host needs `git` ≥ 2.40 (`merge-tree --write-tree --merge-base`);
  `apps/api/.data/` (the development `REPOS_ROOT`) is git-ignored.
- Large repositories are bounded by the bundle cap (clear error, not a hang).
- Conflict resolution is deliberately out of scope for v1.
