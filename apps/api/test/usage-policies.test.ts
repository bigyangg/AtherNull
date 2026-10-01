// Phase 4D.2A — Operational Usage Limits + Pause/Resume: integration tests
// against a real Postgres database via Fastify inject(), same style as
// usage-metering.test.ts (Phase 4D.1) and budget-authorizations-lifecycle.
// test.ts (Phase 4B) — see usage-metering.test.ts's own header for the
// shared-claim-queue-race rationale.
//
// SOFT, POST-RESPONSE operational token limit — never monetary. Nothing in
// this file ever asserts on/creates payment_intents, cost_minor, or
// project_budget_authorizations beyond the fixture-only setup already
// established by usage-metering.test.ts's own createFundedTask helper.
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
const { relayRegistry } = await import("../src/realtime/relay-registry.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

// --- test helpers (mirrors usage-metering.test.ts / budget-authorizations-
// lifecycle.test.ts verbatim) -------------------------------------------

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

async function addMemberDirect(organizationId: string, userId: string, role: string) {
  await sql`
    insert into "member" (id, "organizationId", "userId", role, "createdAt")
    values (gen_random_uuid(), ${organizationId}, ${userId}, ${role}, now())
  `.execute(db);
}

async function setActiveOrg(jar: CookieJar, organizationId: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: jar.header, origin: AUTH_ORIGIN },
    payload: { organizationId },
  });
  assert.equal(res.statusCode, 200, `set-active failed: ${res.body}`);
  jar.absorb(res);
  jar.dropSessionCache();
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

// FIXTURE-ONLY (mirrors usage-metering.test.ts's own createFundedTask
// verbatim): real HTTP task-creation, then a direct status correction to
// RUNNING that never touches real QUEUED, closing the shared-claim-queue
// race window completely rather than shrinking it.
async function createRunningTask(
  owner: { jar: CookieJar; userId: string },
  organizationId: string,
  projectId: string,
  agentProfileId: string,
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
      amount_minor: "1000",
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

  await db.updateTable("tasks").set({ status: "RUNNING" }).where("id", "=", taskId).execute();
  return taskId;
}

async function insertExecution(
  taskId: string,
  leaseOwner: string,
  overrides: Partial<{ leaseExpiresAt: Date; status: string }> = {},
): Promise<string> {
  const execution = await db
    .insertInto("executions")
    .values({
      task_id: taskId,
      lease_owner: leaseOwner,
      lease_expires_at: overrides.leaseExpiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
      status: overrides.status ?? "RUNNING",
      started_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return execution.id;
}

async function createPolicy(jar: CookieJar, projectId: string, taskId: string, limitQuantity: number) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/tasks/${taskId}/usage-policy`,
    headers: { cookie: jar.header },
    payload: { limitQuantity },
  });
}

async function extendPolicy(jar: CookieJar, projectId: string, taskId: string, limitQuantity: number) {
  const active = await db.selectFrom("task_usage_policies").select("version").where("task_id", "=", taskId).where("status", "=", "ACTIVE").executeTakeFirstOrThrow();
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/tasks/${taskId}/usage-policy/extend`,
    headers: { cookie: jar.header },
    payload: { limitQuantity, expectedVersion: active.version },
  });
}

// FIXTURE-ONLY direct policy insert — used only by postUsagePause below when
// a test doesn't need to exercise the real create-policy HTTP route itself,
// so task_usage_pauses.policy_id (a real FK) always references a genuine row.
async function insertFixturePolicy(
  organizationId: string,
  projectId: string,
  taskId: string,
  authorizedBy: string,
  limitQuantity: number,
): Promise<string> {
  const row = await db
    .insertInto("task_usage_policies")
    .values({
      organization_id: organizationId,
      project_id: projectId,
      task_id: taskId,
      lineage_id: randomUUID(),
      version: 1,
      metric: "TOTAL_LLM_TOKENS",
      limit_quantity: String(limitQuantity),
      status: "ACTIVE",
      authorized_by: authorizedBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function postUsagePause(
  executionId: string,
  workerId: string,
  overrides: Partial<{
    policyId: string;
    metric: string;
    configuredLimit: number;
    observedUsage: number;
    enforcementAction: string;
    resumeMode: string;
  }> = {},
) {
  return app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/usage-pause`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: {
      workerId,
      // Defaults to a random (non-existent) uuid — fine for tests that
      // expect the call to fail BEFORE the insert (404 unknown execution,
      // 409 wrong lease owner). Every test that expects the insert to
      // actually SUCCEED must pass a real policyId (from createPolicy's
      // response or insertFixturePolicy) — a bogus id would otherwise trip
      // task_usage_pauses' real policy_id foreign key with an opaque 500.
      policyId: overrides.policyId ?? randomUUID(),
      metric: overrides.metric ?? "TOTAL_LLM_TOKENS",
      configuredLimit: overrides.configuredLimit ?? 100,
      observedUsage: overrides.observedUsage ?? 150,
      enforcementAction: overrides.enforcementAction ?? "PAUSE",
      resumeMode: overrides.resumeMode ?? "SAME_EXECUTION",
    },
  });
}

async function resumeUsageLimit(jar: CookieJar, projectId: string, taskId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/tasks/${taskId}/usage-limit/resume`,
    headers: { cookie: jar.header },
  });
}

function fakeRelaySocket() {
  const sent: unknown[] = [];
  const socket = {
    readyState: 1,
    send: (msg: string) => sent.push(JSON.parse(msg)),
    close: () => {},
  };
  return { socket, sent };
}

// --- shared claim-queue safety (mirrors task-provenance-lifecycle.test.ts's
// own header comment/helpers verbatim) — only needed for the one test below
// that exercises the real NEW_ATTEMPT resume path, which genuinely puts a
// task into QUEUED.
async function isTaskStale(taskId: string): Promise<boolean> {
  const result = await sql<{ stale: boolean }>`
    select (created_at < now() - interval '60 seconds') as stale
    from tasks where id = ${taskId}
  `.execute(db);
  return result.rows[0]?.stale ?? false;
}

async function claimAndDrainOwnTask(taskId: string): Promise<void> {
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

    if (body.jobId !== taskId) {
      const stale = await isTaskStale(body.jobId);
      if (!stale) {
        throw new Error(
          `claimAndDrainOwnTask(${taskId}): claim returned a DIFFERENT, NON-stale task (jobId=${body.jobId}).`,
        );
      }
    }

    const drain = await app.inject({
      method: "POST",
      url: `/internal/executions/${body.executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "success" },
    });
    assert.equal(drain.statusCode, 200, `drain complete failed: ${drain.body}`);
    if (body.jobId === taskId) return;
  }
  throw new Error(`claimAndDrainOwnTask(${taskId}): never observed our own task after 50 attempts`);
}

// --- C. Policy ---------------------------------------------------------

describe("Phase 4D.2A — usage policy CRUD", () => {
  test("a privileged owner can create the task's first ACTIVE policy", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);

    const res = await createPolicy(owner.jar, projectId, taskId, 100_000);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { status: string; version: number; limitQuantity: number; metric: string };
    assert.equal(body.status, "ACTIVE");
    assert.equal(body.version, 1);
    assert.equal(body.limitQuantity, 100_000);
    assert.equal(body.metric, "TOTAL_LLM_TOKENS");
  });

  test("a normal (non-privileged) member is rejected with 403", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);

    const memberEmail = `member-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const res = await createPolicy(member.jar, projectId, taskId, 100_000);
    assert.equal(res.statusCode, 403, res.body);
  });

  test("creating a second policy while one is ACTIVE is rejected — use /extend instead", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    assert.equal((await createPolicy(owner.jar, projectId, taskId, 100_000)).statusCode, 201);

    const second = await createPolicy(owner.jar, projectId, taskId, 200_000);
    assert.equal(second.statusCode, 409, second.body);
  });

  test("extension creates a new historical revision, superseding the old ACTIVE row", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const created = await createPolicy(owner.jar, projectId, taskId, 1000);
    const originalId = (created.json() as { id: string }).id;

    const extended = await extendPolicy(owner.jar, projectId, taskId, 2000);
    assert.equal(extended.statusCode, 201, extended.body);
    const extendedBody = extended.json() as { version: number; limitQuantity: number; supersedesId: string; lineageId: string };
    assert.equal(extendedBody.version, 2);
    assert.equal(extendedBody.limitQuantity, 2000);
    assert.equal(extendedBody.supersedesId, originalId);

    const history = await db
      .selectFrom("task_usage_policies")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy("version", "asc")
      .execute();
    assert.equal(history.length, 2);
    assert.equal(history[0]!.status, "SUPERSEDED");
    assert.equal(Number(history[0]!.limit_quantity), 1000, "the historical row's own limit must never be mutated in place");
    assert.equal(history[1]!.status, "ACTIVE");
  });

  test("extending the limit does not reset cumulative usage", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    await createPolicy(owner.jar, projectId, taskId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/usage`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        workerId,
        usageEvents: [
          {
            providerRequestId: randomUUID(),
            provider: "nvidia_nim",
            model: "nvidia/nemotron",
            inputTokens: 400,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            observedAt: new Date().toISOString(),
          },
        ],
      },
    });

    await extendPolicy(owner.jar, projectId, taskId, 5000);

    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/tasks/${taskId}/usage-policy`,
      headers: { cookie: owner.jar.header },
    });
    const body = res.json() as { cumulativeUsage: number };
    assert.equal(body.cumulativeUsage, 500, "extension must never zero out or otherwise touch usage_events");
  });

  test("a decrease is rejected outright", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    await createPolicy(owner.jar, projectId, taskId, 5000);

    const res = await extendPolicy(owner.jar, projectId, taskId, 4999);
    assert.equal(res.statusCode, 409, res.body);

    const equalRes = await extendPolicy(owner.jar, projectId, taskId, 5000);
    assert.equal(equalRes.statusCode, 409, "an equal value is not an increase and must also be rejected");
  });

  test("two concurrent extension attempts never both succeed — one wins, the other gets a deterministic 409", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    await createPolicy(owner.jar, projectId, taskId, 1000);

    const [a, b] = await Promise.all([
      extendPolicy(owner.jar, projectId, taskId, 2000),
      extendPolicy(owner.jar, projectId, taskId, 2000),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [201, 409], `expected exactly one 201 and one 409, got ${JSON.stringify(statuses)}`);

    const activeRows = await db
      .selectFrom("task_usage_policies")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("status", "=", "ACTIVE")
      .execute();
    assert.equal(activeRows.length, 1, "the DB-level partial unique index must guarantee exactly one ACTIVE row survives the race");
  });
});

// --- D. Pause ------------------------------------------------------------

describe("Phase 4D.2A — worker->API usage-limit pause persistence", () => {
  test("a genuine pause transitions the task to PAUSED_USAGE_LIMIT and persists the pause row", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policy = await createPolicy(owner.jar, projectId, taskId, 100);
    const policyId = (policy.json() as { id: string }).id;
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const res = await postUsagePause(executionId, workerId, {
      policyId,
      configuredLimit: 100,
      observedUsage: 137,
      enforcementAction: "PAUSE",
      resumeMode: "SAME_EXECUTION",
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { observedUsage: number; configuredLimit: number };
    assert.equal(body.observedUsage, 137, "the real overshoot value must be stored unclamped");
    assert.equal(body.configuredLimit, 100);

    const task = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "PAUSED_USAGE_LIMIT");

    // PAUSE/SAME_EXECUTION leaves the execution row's own status untouched —
    // it is still, structurally, the live attempt.
    const execution = await db.selectFrom("executions").select(["status"]).where("id", "=", executionId).executeTakeFirstOrThrow();
    assert.equal(execution.status, "RUNNING");
  });

  test("a duplicate/replayed pause call is idempotent — never re-transitions, never duplicates the event", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 100);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const first = await postUsagePause(executionId, workerId, { policyId });
    assert.equal(first.statusCode, 201, first.body);
    const second = await postUsagePause(executionId, workerId, { policyId });
    assert.equal(second.statusCode, 200, second.body);

    const pauseRows = await db.selectFrom("task_usage_pauses").selectAll().where("execution_id", "=", executionId).execute();
    assert.equal(pauseRows.length, 1, "a replayed pause call must never create a second row");

    const events = await db
      .selectFrom("execution_events")
      .selectAll()
      .where("execution_id", "=", executionId)
      .where("kind", "=", "usage_limit_reached")
      .execute();
    assert.equal(events.length, 1, "usage_limit_reached must be persisted exactly once, even under replay");

    const task = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "PAUSED_USAGE_LIMIT", "a replay must never re-transition (or un-transition) the task");
  });

  test("PAUSED_USAGE_LIMIT cannot directly reach VERIFYING — a success /complete is refused", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 100);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsagePause(executionId, workerId, { policyId });

    const complete = await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "success" },
    });
    assert.equal(complete.statusCode, 409, complete.body);

    const task = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "PAUSED_USAGE_LIMIT", "must never have moved to VERIFYING");
  });

  test("404/409 for unknown execution / wrong lease owner, mirroring every other internal route", async () => {
    const notFound = await postUsagePause(randomUUID(), "worker-x");
    assert.equal(notFound.statusCode, 404);

    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const executionId = await insertExecution(taskId, "real-worker");
    const wrongOwner = await postUsagePause(executionId, "wrong-worker");
    assert.equal(wrongOwner.statusCode, 409);
  });
});

// --- E. Failure fallback ---------------------------------------------------

describe("Phase 4D.2A — enforcement failure fallback", () => {
  test("INTERRUPT/NEW_ATTEMPT marks the execution itself as done (non-resumable)", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 100);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const res = await postUsagePause(executionId, workerId, { policyId, enforcementAction: "INTERRUPT", resumeMode: "NEW_ATTEMPT" });
    assert.equal(res.statusCode, 201, res.body);

    const execution = await db.selectFrom("executions").selectAll().where("id", "=", executionId).executeTakeFirstOrThrow();
    assert.equal(execution.status, "PAUSED_USAGE_LIMIT");
    assert.ok(execution.ended_at !== null, "an INTERRUPT/NEW_ATTEMPT execution is done for good and must have ended_at set");
  });

  test("USAGE_ENFORCEMENT_FAILED uses EXISTING failure semantics — no new TaskStatus, just a durable reason", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const res = await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "failure", reason: "USAGE_ENFORCEMENT_FAILED" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const task = res.json() as { status: string };
    assert.equal(task.status, "FAILED", "MAX_EXECUTION_ATTEMPTS is exhausted — must be terminally FAILED, never QUEUED");

    const execution = await db.selectFrom("executions").select(["failure_reason"]).where("id", "=", executionId).executeTakeFirstOrThrow();
    assert.equal(execution.failure_reason, "USAGE_ENFORCEMENT_FAILED");
  });

  test("an ordinary failure never sets failure_reason", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    // Same shared-claim-queue hygiene as the test above.
    await insertExecution(taskId, "dummy-worker-1", { status: "FAILED" });
    await insertExecution(taskId, "dummy-worker-2", { status: "FAILED" });
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);

    const res = await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "failure" },
    });
    assert.equal((res.json() as { status: string }).status, "FAILED");

    const execution = await db.selectFrom("executions").select(["failure_reason"]).where("id", "=", executionId).executeTakeFirstOrThrow();
    assert.equal(execution.failure_reason, null);
  });
});

// --- F. Resume -------------------------------------------------------------

describe("Phase 4D.2A — resume", () => {
  test("same-execution resume: sends a real relay command and transitions PAUSED_USAGE_LIMIT -> RUNNING", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyRes = await createPolicy(owner.jar, projectId, taskId, 1000);
    const policyId = (policyRes.json() as { id: string }).id;
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId, { leaseExpiresAt: new Date(Date.now() + 60_000) });
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 1050 });
    await extendPolicy(owner.jar, projectId, taskId, 2000);

    const { socket, sent } = fakeRelaySocket();
    relayRegistry.register({ executionId, workerId, socket: socket as never, registeredAt: new Date() });
    try {
      const res = await resumeUsageLimit(owner.jar, projectId, taskId);
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as { mode: string; executionId: string };
      assert.equal(body.mode, "SAME_EXECUTION");
      assert.equal(body.executionId, executionId);

      assert.equal(sent.length, 1);
      const envelope = sent[0] as { type: string; payload: { command: { type: string; payload: { limitQuantity: number } } } };
      assert.equal(envelope.type, "gateway.command");
      assert.equal(envelope.payload.command.type, "execution.resume_same_conversation");
      assert.equal(envelope.payload.command.payload.limitQuantity, 2000);

      const task = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
      assert.equal(task.status, "RUNNING");
    } finally {
      relayRegistry.closeAndRemove(executionId, "execution-completed");
    }
  });

  test("a duplicate same-execution resume request is never a duplicate run loop — the second call gets a deterministic 409", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId, { leaseExpiresAt: new Date(Date.now() + 60_000) });
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 500 });

    const { socket, sent } = fakeRelaySocket();
    relayRegistry.register({ executionId, workerId, socket: socket as never, registeredAt: new Date() });
    try {
      const first = await resumeUsageLimit(owner.jar, projectId, taskId);
      assert.equal(first.statusCode, 200, first.body);
      const second = await resumeUsageLimit(owner.jar, projectId, taskId);
      assert.equal(second.statusCode, 409, second.body);
      assert.equal(sent.length, 1, "the relay resume command must never be sent twice for one pause");
    } finally {
      relayRegistry.closeAndRemove(executionId, "execution-completed");
    }
  });

  test("a lost worker (expired lease) cannot claim same-execution resume — automatically steered to new-attempt recovery instead", async () => {
    // Correction 15: "do not pretend same-execution resume is possible" must
    // lead somewhere real, not a bare refusal with no path forward — a dead
    // lease on a SAME_EXECUTION pause automatically falls through to the
    // exact same new-attempt recovery path a resume_mode=NEW_ATTEMPT pause
    // uses.
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    // Lease already expired — the worker process is presumed gone. Note
    // resume_mode is still SAME_EXECUTION here (that's what the worker
    // genuinely recorded at pause time) — it is the LIVE lease check at
    // resume time, not the pause record, that determines unrecoverability.
    const executionId = await insertExecution(taskId, workerId, { leaseExpiresAt: new Date(Date.now() - 60_000) });
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 500, resumeMode: "SAME_EXECUTION" });

    const res = await resumeUsageLimit(owner.jar, projectId, taskId);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { mode: string; executionId: string | null };
    assert.equal(body.mode, "NEW_ATTEMPT");
    assert.equal(body.executionId, null, "must never reuse the dead execution id");

    const task = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "QUEUED");

    await claimAndDrainOwnTask(taskId);
  });

  test("a disconnected relay with a live lease does not queue a duplicate attempt", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId, { leaseExpiresAt: new Date(Date.now() + 60_000) });
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 500 });
    // Deliberately never registered with relayRegistry — simulates a live
    // lease but an unreachable/never-connected relay socket.

    const res = await resumeUsageLimit(owner.jar, projectId, taskId);
    assert.equal(res.statusCode, 409, res.body);
    const task = await db.selectFrom("tasks").select("status").where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "PAUSED_USAGE_LIMIT");
  });

  test("resume is refused when the new limit is not actually greater than cumulative usage", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyRes = await createPolicy(owner.jar, projectId, taskId, 100);
    const policyId = (policyRes.json() as { id: string }).id;
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId, { leaseExpiresAt: new Date(Date.now() + 60_000) });
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 100, observedUsage: 150 });
    // Post the actual usage_events rows so cumulative usage genuinely
    // reflects the same overshoot the pause recorded.
    await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/usage`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        workerId,
        usageEvents: [{
          providerRequestId: randomUUID(), provider: "nvidia_nim", model: "m",
          inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
          observedAt: new Date().toISOString(),
        }],
      },
    });

    // Never extended — limit (100) is still <= cumulative usage (150).
    const res = await resumeUsageLimit(owner.jar, projectId, taskId);
    assert.equal(res.statusCode, 409, res.body);
    assert.match((res.json() as { error: string }).error, /extend/i);
  });

  test("new-attempt resume transitions PAUSED_USAGE_LIMIT -> QUEUED, never reusing the dead execution id", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 500, enforcementAction: "INTERRUPT", resumeMode: "NEW_ATTEMPT" });

    const res = await resumeUsageLimit(owner.jar, projectId, taskId);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { mode: string; executionId: string | null };
    assert.equal(body.mode, "NEW_ATTEMPT");
    assert.equal(body.executionId, null);

    const task = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "QUEUED");

    // Shared-claim-queue hygiene (repeated hazard, this is now a fourth
    // occurrence — see this file's header comment): this task is genuinely
    // QUEUED right now and must be drained via the real claim endpoint
    // before this test returns, or a concurrently-running sibling test
    // file's own claim-endpoint test could pick it up instead of its own.
    await claimAndDrainOwnTask(taskId);
  });

  test("a repeated new-attempt resume request does not create a second attempt", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 500, enforcementAction: "INTERRUPT", resumeMode: "NEW_ATTEMPT" });

    const first = await resumeUsageLimit(owner.jar, projectId, taskId);
    assert.equal(first.statusCode, 200, first.body);
    const second = await resumeUsageLimit(owner.jar, projectId, taskId);
    assert.equal(second.statusCode, 409, second.body);

    await claimAndDrainOwnTask(taskId);

    const executionCount = await db
      .selectFrom("executions")
      .select(({ fn }) => [fn.countAll<string>().as("count")])
      .where("task_id", "=", taskId)
      .executeTakeFirstOrThrow();
    // Exactly 2: the original (interrupted) execution + the one attempt
    // created by claimAndDrainOwnTask's own real claim call — never a third.
    assert.equal(Number(executionCount.count), 2);
  });
});

// --- G. Isolation ------------------------------------------------------

describe("Phase 4D.2A — monetary isolation", () => {
  test("no payment_intents row is ever created by policy/pause/resume flows", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    // Scoped to this test's own count delta, never a bare global row count —
    // job-lifecycle.test.ts's own /fund tests legitimately create real
    // payment_intents rows elsewhere in the shared test database.
    const before = await db
      .selectFrom("payment_intents")
      .select(({ fn }) => [fn.countAll<string>().as("count")])
      .executeTakeFirstOrThrow();

    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 1000);
    await extendPolicy(owner.jar, projectId, taskId, 2000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsagePause(executionId, workerId, { policyId: (await db.selectFrom("task_usage_policies").select(["id"]).where("task_id", "=", taskId).where("status", "=", "ACTIVE").executeTakeFirstOrThrow()).id, configuredLimit: 2000, observedUsage: 2500 });

    const after = await db
      .selectFrom("payment_intents")
      .select(({ fn }) => [fn.countAll<string>().as("count")])
      .executeTakeFirstOrThrow();
    assert.equal(Number(after.count), Number(before.count), "this feature must never create a payment_intents row");
  });

  test("task.max_budget_minor and project_budget_authorizations are never touched by this feature", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const before = await db.selectFrom("tasks").select(["max_budget_minor"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    const authBefore = await db.selectFrom("project_budget_authorizations").selectAll().where("project_id", "=", projectId).execute();

    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 1000);
    await extendPolicy(owner.jar, projectId, taskId, 2000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    const activePolicyId = (
      await db.selectFrom("task_usage_policies").select(["id"]).where("task_id", "=", taskId).where("status", "=", "ACTIVE").executeTakeFirstOrThrow()
    ).id;
    await postUsagePause(executionId, workerId, { policyId: activePolicyId, configuredLimit: 2000, observedUsage: 2500 });

    const after = await db.selectFrom("tasks").select(["max_budget_minor"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(after.max_budget_minor, before.max_budget_minor);
    const authAfter = await db.selectFrom("project_budget_authorizations").selectAll().where("project_id", "=", projectId).execute();
    assert.deepEqual(
      authAfter.map((r) => r.status).sort(),
      authBefore.map((r) => r.status).sort(),
    );
  });

  test("pricing remains UNPRICED on GET /v1/jobs/:id even for a paused, policy-governed task", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);
    const policyId = await insertFixturePolicy(organizationId, projectId, taskId, owner.userId, 100);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 100, observedUsage: 150 });

    const res = await app.inject({ method: "GET", url: `/v1/jobs/${taskId}`, headers: { cookie: owner.jar.header } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      pricing: { status: string; amountMinor: null };
      budgetSpentMinor: number | null;
      usageLimit: { policy: { limitQuantity: number }; cumulativeUsage: number; openPause: { observedUsage: number } | null } | null;
    };
    assert.deepEqual(body.pricing, { status: "UNPRICED", amountMinor: null, currency: null });
    assert.equal(body.budgetSpentMinor, 0, "no usage_events rows were posted in this test — a genuine 0, unaffected by the pause");
    assert.ok(body.usageLimit);
    assert.equal(body.usageLimit!.policy.limitQuantity, 100);
    assert.equal(body.usageLimit!.openPause!.observedUsage, 150);
  });

  test("a task with no ACTIVE usage policy reports usageLimit: null — zero new behavior (correction 19)", async () => {
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(owner, organizationId, projectId, agentProfileId);

    const res = await app.inject({ method: "GET", url: `/v1/jobs/${taskId}`, headers: { cookie: owner.jar.header } });
    const body = res.json() as { usageLimit: unknown };
    assert.equal(body.usageLimit, null);
  });
});

describe("Phase 4D.2A — resume authorization regressions", () => {
  test("another organization's owner cannot resume a task", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const b = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    const policyId = await insertFixturePolicy(a.organizationId, a.projectId, taskId, a.owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 500 });
    const res = await resumeUsageLimit(b.owner.jar, a.projectId, taskId);
    assert.equal(res.statusCode, 404);
  });

  test("concurrent resume commits once and authorizes durable worker polling", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    const policyId = await insertFixturePolicy(a.organizationId, a.projectId, taskId, a.owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    await postUsagePause(executionId, workerId, { policyId, configuredLimit: 1000, observedUsage: 500 });
    const poll = () => app.inject({ method: "POST", url: `/internal/executions/${executionId}/usage-resume`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, payload: { workerId } });
    assert.equal((await poll()).statusCode, 204);
    const { socket, sent } = fakeRelaySocket();
    relayRegistry.register({ executionId, workerId, socket: socket as never, registeredAt: new Date() });
    try {
      const results = await Promise.all([resumeUsageLimit(a.owner.jar, a.projectId, taskId), resumeUsageLimit(a.owner.jar, a.projectId, taskId)]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
      assert.equal(sent.length, 1);
      const authorization = await poll();
      assert.equal(authorization.statusCode, 200);
      assert.equal(authorization.json().policyId, policyId);
    } finally { relayRegistry.closeAndRemove(executionId, "execution-completed"); }
  });

  test("a stale version cannot extend a newer policy", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    await createPolicy(a.owner.jar, a.projectId, taskId, 1000);
    assert.equal((await extendPolicy(a.owner.jar, a.projectId, taskId, 2000)).statusCode, 201);
    const res = await app.inject({ method: "POST", url: `/v1/projects/${a.projectId}/tasks/${taskId}/usage-policy/extend`,
      headers: { cookie: a.owner.jar.header }, payload: { limitQuantity: 3000, expectedVersion: 1 } });
    assert.equal(res.statusCode, 409);
  });

  test("concurrent pause delivery persists exactly one record and event", async () => {
    const a = await setUpOwnerWithOrg(randomUUID());
    const taskId = await createRunningTask(a.owner, a.organizationId, a.projectId, a.agentProfileId);
    const policyId = await insertFixturePolicy(a.organizationId, a.projectId, taskId, a.owner.userId, 1000);
    const workerId = `worker-${randomUUID()}`;
    const executionId = await insertExecution(taskId, workerId);
    const results = await Promise.all([postUsagePause(executionId, workerId, {policyId, configuredLimit: 1000}), postUsagePause(executionId, workerId, {policyId, configuredLimit: 1000})]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 201]);
    const events = await db.selectFrom("execution_events").select("id").where("execution_id", "=", executionId).where("kind", "=", "usage_limit_reached").execute();
    assert.equal(events.length, 1);
  });
});
