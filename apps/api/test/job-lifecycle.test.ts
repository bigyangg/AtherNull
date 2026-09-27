// Integration tests for the task lifecycle beyond funding: estimate, verify,
// accept, reject. Runs against a real Postgres database via Fastify
// inject(), same style as tenant-authorization.test.ts — see that file's
// header comment for how to create/migrate the test database (must include
// migrations through 0007_execution_events.sql).
//
// --- Test-infrastructure note: the shared claim queue race (read this before
// adding any new test that touches /internal/executions/claim) -----------
//
// This suite runs each *.test.ts file as its own concurrent OS process
// (`node --import tsx --test test/**/*.test.ts`), all pointed at one real,
// persistent Postgres database with no reset/truncate between files or runs
// (see tenant-authorization.test.ts's header for why). `POST
// /internal/executions/claim` (src/routes/internal.ts) is, by correct
// design, a single global FIFO: it claims the globally oldest QUEUED task
// (or a RUNNING task whose lease expired) via `FOR UPDATE OF t SKIP LOCKED`,
// with no per-test/per-file/per-tenant scoping concept whatsoever — that's
// exactly right for a real worker pool, but it means every test file that
// calls this endpoint is drawing from the *same* queue as every other file
// running at the same time.
//
// An earlier version of this file's fixture helper called claim() in a loop
// and "drained" (auto-completed) whatever non-matching task it happened to
// draw, on the theory that any mismatch must be a straggler left over from
// an earlier test *run*. That theory was wrong: under real concurrent load,
// a mismatch is at least as likely to be another test *file's* own
// currently-in-flight task, created moments earlier by that file's own
// setup — draining it irreversibly completes an execution some other test's
// assertions are still relying on staying QUEUED/RUNNING, which is exactly
// the `204 !== 200` / mismatched-jobId flakiness this suite exhibited
// (reproduced directly: 2 of 3 raw `node --import tsx --test
// test/**/*.test.ts` runs failed this way before the fix below). The
// underlying bug was never "stale rows from a previous run" — it was two
// live, concurrently-running test files racing over one shared queue.
//
// The fix has two parts, and every future test/helper here must pick the
// right one:
//
//   1. FIXTURE-ONLY use (you just need a real `tasks`/`executions` row pair
//      already sitting in whatever post-claim state your test needs, as a
//      starting point for testing something else — verify/accept/reject,
//      event persistence, the OpenHands-compat read surface, realtime
//      delivery, etc.): do NOT call the claim endpoint at all. Use
//      createVerifyingTaskDirect below (create + fund via the real HTTP
//      endpoints, exactly like production, then insert the execution row
//      and set the task's status directly via Kysely, in whatever end
//      state a real claim-then-complete would have left them in) — the
//      same pattern relay.test.ts's createRunningExecution
//      and realtime-gateway.test.ts's createRunningExecutionDirect already
//      established for the identical reason. This removes the test from the
//      shared queue entirely: since every mutation is scoped to `WHERE id =
//      <this test's own taskId>` (itself created moments earlier, owned by
//      this test's own freshly-created org/project), it can never observe,
//      let alone touch, another file's row.
//
//   2. GENUINE claim-endpoint coverage (the claim FSM/response/ordering
//      itself is what's under test): you must keep calling the real
//      endpoint — see claimOwnTaskExecution below. It still loops and
//      drains a non-matching claim, but ONLY when that task is
//      unambiguously a leftover from a *previous* test run — see
//      isTaskStale's own comment for the exact rule and why it can never
//      misclassify a live sibling file's fresh row as stale. A non-matching
//      claim that is NOT stale throws immediately with a diagnostic instead
//      of draining it, rather than silently corrupting another file's test.
//
// Never: delete/truncate a shared table, drain "the whole queue" without a
// staleness check, add a sleep/retry to paper over the ordering, or
// serialize test files against each other. All of those either hide a real
// bug instead of fixing it, or reintroduce whole-suite coupling this
// per-process isolation is specifically trying to avoid.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";
process.env.INTERNAL_API_TOKEN ??= "test-internal-token-not-for-real-use";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

// --- test helpers (mirrors tenant-authorization.test.ts) -----------------

const AUTH_ORIGIN = "http://localhost:3000";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN!;

class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies) this.cookies.set(c.name, c.value);
  }

  // See tenant-authorization.test.ts's CookieJar for why this is needed:
  // /organization/create updates activeOrganizationId in the DB but does not
  // reissue cookies, so the signed 5-minute session_data cache cookie would
  // otherwise keep resolving to the auto-created personal org.
  dropSessionCache(): void {
    this.cookies.delete("better-auth.session_data");
  }

  get header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function signUpVerifiedAndSignIn(email: string, password: string, name: string) {
  const signUpRes = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: AUTH_ORIGIN },
    payload: { email, password, name },
  });
  assert.equal(signUpRes.statusCode, 200, `sign-up failed: ${signUpRes.body}`);

  await sql`update "user" set "emailVerified" = true where "email" = ${email}`.execute(db);

  const signInRes = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: AUTH_ORIGIN },
    payload: { email, password },
  });
  assert.equal(signInRes.statusCode, 200, `sign-in failed: ${signInRes.body}`);

  const jar = new CookieJar();
  jar.absorb(signInRes);
  const userId = (JSON.parse(signInRes.body) as { user: { id: string } }).user.id;
  return { jar, userId };
}

async function createOrgAsOwner(jar: CookieJar, name: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: jar.header, origin: AUTH_ORIGIN },
    payload: { name, slug },
  });
  assert.equal(res.statusCode, 200, `create-org failed: ${res.body}`);
  jar.absorb(res);
  jar.dropSessionCache();
  return (JSON.parse(res.body) as { id: string }).id;
}

async function seedProjectAndAgentProfile(organizationId: string, ownerUserId: string) {
  const project = await db
    .insertInto("projects")
    .values({
      organization_id: organizationId,
      permitted_repository: "github.com/athernull/example",
      owner_user_id: ownerUserId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const agentProfile = await db
    .insertInto("agent_profiles")
    .values({
      organization_id: organizationId,
      model_tiers: JSON.stringify([
        { tier: "fast", model: "anthropic/claude-haiku-4-5-20251001", maxComplexity: 1 },
      ]),
      policy_version: "v1",
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return { projectId: project.id, agentProfileId: agentProfile.id };
}

function createJobPayload(projectId: string, agentProfileId: string) {
  return {
    projectId,
    repositoryRevision: "abc123",
    objective: "Add a health check endpoint",
    acceptanceCriteria: ["Returns 200"],
    agentProfileId,
    budgetMinor: 1000,
    currency: "usd",
  };
}

// Phase 4C: /fund now requires real provenance (an APPROVED estimate + a
// CONSUMED budget authorization created via the canonical
// POST /v1/projects/:projectId/tasks/from-budget-authorization endpoint) —
// legacy POST /v1/jobs can no longer reach QUEUED at all. This fixture
// builds that provenance directly (fixture-only insert of an APPROVED
// estimate + ACTIVE authorization, bypassing the planner LLM exactly like
// budget-authorizations-lifecycle.test.ts's insertPricedApprovedEstimate),
// then creates + funds the task through the real HTTP endpoints — the same
// "real production path from the point provenance exists" shape as before,
// just starting one step later than a real generate-estimate call would.
// requirements/acceptanceCriteria/budgetMinor/currency are still driven by
// createJobPayload so every existing claimBody assertion downstream
// (objective, acceptanceCriteria, budgetMinor) keeps working unchanged.
function fakePlannerOutputForJobPayload(payload: ReturnType<typeof createJobPayload>) {
  return {
    goal: payload.objective,
    scope: { included: ["core feature set"], excluded: [] },
    deliverables: ["A deployed change"],
    implementationPlan: ["Implement the objective"],
    assumptions: [],
    acceptanceCriteria: payload.acceptanceCriteria,
    infrastructureRequirements: [],
    risks: [],
    resourceEstimate: {
      complexity: 0.5,
      estimatedDurationHours: { min: 1, max: 2 },
      inferenceRequirements: { estimatedTier: "standard" },
    },
  };
}

async function createFundedTask(
  owner: { jar: CookieJar; userId: string },
  organizationId: string,
  projectId: string,
  agentProfileId: string,
): Promise<string> {
  const payload = createJobPayload(projectId, agentProfileId);

  const estimate = await db
    .insertInto("project_estimates")
    .values({
      lineage_id: randomUUID(),
      version: 1,
      status: "APPROVED",
      organization_id: organizationId,
      project_id: projectId,
      source_prompt: "fixture prompt",
      planner_output: JSON.stringify(fakePlannerOutputForJobPayload(payload)),
      planner_model: "test-fixture",
      created_by: owner.userId,
      approved_by: owner.userId,
      approved_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const authorization = await db
    .insertInto("project_budget_authorizations")
    .values({
      organization_id: organizationId,
      project_id: projectId,
      estimate_id: estimate.id,
      estimate_lineage_id: estimate.lineage_id,
      estimate_version: estimate.version,
      amount_minor: String(payload.budgetMinor),
      currency: payload.currency,
      source: "USER_SET",
      status: "ACTIVE",
      authorized_by: owner.userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const created = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/tasks/from-budget-authorization`,
    headers: { cookie: owner.jar.header },
    payload: {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: payload.repositoryRevision,
    },
  });
  assert.equal(created.statusCode, 201, `canonical task creation failed: ${created.body}`);
  const taskId = (JSON.parse(created.body) as { id: string }).id;

  const funded = await app.inject({
    method: "POST",
    url: `/v1/jobs/${taskId}/fund`,
    headers: { cookie: owner.jar.header },
  });
  assert.equal(funded.statusCode, 200, `fund failed: ${funded.body}`);
  return taskId;
}

// FIXTURE-ONLY path — see this file's header comment. Deliberately bypasses
// POST /internal/executions/claim (and /complete) and their shared global
// queue entirely: every test using this only needs a real tasks/executions
// row pair already in the state a successful claim-then-complete(success)
// would have left them in — task VERIFYING, execution SUCCEEDED — as a
// starting point for exercising /verify, /accept, /reject, or the events
// endpoints. None of that requires the claim FSM itself. Every mutation
// below is scoped to `taskId`, a row this test itself just created via
// createFundedTask — it can never observe, race with, or touch another
// test file's rows.
async function createVerifyingTaskDirect(
  owner: { jar: CookieJar; userId: string },
  organizationId: string,
  projectId: string,
  agentProfileId: string,
) {
  const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
  const workerId = `worker-${randomUUID()}`;

  const execution = await db
    .insertInto("executions")
    .values({
      task_id: taskId,
      lease_owner: workerId,
      lease_expires_at: sql`now() + make_interval(secs => 300)`,
      status: "SUCCEEDED",
      started_at: new Date(),
      ended_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await db
    .updateTable("tasks")
    .set({ status: "VERIFYING", updated_at: new Date() })
    .where("id", "=", taskId)
    .execute();

  return { taskId, executionId: execution.id, workerId };
}

// How far in the past a QUEUED/RUNNING task's created_at must be before a
// non-matching claim result is treated as safe to drain (complete).
//
// Every claim-touching test in this suite claims (and completes, or hands
// off) its own task within a single synchronous stretch of JS immediately
// after creating it — the only work between "task created" and "task
// claimed" is one more in-process app.inject() call, no external I/O, no
// sleeps. That window is realistically sub-100ms even on a loaded CI box.
// A threshold of 60 seconds is therefore ~600x larger than the only window
// in which a genuinely live sibling test's fresh row could ever be seen —
// no code path in this suite leaves a task it's actively working with
// sitting QUEUED/RUNNING anywhere near that long. So a row older than 60
// seconds can only be a leftover from a *separate* invocation of the suite
// (a previous run that crashed/was killed mid-test) — never a row a
// currently-running sibling process is still relying on.
//
// Deliberately short (not, say, 10 minutes): a shorter threshold is *more*
// conservative here, not less — the only thing a shorter threshold does is
// let genuinely-orphaned rows from an interrupted run get cleaned up
// sooner on the next invocation, which is exactly what's wanted when
// re-running this suite repeatedly during development. It does not narrow
// the safety margin against misclassifying a live sibling's row, since
// that margin is set by the (sub-100ms) claim-immediately-after-create
// pattern above, not by how long a suite run takes.
async function isTaskStale(taskId: string): Promise<boolean> {
  const result = await sql<{ stale: boolean }>`
    select (created_at < now() - interval '60 seconds') as stale
    from tasks where id = ${taskId}
  `.execute(db);
  return result.rows[0]?.stale ?? false;
}

// GENUINE claim-endpoint coverage path — see this file's header comment.
// Unlike createVerifyingTaskDirect above, this calls the real POST
// /internal/executions/claim, because the test using it is asserting
// something about the claim endpoint's own behavior. It still has to
// tolerate drawing another task from the shared global queue (any other
// concurrently-running file's own genuine claim-path test, or a leftover
// from a previous run) — but it only ever drains (completes) a
// non-matching claim when isTaskStale proves it cannot belong to a test
// still in flight in this run. A non-matching, non-stale claim throws
// immediately with full diagnostics rather than silently completing
// another file's in-progress execution.
async function claimOwnTaskExecution(
  taskId: string,
): Promise<{ executionId: string; workerId: string; claimBody: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const workerId = `worker-${randomUUID()}`;
    const claimed = await app.inject({
      method: "POST",
      url: "/internal/executions/claim",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId },
    });
    assert.equal(claimed.statusCode, 200, `claim failed: ${claimed.body}`);
    const body = JSON.parse(claimed.body) as { jobId: string; executionId: string } & Record<string, unknown>;

    if (body.jobId === taskId) {
      return { executionId: body.executionId, workerId, claimBody: body };
    }

    const stale = await isTaskStale(body.jobId);
    if (!stale) {
      throw new Error(
        `claimOwnTaskExecution(${taskId}): claim returned a DIFFERENT, NON-stale task ` +
          `(jobId=${body.jobId}, executionId=${body.executionId}). This looks like a live sibling ` +
          `test file's own in-flight claim-path test, not a leftover from an earlier run — refusing ` +
          `to drain it. If this fires reproducibly, two genuine claim-endpoint tests are contending; ` +
          `see this file's header comment before touching the staleness threshold.`,
      );
    }

    const drained = await app.inject({
      method: "POST",
      url: `/internal/executions/${body.executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "success" },
    });
    assert.equal(drained.statusCode, 200, `drain complete failed: ${drained.body}`);
  }
  throw new Error("claimOwnTaskExecution: claim never returned this test's own task within 50 attempts");
}

async function setUpOwnerWithOrg(suffix: string) {
  const owner = await signUpVerifiedAndSignIn(`owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `Org ${suffix}`, `org-${suffix}`);
  const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
  return { owner, organizationId, projectId, agentProfileId };
}

// --- tests ----------------------------------------------------------------

describe("job lifecycle: estimate, verify, accept, reject", () => {
  test("estimate returns a routing decision without creating a task", async () => {
    const suffix = randomUUID();
    const { owner, agentProfileId } = await setUpOwnerWithOrg(suffix);

    const res = await app.inject({
      method: "POST",
      url: "/v1/jobs/estimate",
      headers: { cookie: owner.jar.header },
      payload: {
        agentProfileId,
        objective: "Add a health check endpoint",
        acceptanceCriteria: ["Returns 200"],
        budgetMinor: 1000,
      },
    });
    assert.equal(res.statusCode, 200, `estimate failed: ${res.body}`);
    const body = JSON.parse(res.body) as { tier: string; model: string; score: number; reason: string };
    assert.equal(body.tier, "fast");
    assert.equal(body.model, "anthropic/claude-haiku-4-5-20251001");
    assert.equal(typeof body.score, "number");
    assert.equal(typeof body.reason, "string");

    const list = await app.inject({ method: "GET", url: "/v1/jobs", headers: { cookie: owner.jar.header } });
    assert.deepEqual(JSON.parse(list.body), [], "estimate must not create a task row");
  });

  test("verify(PASS) then accept reaches SETTLED with one settle payment intent", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId, executionId } = await createVerifyingTaskDirect(owner, organizationId, projectId, agentProfileId);

    const verified = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskId}/verify`,
      headers: { cookie: owner.jar.header },
      payload: { outcome: "PASS", tests: [{ name: "returns 200", passed: true }] },
    });
    assert.equal(verified.statusCode, 200, `verify failed: ${verified.body}`);
    assert.equal((JSON.parse(verified.body) as { status: string }).status, "AWAITING_ACCEPTANCE");

    const runs = await db
      .selectFrom("verification_runs")
      .selectAll()
      .where("task_id", "=", taskId)
      .execute();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.outcome, "PASS");
    assert.equal(runs[0]?.execution_id, executionId);

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskId}/accept`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(accepted.statusCode, 200, `accept failed: ${accepted.body}`);
    assert.equal((JSON.parse(accepted.body) as { status: string }).status, "SETTLED");

    const intents = await db
      .selectFrom("payment_intents")
      .selectAll()
      .where("job_id", "=", taskId)
      .where("idempotency_key", "=", `settle:${taskId}`)
      .execute();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.status, "CONFIRMED");

    const getRes = await app.inject({ method: "GET", url: `/v1/jobs/${taskId}`, headers: { cookie: owner.jar.header } });
    const getBody = JSON.parse(getRes.body) as { verificationRuns: unknown[] };
    assert.equal(getBody.verificationRuns.length, 1);

    // A second accept on an already-SETTLED task must be rejected, not
    // produce a second payment intent.
    const secondAccept = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskId}/accept`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(secondAccept.statusCode, 409, `expected 409 on repeat accept: ${secondAccept.body}`);
    const intentsAfter = await db
      .selectFrom("payment_intents")
      .selectAll()
      .where("job_id", "=", taskId)
      .where("idempotency_key", "=", `settle:${taskId}`)
      .execute();
    assert.equal(intentsAfter.length, 1, "repeat accept must not create a second settle payment intent");
  });

  test("verify(FAIL) moves the task to FAILED, not AWAITING_ACCEPTANCE", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId } = await createVerifyingTaskDirect(owner, organizationId, projectId, agentProfileId);

    const verified = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskId}/verify`,
      headers: { cookie: owner.jar.header },
      payload: { outcome: "FAIL" },
    });
    assert.equal(verified.statusCode, 200, `verify failed: ${verified.body}`);
    assert.equal((JSON.parse(verified.body) as { status: string }).status, "FAILED");
  });

  test("reject moves an awaiting-acceptance task to REFUNDED with one refund payment intent", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId } = await createVerifyingTaskDirect(owner, organizationId, projectId, agentProfileId);

    const verified = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskId}/verify`,
      headers: { cookie: owner.jar.header },
      payload: { outcome: "PASS" },
    });
    assert.equal(verified.statusCode, 200, `verify failed: ${verified.body}`);

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskId}/reject`,
      headers: { cookie: owner.jar.header },
      payload: { reason: "Does not meet the brief" },
    });
    assert.equal(rejected.statusCode, 200, `reject failed: ${rejected.body}`);
    assert.equal((JSON.parse(rejected.body) as { status: string }).status, "REFUNDED");

    const intents = await db
      .selectFrom("payment_intents")
      .selectAll()
      .where("job_id", "=", taskId)
      .where("idempotency_key", "=", `refund:${taskId}`)
      .execute();
    assert.equal(intents.length, 1);
  });
});


test("execution snapshots recover late events, deduplicate replay, and enforce ownership", async () => {
  const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
  const { taskId, executionId } = await createVerifyingTaskDirect(owner, organizationId, projectId, agentProfileId);
  const execution = await db.selectFrom("executions").select("lease_owner")
    .where("id", "=", executionId).executeTakeFirstOrThrow();
  const internalHeaders = { authorization: `Bearer ${INTERNAL_TOKEN}` };
  const eventsUrl = `/v1/jobs/${taskId}/executions/${executionId}/events`;
  const event = (occurredAt: string) => ({
    id: randomUUID(), kind: "MessageEvent", occurredAt, payload: { text: "test event" },
  });
  const newest = event("2026-01-02T00:00:00.000Z");
  const older = event("2026-01-01T00:00:00.000Z");
  const tied = event(newest.occurredAt);
  const postEvents = (events: ReturnType<typeof event>[], workerId = execution.lease_owner) => app.inject({
    method: "POST", url: `/internal/executions/${executionId}/events`,
    headers: internalHeaders, payload: { workerId, events },
  });
  assert.equal((await postEvents([newest], "wrong-worker")).statusCode, 409);
  assert.equal((await postEvents([newest])).statusCode, 204);
  const first = await app.inject({ method: "GET", url: eventsUrl, headers: { cookie: owner.jar.header } });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().map((row: { id: string }) => row.id), [newest.id]);

  assert.equal((await postEvents([older, tied, newest])).statusCode, 204);
  const replay = await app.inject({ method: "GET", url: eventsUrl, headers: { cookie: owner.jar.header } });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json().map((row: { id: string }) => row.id),
    [older.id, ...[newest.id, tied.id].sort()]);
  assert.equal((await app.inject({ method: "GET", url: eventsUrl })).statusCode, 401);

  const other = await setUpOwnerWithOrg(randomUUID());
  assert.equal((await app.inject({ method: "GET", url: eventsUrl,
    headers: { cookie: other.owner.jar.header } })).statusCode, 404);
  const mismatchedTask = await app.inject({ method: "GET",
    url: `/v1/jobs/${randomUUID()}/executions/${executionId}/events`,
    headers: { cookie: owner.jar.header } });
  assert.equal(mismatchedTask.statusCode, 404);
});

// Same staleness-gated draining discipline as claimOwnTaskExecution, but
// accepts any task id from a known set of this test's own tasks — used only
// by a test that legitimately races multiple concurrent claim calls against
// more than one of its own tasks at once (verifying FOR UPDATE SKIP
// LOCKED's no-double-claim guarantee), where "not a match" must mean
// "belongs to neither of my own tasks", not just "doesn't equal one
// specific id".
async function claimAnyOfOwnTasks(
  taskIds: string[],
): Promise<{ taskId: string; executionId: string; workerId: string }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const workerId = `worker-${randomUUID()}`;
    const claimed = await app.inject({
      method: "POST",
      url: "/internal/executions/claim",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId },
    });
    assert.equal(claimed.statusCode, 200, `claim failed: ${claimed.body}`);
    const body = JSON.parse(claimed.body) as { jobId: string; executionId: string };

    if (taskIds.includes(body.jobId)) {
      return { taskId: body.jobId, executionId: body.executionId, workerId };
    }

    const stale = await isTaskStale(body.jobId);
    if (!stale) {
      throw new Error(
        `claimAnyOfOwnTasks([${taskIds.join(",")}]): claim returned a DIFFERENT, NON-stale task ` +
          `(jobId=${body.jobId}) belonging to neither task — looks like a live sibling test file's own ` +
          `in-flight claim-path test, refusing to drain it.`,
      );
    }
    const drained = await app.inject({
      method: "POST",
      url: `/internal/executions/${body.executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "success" },
    });
    assert.equal(drained.statusCode, 200, `drain complete failed: ${drained.body}`);
  }
  throw new Error("claimAnyOfOwnTasks: claim never returned one of these tasks within 50 attempts");
}

describe("claim queue safety: the staleness predicate (isTaskStale) cannot misclassify a live sibling's row", () => {
  test("a task created moments ago is never stale; one backdated past the threshold always is", async () => {
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());

    // Simulates a sibling test file's own in-flight task: created an instant
    // ago, exactly like every real claim-touching test's task is at the
    // moment it calls claim.
    const freshTask = await db
      .insertInto("tasks")
      .values({
        organization_id: organizationId,
        project_id: projectId,
        agent_profile_id: agentProfileId,
        repository_revision: "abc123",
        agent_profile_config_revision: 1,
        agent_policy_version: "v1",
        requirements: "simulated live sibling task",
        acceptance_criteria: JSON.stringify(["n/a"]),
        max_budget_minor: "1000",
        currency: "usd",
        status: "QUEUED",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Simulates a genuine leftover from a previous, separate test-suite
    // invocation: created well beyond any single run's lifetime.
    const staleTask = await db
      .insertInto("tasks")
      .values({
        organization_id: organizationId,
        project_id: projectId,
        agent_profile_id: agentProfileId,
        repository_revision: "abc123",
        agent_profile_config_revision: 1,
        agent_policy_version: "v1",
        requirements: "simulated leftover from an earlier run",
        acceptance_criteria: JSON.stringify(["n/a"]),
        max_budget_minor: "1000",
        currency: "usd",
        status: "QUEUED",
        created_at: sql`now() - interval '20 minutes'`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    assert.equal(
      await isTaskStale(freshTask.id),
      false,
      "a task created moments ago (simulating a live sibling test's own task) must never be classified stale",
    );
    assert.equal(
      await isTaskStale(staleTask.id),
      true,
      "a task created well beyond the threshold must be classified stale, so genuine leftovers still get drained",
    );

    // Clean up directly — these two rows were never claimed, so there is no
    // execution/lease state to unwind, just the QUEUED task rows themselves.
    await db.updateTable("tasks").set({ status: "FAILED" }).where("id", "in", [freshTask.id, staleTask.id]).execute();
  });
});

describe("POST /internal/executions/claim: genuine end-to-end coverage", () => {
  test("claims a freshly queued task and returns a full routing/dispatch decision", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);

    const { executionId, workerId, claimBody } = await claimOwnTaskExecution(taskId);

    assert.equal(claimBody.jobId, taskId);
    assert.equal(claimBody.executionId, executionId);
    assert.equal(claimBody.repositorySnapshot, "github.com/athernull/example@abc123");
    assert.equal(claimBody.objective, "Add a health check endpoint");
    assert.deepEqual(claimBody.acceptanceCriteria, ["Returns 200"]);
    assert.equal(claimBody.agentProfileVersion, 1);
    assert.equal(claimBody.routingTier, "fast");
    assert.equal(claimBody.resolvedModel, "anthropic/claude-haiku-4-5-20251001");
    assert.equal(typeof claimBody.routingScore, "number");
    assert.equal(typeof claimBody.routingReason, "string");
    assert.equal(claimBody.budgetMinor, 1000);
    assert.equal(claimBody.policyVersion, "v1");
    assert.equal(typeof claimBody.deadline, "string");
    assert.ok(new Date(claimBody.deadline as string).getTime() > Date.now(), "deadline must be in the future");

    const taskRow = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(taskRow.status, "RUNNING", "claim must transition the task to RUNNING");

    const completed = await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "success" },
    });
    assert.equal(completed.statusCode, 200, `complete failed: ${completed.body}`);
  });

  test("two concurrently queued tasks are never claimed by the same claim result (FOR UPDATE SKIP LOCKED)", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const b = await setUpOwnerWithOrg(randomUUID());
    const taskA = await createFundedTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    const taskB = await createFundedTask(b.owner, b.organizationId, b.projectId, b.agentProfileId);

    const [resultA, resultB] = await Promise.all([
      claimAnyOfOwnTasks([taskA, taskB]),
      claimAnyOfOwnTasks([taskA, taskB]),
    ]);

    assert.notEqual(
      resultA.taskId,
      resultB.taskId,
      "two concurrent claim calls must never both resolve to the same task",
    );
    assert.deepEqual([resultA.taskId, resultB.taskId].sort(), [taskA, taskB].sort());

    for (const { executionId, workerId } of [resultA, resultB]) {
      const completed = await app.inject({
        method: "POST",
        url: `/internal/executions/${executionId}/complete`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: { workerId, outcome: "success" },
      });
      assert.equal(completed.statusCode, 200, `complete failed: ${completed.body}`);
    }
  });
});
