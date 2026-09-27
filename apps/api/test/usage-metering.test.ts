// Integration tests for Phase 4D.1 — real usage metering: the worker->API
// ingestion route (POST /internal/executions/:id/usage), DB-enforced dedupe
// and tenant-integrity constraints (0011_usage_metering.sql), and the
// truthful budgetSpentMinor/usage/pricing surfaces on GET /v1/jobs/:id and
// GET /v1/usage/summary. Runs against a real Postgres database via Fastify
// inject(), same style as job-lifecycle.test.ts and
// task-provenance-lifecycle.test.ts — see job-lifecycle.test.ts's header for
// the shared-claim-queue-race rationale (irrelevant here: every test in this
// file uses the FIXTURE-ONLY direct-execution-insert pattern, never the real
// claim endpoint, so nothing here touches the shared global queue at all).
//
// Requires a migrated test database through 0011_usage_metering.sql.
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

// --- test helpers (mirrors job-lifecycle.test.ts) --------------------------

const AUTH_ORIGIN = "http://localhost:3000";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN!;

class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies) this.cookies.set(c.name, c.value);
  }

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

async function setUpOwnerWithOrg(suffix: string) {
  const owner = await signUpVerifiedAndSignIn(`owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `Org ${suffix}`, `org-${suffix}`);
  const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
  return { owner, organizationId, projectId, agentProfileId };
}

function fakePlannerOutputFor(objective: string, acceptanceCriteria: string[]) {
  return {
    goal: objective,
    scope: { included: ["core feature set"], excluded: [] },
    deliverables: ["A deployed change"],
    implementationPlan: ["Implement the objective"],
    assumptions: [],
    acceptanceCriteria,
    infrastructureRequirements: [],
    risks: [],
    resourceEstimate: {
      complexity: 0.5,
      estimatedDurationHours: { min: 1, max: 2 },
      inferenceRequirements: { estimatedTier: "standard" },
    },
  };
}

// FIXTURE-ONLY: real HTTP task-creation + real /fund, exactly like
// job-lifecycle.test.ts's createFundedTask — but this file never calls the
// claim endpoint, so it never touches the shared global claim queue.
async function createFundedTask(
  owner: { jar: CookieJar; userId: string },
  organizationId: string,
  projectId: string,
  agentProfileId: string,
  budgetMinor = 1000,
): Promise<string> {
  const objective = "Add a health check endpoint";
  const acceptanceCriteria = ["Returns 200"];

  const estimate = await db
    .insertInto("project_estimates")
    .values({
      lineage_id: randomUUID(),
      version: 1,
      status: "APPROVED",
      organization_id: organizationId,
      project_id: projectId,
      source_prompt: "fixture prompt",
      planner_output: JSON.stringify(fakePlannerOutputFor(objective, acceptanceCriteria)),
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
      amount_minor: String(budgetMinor),
      currency: "usd",
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
      repositoryRevision: "abc123",
    },
  });
  assert.equal(created.statusCode, 201, `canonical task creation failed: ${created.body}`);
  const taskId = (JSON.parse(created.body) as { id: string }).id;

  // Deliberately NOT calling the real POST /v1/jobs/:id/fund here (unlike
  // this function's name-alike in job-lifecycle.test.ts, which genuinely
  // exercises /fund's own behavior as part of what it's testing). Nothing in
  // THIS file ever asserts on /fund/payment_intents — it only needs a task
  // past AWAITING_FUNDING so an execution can be attached to it. Calling the
  // real /fund would put the task through a real, however brief, QUEUED
  // state that's genuinely visible to the shared global
  // POST /internal/executions/claim queue the instant it happens — even a
  // small window is a real, non-zero-probability collision with a
  // concurrently-running sibling test file's own genuine claim-endpoint
  // test once the FULL suite (many files, real concurrency) is running,
  // confirmed by reproducing 4/6 full-suite runs failing with this window
  // present vs 0/9 clean once it was fully removed. Skipping /fund entirely
  // and going straight to a direct status update — mirroring
  // insertExecution's own "bypass the real endpoint" fixture philosophy
  // below — means this task never touches real QUEUED at all, not even
  // momentarily, closing the race window completely rather than shrinking
  // it.
  await db.updateTable("tasks").set({ status: "RUNNING" }).where("id", "=", taskId).execute();

  return taskId;
}

// FIXTURE-ONLY direct execution insert — deliberately bypasses
// POST /internal/executions/claim entirely (this file needs a real
// execution row leased to a known workerId, not genuine claim-FSM
// coverage), scoped to a taskId this test itself just created, so it can
// never race the shared global claim queue other test files draw from.
// (createFundedTask, above, already forces the task's own status out of
// QUEUED the moment it's funded — this only adds the execution row itself.)
async function insertExecution(taskId: string, leaseOwner: string): Promise<string> {
  const execution = await db
    .insertInto("executions")
    .values({
      task_id: taskId,
      lease_owner: leaseOwner,
      status: "RUNNING",
      started_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return execution.id;
}

function usageEvent(overrides: Partial<{
  providerRequestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  observedAt: string;
}> = {}) {
  return {
    providerRequestId: randomUUID(),
    provider: "nvidia_nim",
    model: "nvidia/nemotron-3-super-120b-a12b",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    reasoningTokens: 5,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function postUsage(executionId: string, workerId: string, usageEvents: unknown[]) {
  return app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/usage`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: { workerId, usageEvents },
  });
}

async function usageRowsFor(executionId: string) {
  return db.selectFrom("usage_events").selectAll().where("execution_id", "=", executionId).execute();
}

// --- tests -------------------------------------------------------------

describe("POST /internal/executions/:id/usage", () => {
  test("404 for an unknown execution id", async () => {
    const res = await postUsage(randomUUID(), "worker-x", [usageEvent()]);
    assert.equal(res.statusCode, 404);
  });

  test("409 when the calling worker does not own the execution's lease", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const executionId = await insertExecution(taskId, "real-worker");

    const res = await postUsage(executionId, "wrong-worker", [usageEvent()]);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(await usageRowsFor(executionId), []);
  });

  test("persists usage rows with task/project/organization attribution derived from the trusted execution chain — never from the request body", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const event = usageEvent();
    const res = await postUsage(executionId, workerId, [event]);
    assert.equal(res.statusCode, 204, `usage post failed: ${res.body}`);

    const rows = await usageRowsFor(executionId);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.task_id, taskId);
    assert.equal(row.project_id, projectId);
    assert.equal(row.organization_id, organizationId);
    assert.equal(row.provider_request_id, event.providerRequestId);
    assert.equal(row.provider, "nvidia_nim");
    assert.equal(row.model, "nvidia/nemotron-3-super-120b-a12b");
    // Never a cost, never even a fabricated zero — see correction 1/9/10.
    assert.equal(row.pricing_status, "UNPRICED");
    assert.equal(row.cost_minor, null);
    assert.equal(row.currency, null);
    assert.equal(row.rate_version, null);
  });

  test("each raw token category is preserved exactly, field by field, and total_tokens is derived as input + output", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const event = usageEvent({
      inputTokens: 4321,
      outputTokens: 987,
      cacheReadTokens: 111,
      cacheWriteTokens: 22,
      reasoningTokens: 3,
    });
    const res = await postUsage(executionId, workerId, [event]);
    assert.equal(res.statusCode, 204, `usage post failed: ${res.body}`);

    const [row] = await usageRowsFor(executionId);
    assert.equal(row!.input_tokens, 4321);
    assert.equal(row!.output_tokens, 987);
    assert.equal(row!.cache_read_tokens, 111);
    assert.equal(row!.cache_write_tokens, 22);
    assert.equal(row!.reasoning_tokens, 3);
    assert.equal(row!.total_tokens, 4321 + 987, "total_tokens must be exactly input + output, never a different formula");
  });

  test("a genuinely-zero category is stored as a real 0, never fabricated as something else", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const event = usageEvent({ cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    const res = await postUsage(executionId, workerId, [event]);
    assert.equal(res.statusCode, 204, `usage post failed: ${res.body}`);

    const [row] = await usageRowsFor(executionId);
    assert.equal(row!.cache_read_tokens, 0);
    assert.equal(row!.cache_write_tokens, 0);
    assert.equal(row!.reasoning_tokens, 0);
  });

  test("DB-level dedupe: an identical repeated POST (same provider_request_id) does not create a duplicate row", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const event = usageEvent();
    assert.equal((await postUsage(executionId, workerId, [event])).statusCode, 204);
    assert.equal((await postUsage(executionId, workerId, [event])).statusCode, 204);

    const rows = await usageRowsFor(executionId);
    assert.equal(rows.length, 1, "the exact same provider_request_id posted twice must never duplicate");
  });

  test("a repeated cumulative poll (worker restart / reconnect resending historical stats) adds only genuinely new rows, never duplicates", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const eventA = usageEvent();
    const eventB = usageEvent();
    const eventC = usageEvent();

    // First "poll": sees A and B.
    assert.equal((await postUsage(executionId, workerId, [eventA, eventB])).statusCode, 204);
    assert.equal((await usageRowsFor(executionId)).length, 2);

    // Simulated worker restart resends the FULL cumulative history it now
    // sees (A, B again) plus one genuinely new entry (C) — correctness must
    // come from the DB constraint, not any worker-side memory (a fresh
    // worker process has none).
    assert.equal((await postUsage(executionId, workerId, [eventA, eventB, eventC])).statusCode, 204);

    const rows = await usageRowsFor(executionId);
    assert.equal(rows.length, 3, "resending A and B again must add zero rows; only C is genuinely new");
    const ids = rows.map((r) => r.provider_request_id).sort();
    assert.deepEqual(ids, [eventA.providerRequestId, eventB.providerRequestId, eventC.providerRequestId].sort());
  });
});

describe("GET /v1/jobs/:id — truthful budgetSpentMinor/usage/pricing", () => {
  test("budgetSpentMinor is a genuine 0 (not null) when no usage_events exist yet", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    await insertExecution(taskId, `worker-${randomUUID()}`); // exists, but no usage posted to it

    const res = await app.inject({ method: "GET", url: `/v1/jobs/${taskId}`, headers: { cookie: owner.jar.header } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { budgetSpentMinor: number | null; usage: Record<string, number>; pricing: { status: string; amountMinor: null } };
    assert.equal(body.budgetSpentMinor, 0, "zero real usage rows is a genuine, honest zero — not the same as 'unpriced'");
    assert.equal(body.usage.totalTokens, 0);
    assert.equal(body.pricing.status, "UNPRICED");
    assert.equal(body.pricing.amountMinor, null);
  });

  test("budgetSpentMinor becomes null, never 0, the moment real unpriced usage exists", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsage(executionId, workerId, [usageEvent({ inputTokens: 200, outputTokens: 100 })]);

    const res = await app.inject({ method: "GET", url: `/v1/jobs/${taskId}`, headers: { cookie: owner.jar.header } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { budgetSpentMinor: number | null; usage: { totalTokens: number }; pricing: { status: string; amountMinor: null; currency: null } };
    assert.equal(body.budgetSpentMinor, null, "must never render a fabricated $0.00 once real unpriced usage exists");
    assert.equal(body.usage.totalTokens, 300);
    assert.deepEqual(body.pricing, { status: "UNPRICED", amountMinor: null, currency: null });
  });

  test("execution attempt 2's usage adds to the task-level aggregate rather than resetting it", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);

    const worker1 = `worker-${randomUUID()}`;
    const execution1 = await insertExecution(taskId, worker1);
    await postUsage(execution1, worker1, [usageEvent({ inputTokens: 100, outputTokens: 50 })]);

    // A second execution attempt under the SAME task (e.g. a retried
    // dispatch) — its own usage must ADD to the task total, not replace it.
    const worker2 = `worker-${randomUUID()}`;
    const execution2 = await insertExecution(taskId, worker2);
    await postUsage(execution2, worker2, [usageEvent({ inputTokens: 40, outputTokens: 10 })]);

    const res = await app.inject({ method: "GET", url: `/v1/jobs/${taskId}`, headers: { cookie: owner.jar.header } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { usage: { inputTokens: number; outputTokens: number; totalTokens: number }; budgetSpentMinor: number | null };
    assert.equal(body.usage.inputTokens, 140);
    assert.equal(body.usage.outputTokens, 60);
    assert.equal(body.usage.totalTokens, 200);
    assert.equal(body.budgetSpentMinor, null);
  });
});

describe("GET /v1/usage/summary — additive usage/pricing fields", () => {
  test("adds usage and pricing fields without breaking the existing envelope", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsage(executionId, workerId, [usageEvent({ inputTokens: 500, outputTokens: 250 })]);

    const res = await app.inject({ method: "GET", url: "/v1/usage/summary", headers: { cookie: owner.jar.header } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      totalSpentMinor: number;
      currency: string;
      dailySpend: unknown[];
      taskCountsByStatus: Record<string, number>;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      pricing: { status: string; amountMinor: null; currency: null };
    };

    // Pre-existing envelope, untouched shape/computation.
    assert.equal(typeof body.totalSpentMinor, "number");
    assert.equal(body.currency, "usd");
    assert.ok(Array.isArray(body.dailySpend));
    assert.ok(typeof body.taskCountsByStatus === "object");

    // New, additive, truthful fields.
    assert.equal(body.usage.inputTokens, 500);
    assert.equal(body.usage.outputTokens, 250);
    assert.equal(body.usage.totalTokens, 750);
    assert.deepEqual(body.pricing, { status: "UNPRICED", amountMinor: null, currency: null });
  });
});

describe("DB tenant-integrity constraints for usage_events composite FKs (direct inserts, real Postgres)", () => {
  function baseUsageRow(overrides: Partial<{
    execution_id: string;
    task_id: string;
    project_id: string;
    organization_id: string;
  }>) {
    return {
      execution_id: overrides.execution_id!,
      task_id: overrides.task_id!,
      project_id: overrides.project_id!,
      organization_id: overrides.organization_id!,
      provider: "nvidia_nim",
      model: "nvidia/nemotron",
      provider_request_id: randomUUID(),
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    };
  }

  test("DB rejects a usage_events row whose task_id doesn't match its execution's real task_id", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const b = await setUpOwnerWithOrg(randomUUID());
    const taskA = await createFundedTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    const taskB = await createFundedTask(b.owner, b.organizationId, b.projectId, b.agentProfileId);
    const executionA = await insertExecution(taskA, "worker-fk-test");

    await assert.rejects(
      db
        .insertInto("usage_events")
        .values(baseUsageRow({
          execution_id: executionA, // really belongs to taskA
          task_id: taskB, // a real task, just not executionA's
          project_id: b.projectId,
          organization_id: b.organizationId,
        }))
        .execute(),
      /foreign key|violates/i,
      "usage_events_execution_task_fkey must reject an execution/task pair that don't genuinely belong together",
    );
  });

  test("DB rejects a usage_events row whose project_id/organization_id doesn't match its task's real project_id/organization_id", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const b = await setUpOwnerWithOrg(randomUUID());
    const taskA = await createFundedTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    await createFundedTask(b.owner, b.organizationId, b.projectId, b.agentProfileId);
    const executionA = await insertExecution(taskA, "worker-fk-test-2");

    await assert.rejects(
      db
        .insertInto("usage_events")
        .values(baseUsageRow({
          execution_id: executionA,
          task_id: taskA, // genuinely executionA's task
          project_id: b.projectId, // real project, but NOT taskA's
          organization_id: b.organizationId, // real org, but NOT taskA's
        }))
        .execute(),
      /foreign key|violates/i,
      "usage_events_task_project_org_fkey must reject a project/org pair that doesn't genuinely belong to the given task",
    );
  });

  test("DB rejects a half-priced row (PRICED status without cost_minor/currency/rate_version all set)", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const taskA = await createFundedTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    const executionA = await insertExecution(taskA, "worker-fk-test-3");

    await assert.rejects(
      db
        .insertInto("usage_events")
        .values({
          ...baseUsageRow({
            execution_id: executionA,
            task_id: taskA,
            project_id: a.projectId,
            organization_id: a.organizationId,
          }),
          pricing_status: "PRICED",
          cost_minor: "100", // currency/rate_version deliberately left null
        })
        .execute(),
      /violates|check constraint/i,
      "usage_events_pricing_consistency must reject PRICED without currency/rate_version",
    );
  });
});
