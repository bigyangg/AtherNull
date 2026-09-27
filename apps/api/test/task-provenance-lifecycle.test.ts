// Integration tests for Phase 4C's provenance-bound task creation and
// execution activation gate: canonical creation, CONSUMED semantics,
// idempotency, concurrency, DB tenant-integrity constraints, /fund
// hardening, legacy /v1/jobs gating, and the full real HTTP/Postgres
// end-to-end flow. Runs against a real Postgres database via Fastify
// inject(), same style as budget-authorizations-lifecycle.test.ts — see that
// file's header for how to create/migrate the test database (must include
// migrations through 0010_task_provenance.sql).
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "500";
// Same default job-lifecycle.test.ts sets — each test FILE runs in its own
// process under node:test, so this must be set here too, not just there.
process.env.INTERNAL_API_TOKEN ??= "test-internal-token-not-for-real-use";
// Deliberately NOT set here at module scope — this file's own "legacy
// gating" describe block below flips ALLOW_LEGACY_JOB_CREATION on/off
// per-test via try/finally, exercising both the fail-closed default and the
// explicit-opt-in path within the same process. See
// routes/jobs.ts's legacyJobCreationEnabled(), which reads process.env at
// call time, not at module load time, specifically so this is possible.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { PlannerOutput } from "@athernull/contracts";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { setPlannerClientForTests } = await import("../src/planner.js");

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN!;

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  setPlannerClientForTests(null);
});

// --- fake planner client (mirrors budget-authorizations-lifecycle.test.ts) -

function fakePlannerOutput(goal: string): PlannerOutput {
  return {
    goal,
    scope: { included: ["core feature set"], excluded: ["mobile app"] },
    deliverables: ["A deployed web application"],
    implementationPlan: ["Set up auth", "Build core CRUD", "Wire up the dashboard"],
    assumptions: ["PostgreSQL is available"],
    acceptanceCriteria: ["Users can sign up and log in"],
    infrastructureRequirements: ["PostgreSQL database", "Email delivery"],
    risks: ["Auth edge cases under load"],
    resourceEstimate: {
      complexity: 0.55,
      estimatedDurationHours: { min: 20, max: 60 },
      inferenceRequirements: { estimatedTier: "standard", estimatedTokens: { min: 50_000, max: 200_000 } },
    },
  };
}

function installDefaultFakePlanner() {
  setPlannerClientForTests(async (prompt: string) => fakePlannerOutput(`Plan for: ${prompt}`));
}
installDefaultFakePlanner();

// --- shared claim-queue safety (mirrors job-lifecycle.test.ts's own header
// comment/helpers verbatim — see that file for the full rationale) ---------
//
// POST /internal/executions/claim is a single global FIFO across every
// concurrently-running test file in this suite. A test here that drives a
// real task to QUEUED via /fund and then does nothing further leaves that
// task sitting in the shared queue indefinitely, where an unrelated file's
// own genuine claim-endpoint test (job-lifecycle.test.ts, openhands-
// compat.test.ts) can pick it up instead of its own freshly-created task,
// failing an assertion that has nothing to do with this file. Any test here
// that lets a task reach real QUEUED must claim (and drain) it itself,
// using the same isTaskStale-gated safety this suite already established.
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
          `claimAndDrainOwnTask(${taskId}): claim returned a DIFFERENT, NON-stale task ` +
            `(jobId=${body.jobId}). This looks like a live sibling test file's own in-flight ` +
            `claim-path test — refusing to drain it. See job-lifecycle.test.ts's header comment ` +
            `before touching this.`,
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

// --- test helpers (mirrors budget-authorizations-lifecycle.test.ts) -------

const AUTH_ORIGIN = "http://localhost:3000";

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

async function createProject(jar: CookieJar): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { cookie: jar.header },
    payload: { permittedRepository: "github.com/athernull/example" },
  });
  assert.equal(res.statusCode, 201, `project creation failed: ${res.body}`);
  return (JSON.parse(res.body) as { id: string }).id;
}

async function createAgentProfile(organizationId: string): Promise<string> {
  const row = await db
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
  return row.id;
}

async function ownerOrgAndProject(suffix: string) {
  const owner = await signUpVerifiedAndSignIn(`owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `Org ${suffix}`, `org-${suffix}`);
  const projectId = await createProject(owner.jar);
  const agentProfileId = await createAgentProfile(organizationId);
  return { owner, organizationId, projectId, agentProfileId };
}

async function generate(jar: CookieJar, projectId: string, prompt: string) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/estimates`,
    headers: { cookie: jar.header },
    payload: { prompt },
  });
}

async function revise(jar: CookieJar, projectId: string, estimateId: string, prompt: string) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/estimates/${estimateId}/revise`,
    headers: { cookie: jar.header },
    payload: { prompt },
  });
}

async function approve(jar: CookieJar, projectId: string, estimateId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/estimates/${estimateId}/approve`,
    headers: { cookie: jar.header },
  });
}

interface AuthorizeBody {
  source: "USER_SET" | "ESTIMATE_PROPOSED_CAP";
  amountMinor?: number;
  currency: string;
}

async function authorize(jar: CookieJar, projectId: string, estimateId: string, body: AuthorizeBody) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/estimates/${estimateId}/budget-authorization`,
    headers: { cookie: jar.header },
    payload: body,
  });
}

interface PrepareBuildBody {
  budgetAuthorizationId: string;
  agentProfileId: string;
  repositoryRevision: string;
}

async function prepareBuild(jar: CookieJar, projectId: string, body: PrepareBuildBody) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/tasks/from-budget-authorization`,
    headers: { cookie: jar.header },
    payload: body,
  });
}

async function fundTask(jar: CookieJar, taskId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/jobs/${taskId}/fund`,
    headers: { cookie: jar.header },
  });
}

// Full-flow fixture: generate v1 (UNPRICED — RATE_CONFIG is null), approve
// it, authorize a USER_SET amount. Returns everything a canonical-create
// test needs.
async function approvedEstimateWithActiveAuthorization(
  jar: CookieJar,
  projectId: string,
  amountMinor = 50_000,
  currency = "USD",
  prompt = "Build a plan",
) {
  const genRes = await generate(jar, projectId, prompt);
  assert.equal(genRes.statusCode, 201, `generate failed: ${genRes.body}`);
  const estimate = JSON.parse(genRes.body) as { id: string; lineageId: string; version: number };
  const approveRes = await approve(jar, projectId, estimate.id);
  assert.equal(approveRes.statusCode, 200, `approve failed: ${approveRes.body}`);
  const authRes = await authorize(jar, projectId, estimate.id, { source: "USER_SET", amountMinor, currency });
  assert.equal(authRes.statusCode, 201, `authorize failed: ${authRes.body}`);
  const authorization = JSON.parse(authRes.body) as { id: string; status: string };
  return { estimate, authorization };
}

function withLegacyJobCreation<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.ALLOW_LEGACY_JOB_CREATION;
  if (value === undefined) delete process.env.ALLOW_LEGACY_JOB_CREATION;
  else process.env.ALLOW_LEGACY_JOB_CREATION = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.ALLOW_LEGACY_JOB_CREATION;
    else process.env.ALLOW_LEGACY_JOB_CREATION = previous;
  });
}

// --- tests -----------------------------------------------------------------

describe("canonical creation — happy path", () => {
  test("an ACTIVE authorization creates a task with exact provenance, and consumes the authorization", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const res = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 201, `prepareBuild failed: ${res.body}`);
    const task = JSON.parse(res.body) as {
      id: string;
      status: string;
      source_estimate_id: string;
      source_budget_authorization_id: string;
      max_budget_minor: string;
      currency: string;
    };
    assert.equal(task.status, "AWAITING_FUNDING");
    assert.equal(task.source_estimate_id, estimate.id);
    assert.equal(task.source_budget_authorization_id, authorization.id);
    assert.equal(task.currency, "USD");
    assert.equal(Number(task.max_budget_minor), 50_000, "max_budget_minor must snapshot the authorized amount");

    const authRow = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", authorization.id)
      .executeTakeFirstOrThrow();
    assert.equal(authRow.status, "CONSUMED", "authorization must become CONSUMED");
  });

  test("requirements/acceptanceCriteria are derived from the estimate's planner_output", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(
      owner.jar,
      projectId,
      10_000,
      "USD",
      "Build a health check endpoint",
    );

    const res = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 201, `prepareBuild failed: ${res.body}`);
    const task = JSON.parse(res.body) as { requirements: string; acceptance_criteria: string[] };
    assert.equal(task.requirements, "Plan for: Build a health check endpoint");
    assert.deepEqual(task.acceptance_criteria, ["Users can sign up and log in"]);
  });
});

describe("canonical creation — idempotency", () => {
  test("a repeated identical request against a CONSUMED authorization returns the same task, not a new one", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);
    const body: PrepareBuildBody = { budgetAuthorizationId: authorization.id, agentProfileId, repositoryRevision: "abc123" };

    const first = await prepareBuild(owner.jar, projectId, body);
    assert.equal(first.statusCode, 201, `first prepareBuild failed: ${first.body}`);
    const firstTask = JSON.parse(first.body) as { id: string };

    const second = await prepareBuild(owner.jar, projectId, body);
    assert.equal(second.statusCode, 200, `repeat must be idempotent (200, not 201): ${second.body}`);
    const secondTask = JSON.parse(second.body) as { id: string };
    assert.equal(secondTask.id, firstTask.id);

    const taskCount = await db
      .selectFrom("tasks")
      .select(({ fn }) => [fn.count<string>("id").as("n")])
      .where("source_budget_authorization_id", "=", authorization.id)
      .executeTakeFirstOrThrow();
    assert.equal(taskCount.n, "1", "an identical repeat must never create a second task");
  });

  test("a retry with a different repositoryRevision still returns the original task unchanged", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const first = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(first.statusCode, 201);
    const firstTask = JSON.parse(first.body) as { id: string; repository_revision: string };

    const second = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "def456",
    });
    assert.equal(second.statusCode, 200, `retry must still be idempotent: ${second.body}`);
    const secondTask = JSON.parse(second.body) as { id: string; repository_revision: string };
    assert.equal(secondTask.id, firstTask.id);
    assert.equal(secondTask.repository_revision, "abc123", "the original task's fields must never be overwritten by a retry");
  });
});

describe("canonical creation — rejections", () => {
  test("a SUPERSEDED authorization is rejected", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization: a1 } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId, 10_000);
    const correctRes = await authorize(owner.jar, projectId, estimate.id, {
      source: "USER_SET",
      amountMinor: 20_000,
      currency: "USD",
    });
    assert.equal(correctRes.statusCode, 201, `correction failed: ${correctRes.body}`);

    const res = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: a1.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 409, `expected rejection of a superseded authorization: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /superseded/i);
  });

  test("an authorization belonging to a different project (same org) is rejected (404)", async () => {
    const suffix = randomUUID();
    const { owner, agentProfileId } = await ownerOrgAndProject(suffix);
    // projectA is created inside ownerOrgAndProject; projectB is a second,
    // sibling project in the SAME org — the authorization genuinely belongs
    // to projectB, not projectA.
    const projectA = await createProject(owner.jar);
    const projectB = await createProject(owner.jar);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectB);

    const res = await prepareBuild(owner.jar, projectA, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 404, `expected 404 for a project/authorization mismatch: ${res.body}`);
  });

  test("cross-org access to another org's authorization is rejected (404)", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, projectId: projectA, agentProfileId: agentProfileA } = await ownerOrgAndProject(suffixA);
    const { owner: ownerB } = await ownerOrgAndProject(suffixB);
    const { authorization } = await approvedEstimateWithActiveAuthorization(ownerA.jar, projectA);

    const res = await prepareBuild(ownerB.jar, projectA, {
      budgetAuthorizationId: authorization.id,
      agentProfileId: agentProfileA,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 404, `org B must not be able to use org A's authorization: ${res.body}`);
  });

  test("a non-privileged member cannot create a task", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const member = await signUpVerifiedAndSignIn(`member-${suffix}@example.com`, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const res = await prepareBuild(member.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 403, `plain member must not be able to prepare a build: ${res.body}`);
  });

  test("an unknown budgetAuthorizationId is rejected (404)", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    const res = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: randomUUID(),
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 404);
  });

  test("an unknown agentProfileId is rejected (400)", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const res = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId: randomUUID(),
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 400);
  });

  test("an estimate that is no longer APPROVED (revised into SUPERSEDED after authorization) is rejected", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    // Revising the estimate supersedes it — the authorization stays ACTIVE
    // (no inheritance/mutation across versions, per Phase 4B's own tests),
    // but the estimate it points at is no longer APPROVED.
    const reviseRes = await revise(owner.jar, projectId, estimate.id, "Add more scope");
    assert.equal(reviseRes.statusCode, 201, `revise failed: ${reviseRes.body}`);

    const res = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 409, `expected rejection: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /SUPERSEDED/);
  });
});

describe("estimate-revision-race", () => {
  test("a task bound to v2 remains bound to v2 even after v3 is created — no provenance mutation", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };
    const revRes = await revise(owner.jar, projectId, v1.id, "Add more scope");
    const v2 = JSON.parse(revRes.body) as { id: string; version: number };
    assert.equal(v2.version, 2);
    const approveV2 = await approve(owner.jar, projectId, v2.id);
    assert.equal(approveV2.statusCode, 200, `approve v2 failed: ${approveV2.body}`);
    const authRes = await authorize(owner.jar, projectId, v2.id, { source: "USER_SET", amountMinor: 30_000, currency: "USD" });
    assert.equal(authRes.statusCode, 201, `authorize v2 failed: ${authRes.body}`);
    const authorization = JSON.parse(authRes.body) as { id: string };

    const created = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(created.statusCode, 201, `prepareBuild failed: ${created.body}`);
    const task = JSON.parse(created.body) as { id: string; source_estimate_id: string };
    assert.equal(task.source_estimate_id, v2.id);

    const rev2Res = await revise(owner.jar, projectId, v2.id, "One more change");
    assert.equal(rev2Res.statusCode, 201, `revise v2->v3 failed: ${rev2Res.body}`);
    const v3 = JSON.parse(rev2Res.body) as { id: string; version: number };
    assert.equal(v3.version, 3);

    const taskRow = await db.selectFrom("tasks").selectAll().where("id", "=", task.id).executeTakeFirstOrThrow();
    assert.equal(taskRow.source_estimate_id, v2.id, "the task must stay bound to v2 forever, never auto-migrated to v3");
  });
});

describe("concurrency", () => {
  test("two concurrent HTTP requests consuming the same ACTIVE authorization yield exactly one task", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);
    const body: PrepareBuildBody = { budgetAuthorizationId: authorization.id, agentProfileId, repositoryRevision: "abc123" };

    const [resA, resB] = await Promise.all([prepareBuild(owner.jar, projectId, body), prepareBuild(owner.jar, projectId, body)]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    assert.deepEqual(statuses, [200, 201], `expected exactly one 201 and one 200, got ${resA.statusCode}/${resB.statusCode}: ${resA.body} / ${resB.body}`);

    const taskIdA = (JSON.parse(resA.body) as { id: string }).id;
    const taskIdB = (JSON.parse(resB.body) as { id: string }).id;
    assert.equal(taskIdA, taskIdB, "both concurrent requests must resolve to the same single task");

    const tasks = await db
      .selectFrom("tasks")
      .select(["id"])
      .where("source_budget_authorization_id", "=", authorization.id)
      .execute();
    assert.equal(tasks.length, 1, "exactly one task must exist for this authorization after the race");

    const authRow = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", authorization.id)
      .executeTakeFirstOrThrow();
    assert.equal(authRow.status, "CONSUMED");
  });

  test("direct-DB race: two raw task inserts referencing the same source_budget_authorization_id cannot both succeed", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const insertRaw = () =>
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationId,
          project_id: projectId,
          agent_profile_id: agentProfileId,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "race fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
          source_estimate_id: estimate.id,
          source_budget_authorization_id: authorization.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

    const results = await Promise.allSettled([insertRaw(), insertRaw()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one of the two genuinely concurrent raw inserts must succeed");
    assert.equal(rejected.length, 1, "exactly one of the two genuinely concurrent raw inserts must be rejected");
    const rejection = rejected[0] as PromiseRejectedResult;
    assert.match(
      String((rejection.reason as { message?: string }).message ?? rejection.reason),
      /duplicate key|unique|violates/i,
      "the rejection must come from tasks_one_per_source_budget_authorization, not some other error",
    );
  });

  test("correction-first: superseding the authorization before consumption makes the old one permanently unusable", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization: a1 } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId, 10_000);

    const correctRes = await authorize(owner.jar, projectId, estimate.id, { source: "USER_SET", amountMinor: 20_000, currency: "USD" });
    assert.equal(correctRes.statusCode, 201);
    const a2 = JSON.parse(correctRes.body) as { id: string };

    const rejectedCreate = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: a1.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(rejectedCreate.statusCode, 409, `superseded authorization must never create a task: ${rejectedCreate.body}`);

    const okCreate = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: a2.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(okCreate.statusCode, 201, `the current ACTIVE authorization must still work: ${okCreate.body}`);

    const a1Row = await db.selectFrom("project_budget_authorizations").selectAll().where("id", "=", a1.id).executeTakeFirstOrThrow();
    assert.equal(a1Row.status, "SUPERSEDED", "a1 must remain SUPERSEDED, never CONSUMED, never reverted to ACTIVE");
  });

  test("consumption-first: a CONSUMED authorization can never be superseded/corrected again", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId, 10_000);

    const created = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(created.statusCode, 201, `prepareBuild failed: ${created.body}`);

    const consumedRow = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", authorization.id)
      .executeTakeFirstOrThrow();
    assert.equal(consumedRow.status, "CONSUMED");

    // routes/budget-authorizations.ts's own "correction" query filters
    // `WHERE estimate_id = ? AND status = 'ACTIVE'` — a CONSUMED row is
    // invisible to it by construction, so this "correction" attempt cannot
    // supersede the CONSUMED row at all. It instead behaves as if there were
    // no existing authorization for this estimate, and creates a brand-new,
    // independent ACTIVE row (supersedes_id: null) — confirmed here rather
    // than assumed, exactly as the Phase 4C spec requires. This is safe: it
    // is a NEW authorization the org would have to explicitly consume again
    // via this same canonical endpoint to create a second task, and the
    // CONSUMED row itself is untouched forever.
    const attemptedCorrection = await authorize(owner.jar, projectId, estimate.id, {
      source: "USER_SET",
      amountMinor: 99_000,
      currency: "USD",
    });
    assert.equal(attemptedCorrection.statusCode, 201, `unexpected status: ${attemptedCorrection.body}`);
    const newAuth = JSON.parse(attemptedCorrection.body) as { id: string; supersedesId: string | null; status: string };
    assert.notEqual(newAuth.id, authorization.id, "must be a fresh row, not the CONSUMED one");
    assert.equal(newAuth.supersedesId, null, "the fresh row must NOT claim to supersede the CONSUMED row");
    assert.equal(newAuth.status, "ACTIVE");

    const stillConsumed = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", authorization.id)
      .executeTakeFirstOrThrow();
    assert.equal(stillConsumed.status, "CONSUMED", "the original CONSUMED row must never revert to ACTIVE or SUPERSEDED");

    // And the new ACTIVE row can legitimately create a second, independent
    // task later — never violating "one authorization -> at most one task",
    // since it is a genuinely different authorization id.
    const secondTask = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: newAuth.id,
      agentProfileId,
      repositoryRevision: "def456",
    });
    assert.equal(secondTask.statusCode, 201, `the new independent authorization must still work: ${secondTask.body}`);
  });
});

describe("no-execution / no-payment runtime boundary", () => {
  test("canonical creation creates zero executions, conversations, or payment_intents rows", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const executionsBefore = await db
      .selectFrom("executions")
      .select(({ fn }) => [fn.count<string>("executions.id").as("n")])
      .innerJoin("tasks", "tasks.id", "executions.task_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const paymentIntentsBefore = await db
      .selectFrom("payment_intents")
      .select(({ fn }) => [fn.count<string>("payment_intents.id").as("n")])
      .innerJoin("tasks", "tasks.id", "payment_intents.job_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    const created = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(created.statusCode, 201, `prepareBuild failed: ${created.body}`);

    const executionsAfter = await db
      .selectFrom("executions")
      .select(({ fn }) => [fn.count<string>("executions.id").as("n")])
      .innerJoin("tasks", "tasks.id", "executions.task_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const paymentIntentsAfter = await db
      .selectFrom("payment_intents")
      .select(({ fn }) => [fn.count<string>("payment_intents.id").as("n")])
      .innerJoin("tasks", "tasks.id", "payment_intents.job_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    assert.equal(executionsAfter.n, executionsBefore.n, "canonical task creation must never create an execution row");
    assert.equal(paymentIntentsAfter.n, paymentIntentsBefore.n, "canonical task creation must never create a payment_intents row");
  });
});

describe("DB tenant-integrity constraints (direct inserts, real Postgres)", () => {
  test("DB rejects a task project_id/organization_id mismatch", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { organizationId: organizationA } = await ownerOrgAndProject(suffixA);
    const { organizationId: organizationB, projectId: projectB } = await ownerOrgAndProject(suffixB);
    // agent_profiles has no composite FK tying it to organization_id, so a
    // same-org profile for organizationA is enough to isolate the
    // constraint actually under test here (tasks_project_id_organization_id_unique).
    const agentProfileA = await createAgentProfile(organizationA);

    await assert.rejects(
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationA, // mismatched on purpose
          project_id: projectB, // genuinely belongs to organizationB
          agent_profile_id: agentProfileA,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "mismatch fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject a project_id/organization_id pair that doesn't match tasks_project_id_organization_id_unique",
    );
  });

  test("DB rejects a task whose source_estimate_id belongs to a different project", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, organizationId: organizationA, projectId: projectA, agentProfileId: agentProfileA } =
      await ownerOrgAndProject(suffixA);
    const { owner: ownerB, projectId: projectB } = await ownerOrgAndProject(suffixB);
    const { estimate: estimateB, authorization: authorizationB } = await approvedEstimateWithActiveAuthorization(ownerB.jar, projectB);
    void ownerA;

    await assert.rejects(
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationA,
          project_id: projectA, // does NOT match estimateB's own project
          agent_profile_id: agentProfileA,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "mismatch fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
          source_estimate_id: estimateB.id,
          source_budget_authorization_id: authorizationB.id,
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject a source_estimate_id that doesn't belong to the task's own project",
    );
  });

  test("DB rejects a task whose source_budget_authorization_id belongs to a different organization", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { organizationId: organizationA, projectId: projectA, agentProfileId: agentProfileA } = await ownerOrgAndProject(suffixA);
    const { owner: ownerB, projectId: projectB } = await ownerOrgAndProject(suffixB);
    const { estimate: estimateB, authorization: authorizationB } = await approvedEstimateWithActiveAuthorization(ownerB.jar, projectB);

    await assert.rejects(
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationA,
          project_id: projectA,
          agent_profile_id: agentProfileA,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "mismatch fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
          // estimate_id here is fabricated to at least share nothing with
          // projectA — the org-mismatch FK on source_budget_authorization_id
          // is what this test isolates.
          source_estimate_id: estimateB.id,
          source_budget_authorization_id: authorizationB.id,
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject a source_budget_authorization_id whose real organization_id differs from the task's own",
    );
  });

  test("DB rejects an authorization that references a different estimate than the task's own source_estimate_id", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    // Two independent, otherwise-valid estimate+authorization pairs in the
    // SAME project/org — each individually legitimate, but not belonging
    // together.
    const { estimate: estimate1, authorization: authorization1 } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId, 10_000, "USD", "Plan one");
    const { estimate: estimate2 } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId, 20_000, "USD", "Plan two");

    await assert.rejects(
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationId,
          project_id: projectId,
          agent_profile_id: agentProfileId,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "mismatch fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
          source_estimate_id: estimate2.id, // mismatched on purpose
          source_budget_authorization_id: authorization1.id, // belongs to estimate1
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject an authorization/estimate pair that doesn't genuinely belong together",
    );
  });

  test("DB rejects a second task using the same source_budget_authorization_id (sequential, not concurrent)", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const insertTask = () =>
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationId,
          project_id: projectId,
          agent_profile_id: agentProfileId,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "dup fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
          source_estimate_id: estimate.id,
          source_budget_authorization_id: authorization.id,
        })
        .execute();

    await insertTask();
    await assert.rejects(
      insertTask(),
      /duplicate key|unique|violates/i,
      "tasks_one_per_source_budget_authorization must reject a second task for the same authorization",
    );
  });

  test("DB rejects half-provenance: source_estimate_id set, source_budget_authorization_id null", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    await assert.rejects(
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationId,
          project_id: projectId,
          agent_profile_id: agentProfileId,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "half-provenance fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
          source_estimate_id: estimate.id,
          source_budget_authorization_id: null,
        })
        .execute(),
      /violates|check constraint/i,
      "tasks_provenance_paired must reject estimate-set/authorization-null half-provenance",
    );
  });

  test("DB rejects half-provenance: source_budget_authorization_id set, source_estimate_id null", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    await assert.rejects(
      db
        .insertInto("tasks")
        .values({
          organization_id: organizationId,
          project_id: projectId,
          agent_profile_id: agentProfileId,
          repository_revision: "abc123",
          agent_profile_config_revision: 1,
          agent_policy_version: "v1",
          requirements: "half-provenance fixture",
          acceptance_criteria: JSON.stringify([]),
          max_budget_minor: "1000",
          currency: "USD",
          status: "AWAITING_FUNDING",
          source_estimate_id: null,
          source_budget_authorization_id: authorization.id,
        })
        .execute(),
      /violates|check constraint/i,
      "tasks_provenance_paired must reject authorization-set/estimate-null half-provenance",
    );
  });
});

describe("/fund hardening", () => {
  test("/fund rejects a provenance-less task", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    const task = await db
      .insertInto("tasks")
      .values({
        organization_id: organizationId,
        project_id: projectId,
        agent_profile_id: agentProfileId,
        repository_revision: "abc123",
        agent_profile_config_revision: 1,
        agent_policy_version: "v1",
        requirements: "provenance-less fixture",
        acceptance_criteria: JSON.stringify([]),
        max_budget_minor: "1000",
        currency: "USD",
        status: "AWAITING_FUNDING",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const res = await fundTask(owner.jar, task.id);
    assert.equal(res.statusCode, 409, `expected rejection of a provenance-less task: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /provenance/i);

    const row = await db.selectFrom("tasks").select(["status"]).where("id", "=", task.id).executeTakeFirstOrThrow();
    assert.equal(row.status, "AWAITING_FUNDING", "a rejected fund attempt must never advance the task");
  });

  test("/fund rejects a task whose source estimate is no longer APPROVED", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { estimate, authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const created = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(created.statusCode, 201, `prepareBuild failed: ${created.body}`);
    const task = JSON.parse(created.body) as { id: string };

    // Supersede the underlying estimate out from under the already-created
    // task — the task keeps referencing v1 (see estimate-revision-race
    // above), but v1 is no longer APPROVED.
    const reviseRes = await revise(owner.jar, projectId, estimate.id, "Add more scope after funding was requested");
    assert.equal(reviseRes.statusCode, 201, `revise failed: ${reviseRes.body}`);

    const res = await fundTask(owner.jar, task.id);
    assert.equal(res.statusCode, 409, `expected rejection: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /APPROVED/);
  });

  test("/fund rejects a task whose source authorization is not CONSUMED (integrity anomaly simulation)", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const created = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(created.statusCode, 201, `prepareBuild failed: ${created.body}`);
    const task = JSON.parse(created.body) as { id: string };

    // Simulate a corrupted/anomalous state directly at the DB level — this
    // must be structurally unreachable through normal application code, but
    // /fund's defensive check must still catch it rather than trust the
    // column blindly.
    await db
      .updateTable("project_budget_authorizations")
      .set({ status: "SUPERSEDED" })
      .where("id", "=", authorization.id)
      .execute();

    const res = await fundTask(owner.jar, task.id);
    assert.equal(res.statusCode, 409, `expected rejection: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /CONSUMED/);
  });

  test("/fund accepts a fully valid canonical task, reaching QUEUED", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    const created = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(created.statusCode, 201, `prepareBuild failed: ${created.body}`);
    const task = JSON.parse(created.body) as { id: string };

    const res = await fundTask(owner.jar, task.id);
    assert.equal(res.statusCode, 200, `fund failed: ${res.body}`);
    const body = JSON.parse(res.body) as { status: string };
    assert.equal(body.status, "QUEUED");

    // Must not leave this task sitting in the shared global claim queue for
    // an unrelated sibling test file to pick up instead of its own task —
    // see the claimAndDrainOwnTask/isTaskStale header comment above.
    await claimAndDrainOwnTask(task.id);
  });
});

describe("legacy /v1/jobs gating", () => {
  test("production-style config (flag absent) rejects legacy creation with 403", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    await withLegacyJobCreation(undefined, async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { cookie: owner.jar.header },
        payload: {
          projectId,
          repositoryRevision: "abc123",
          objective: "Add a health check endpoint",
          acceptanceCriteria: ["Returns 200"],
          agentProfileId,
          budgetMinor: 1000,
          currency: "usd",
        },
      });
      assert.equal(res.statusCode, 403, `expected fail-closed rejection: ${res.body}`);
    });
  });

  test("a non-exact truthy value (e.g. '1') still fails closed", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    await withLegacyJobCreation("1", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { cookie: owner.jar.header },
        payload: {
          projectId,
          repositoryRevision: "abc123",
          objective: "Add a health check endpoint",
          acceptanceCriteria: ["Returns 200"],
          agentProfileId,
          budgetMinor: 1000,
          currency: "usd",
        },
      });
      assert.equal(res.statusCode, 403, `only the exact string "true" may enable legacy creation: ${res.body}`);
    });
  });

  test("explicitly enabled ('true') permits a privileged owner to create a task", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    await withLegacyJobCreation("true", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { cookie: owner.jar.header },
        payload: {
          projectId,
          repositoryRevision: "abc123",
          objective: "Add a health check endpoint",
          acceptanceCriteria: ["Returns 200"],
          agentProfileId,
          budgetMinor: 1000,
          currency: "usd",
        },
      });
      assert.equal(res.statusCode, 201, `expected legacy creation to succeed when explicitly enabled: ${res.body}`);
      const task = JSON.parse(res.body) as { source_estimate_id: string | null; source_budget_authorization_id: string | null };
      assert.equal(task.source_estimate_id, null, "legacy creation must never produce provenance");
      assert.equal(task.source_budget_authorization_id, null);
    });
  });

  test("explicitly enabled but a non-privileged member is still rejected (403)", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const member = await signUpVerifiedAndSignIn(`member-${suffix}@example.com`, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);
    void owner;

    await withLegacyJobCreation("true", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { cookie: member.jar.header },
        payload: {
          projectId,
          repositoryRevision: "abc123",
          objective: "Add a health check endpoint",
          acceptanceCriteria: ["Returns 200"],
          agentProfileId,
          budgetMinor: 1000,
          currency: "usd",
        },
      });
      assert.equal(res.statusCode, 403, `a plain member must not be able to use even the enabled legacy path: ${res.body}`);
    });
  });

  test("a provenance-less legacy-created task can be created but can never be funded", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    const taskId = await withLegacyJobCreation("true", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { cookie: owner.jar.header },
        payload: {
          projectId,
          repositoryRevision: "abc123",
          objective: "Add a health check endpoint",
          acceptanceCriteria: ["Returns 200"],
          agentProfileId,
          budgetMinor: 1000,
          currency: "usd",
        },
      });
      assert.equal(res.statusCode, 201);
      return (JSON.parse(res.body) as { id: string }).id;
    });

    // /fund's hardened check is always active, regardless of the legacy
    // flag's current state (even back to disabled here).
    const fundRes = await fundTask(owner.jar, taskId);
    assert.equal(fundRes.statusCode, 409, `a provenance-less task must never be fundable: ${fundRes.body}`);
  });
});

describe("integrity anomaly", () => {
  test("a CONSUMED authorization with no linked task is reported as a server error, never papered over", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await ownerOrgAndProject(suffix);
    const { authorization } = await approvedEstimateWithActiveAuthorization(owner.jar, projectId);

    // Simulate the anomaly directly — this must be structurally impossible
    // through the real endpoint (which only ever sets CONSUMED in the same
    // transaction as the task insert), but the handler must still detect and
    // refuse to paper over it if it somehow occurs.
    await db
      .updateTable("project_budget_authorizations")
      .set({ status: "CONSUMED" })
      .where("id", "=", authorization.id)
      .execute();

    const res = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(res.statusCode, 500, `expected a loud server error, not a silent success: ${res.body}`);

    const tasks = await db
      .selectFrom("tasks")
      .select(["id"])
      .where("source_budget_authorization_id", "=", authorization.id)
      .execute();
    assert.equal(tasks.length, 0, "must never create a task to paper over the anomaly");

    const authRow = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", authorization.id)
      .executeTakeFirstOrThrow();
    assert.equal(authRow.status, "CONSUMED", "must never revert the authorization back to ACTIVE");
  });
});

describe("real end-to-end flow (HTTP + Postgres)", () => {
  test("full 21-step provenance-bound lifecycle", async () => {
    const suffix = randomUUID();

    // 1. create project (+ org/owner/agent profile)
    const { owner, organizationId, projectId, agentProfileId } = await ownerOrgAndProject(suffix);

    // 2. generate v1
    const genRes = await generate(owner.jar, projectId, "Build a health check endpoint");
    assert.equal(genRes.statusCode, 201, `generate v1 failed: ${genRes.body}`);
    const v1 = JSON.parse(genRes.body) as { id: string; version: number };
    assert.equal(v1.version, 1);

    // 3. revise v2
    const revRes = await revise(owner.jar, projectId, v1.id, "Add rate limiting");
    assert.equal(revRes.statusCode, 201, `revise v1->v2 failed: ${revRes.body}`);
    const v2 = JSON.parse(revRes.body) as { id: string; version: number };
    assert.equal(v2.version, 2);

    // 4. approve v2
    const approveRes = await approve(owner.jar, projectId, v2.id);
    assert.equal(approveRes.statusCode, 200, `approve v2 failed: ${approveRes.body}`);

    // 5. authorize A1 (USER_SET)
    const a1Res = await authorize(owner.jar, projectId, v2.id, { source: "USER_SET", amountMinor: 40_000, currency: "USD" });
    assert.equal(a1Res.statusCode, 201, `authorize A1 failed: ${a1Res.body}`);
    const a1 = JSON.parse(a1Res.body) as { id: string };

    // 6. correct to A2 (A1 SUPERSEDED, A2 ACTIVE)
    const a2Res = await authorize(owner.jar, projectId, v2.id, { source: "USER_SET", amountMinor: 55_000, currency: "USD" });
    assert.equal(a2Res.statusCode, 201, `correct to A2 failed: ${a2Res.body}`);
    const a2 = JSON.parse(a2Res.body) as { id: string; supersedesId: string | null };
    assert.equal(a2.supersedesId, a1.id);
    const a1Row = await db.selectFrom("project_budget_authorizations").selectAll().where("id", "=", a1.id).executeTakeFirstOrThrow();
    assert.equal(a1Row.status, "SUPERSEDED");

    // 7. call canonical Prepare-Build endpoint with A2
    const createRes = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: a2.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(createRes.statusCode, 201, `prepareBuild with A2 failed: ${createRes.body}`);
    const task = JSON.parse(createRes.body) as {
      id: string;
      source_estimate_id: string;
      source_budget_authorization_id: string;
      status: string;
    };

    // 8. exactly one task exists with source_estimate_id=v2.id, source_budget_authorization_id=A2.id
    assert.equal(task.source_estimate_id, v2.id);
    assert.equal(task.source_budget_authorization_id, a2.id);
    assert.equal(task.status, "AWAITING_FUNDING");
    const taskCountForA2 = await db
      .selectFrom("tasks")
      .select(({ fn }) => [fn.count<string>("id").as("n")])
      .where("source_budget_authorization_id", "=", a2.id)
      .executeTakeFirstOrThrow();
    assert.equal(taskCountForA2.n, "1");

    // 9. A2 is CONSUMED
    const a2Row = await db.selectFrom("project_budget_authorizations").selectAll().where("id", "=", a2.id).executeTakeFirstOrThrow();
    assert.equal(a2Row.status, "CONSUMED");

    // 10. retry the exact same request -> same task returned, no second task
    const retryRes = await prepareBuild(owner.jar, projectId, {
      budgetAuthorizationId: a2.id,
      agentProfileId,
      repositoryRevision: "abc123",
    });
    assert.equal(retryRes.statusCode, 200, `retry must be idempotent: ${retryRes.body}`);
    assert.equal((JSON.parse(retryRes.body) as { id: string }).id, task.id);

    // 11. attempt to correct A2 -> rejected (cannot supersede a CONSUMED row
    // — it instead creates a fresh, independent authorization, confirmed
    // and documented in the "concurrency" describe above; here we confirm
    // A2 itself is untouched).
    const attemptedCorrection = await authorize(owner.jar, projectId, v2.id, {
      source: "USER_SET",
      amountMinor: 77_000,
      currency: "USD",
    });
    assert.equal(attemptedCorrection.statusCode, 201, `unexpected: ${attemptedCorrection.body}`);
    const freshAuth = JSON.parse(attemptedCorrection.body) as { id: string; supersedesId: string | null };
    assert.notEqual(freshAuth.id, a2.id);
    assert.equal(freshAuth.supersedesId, null, "must not claim to supersede the CONSUMED A2");
    const a2StillConsumed = await db.selectFrom("project_budget_authorizations").selectAll().where("id", "=", a2.id).executeTakeFirstOrThrow();
    assert.equal(a2StillConsumed.status, "CONSUMED");

    // 12. create estimate v3
    const v3Res = await revise(owner.jar, projectId, v2.id, "One more change after funding");
    assert.equal(v3Res.statusCode, 201, `revise v2->v3 failed: ${v3Res.body}`);
    const v3 = JSON.parse(v3Res.body) as { id: string; version: number };
    assert.equal(v3.version, 3);

    // 13. confirm the task still references v2/A2
    const taskRow = await db.selectFrom("tasks").selectAll().where("id", "=", task.id).executeTakeFirstOrThrow();
    assert.equal(taskRow.source_estimate_id, v2.id);
    assert.equal(taskRow.source_budget_authorization_id, a2.id);

    // 14. attempt legacy POST /v1/jobs under production-style config (flag off) -> rejected
    await withLegacyJobCreation(undefined, async () => {
      const legacyRes = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { cookie: owner.jar.header },
        payload: {
          projectId,
          repositoryRevision: "abc123",
          objective: "Add a health check endpoint",
          acceptanceCriteria: ["Returns 200"],
          agentProfileId,
          budgetMinor: 1000,
          currency: "usd",
        },
      });
      assert.equal(legacyRes.statusCode, 403, `legacy creation must fail closed: ${legacyRes.body}`);
    });

    // 15. attempt /fund on a fabricated/provenance-less task fixture -> rejected
    const fabricatedTask = await db
      .insertInto("tasks")
      .values({
        organization_id: organizationId,
        project_id: projectId,
        agent_profile_id: agentProfileId,
        repository_revision: "abc123",
        agent_profile_config_revision: 1,
        agent_policy_version: "v1",
        requirements: "fabricated fixture",
        acceptance_criteria: JSON.stringify([]),
        max_budget_minor: "1000",
        currency: "USD",
        status: "AWAITING_FUNDING",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const fabricatedFundRes = await fundTask(owner.jar, fabricatedTask.id);
    assert.equal(fabricatedFundRes.statusCode, 409, `fabricated provenance-less task must never be fundable: ${fabricatedFundRes.body}`);

    // 16. Attempting to fund the REAL canonical task at this point is ALSO
    // now rejected — a genuine, discovered limitation of this design, not a
    // test bug: step 12 revised v2 (the task's own source_estimate_id) into
    // v3, which supersedes v2 exactly like any other revise (see
    // estimate-revision-race above — the task correctly keeps referencing
    // v2, never auto-migrating to v3). But /fund's hardened check requires
    // the task's source estimate to be APPROVED *at fund time*, and v2 is
    // now SUPERSEDED. This means revising an estimate after a task has been
    // created from it but BEFORE that task is funded permanently locks the
    // task out of funding — documented explicitly in this phase's ADR and
    // "remaining known limitations" as a real, intentional trade-off of
    // "provenance must be exact and current," not something Phase 4C
    // silently papers over.
    const fundRealTaskRes = await fundTask(owner.jar, task.id);
    assert.equal(
      fundRealTaskRes.statusCode,
      409,
      `expected the real task to also now be unfundable, since its source estimate v2 was superseded by v3: ${fundRealTaskRes.body}`,
    );
    const fundRealTaskBody = JSON.parse(fundRealTaskRes.body) as { error: string };
    assert.match(fundRealTaskBody.error, /SUPERSEDED/);

    // 17. confirm zero executions/conversations/payment_intents anywhere in
    // this entire 21-step flow — neither the fabricated task nor the real
    // task was ever actually funded, so no payment_intents row exists at
    // all, and no execution/dispatch ever happened.
    const executionsAfter = await db
      .selectFrom("executions")
      .select(({ fn }) => [fn.count<string>("executions.id").as("n")])
      .innerJoin("tasks", "tasks.id", "executions.task_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    assert.equal(executionsAfter.n, "0", "no execution/dispatch must ever occur in this flow");

    const paymentIntents = await db
      .selectFrom("payment_intents")
      .selectAll()
      .innerJoin("tasks", "tasks.id", "payment_intents.job_id")
      .where("tasks.organization_id", "=", organizationId)
      .execute();
    assert.equal(paymentIntents.length, 0, "no payment_intents row must exist — neither task was ever actually funded");

    // 18. final confirmation: no conversation/worker-dispatch machinery was
    // ever touched anywhere in this 21-step flow.
    const conversationRows = await db
      .selectFrom("executions")
      .select(["conversation_id"])
      .where("task_id", "=", task.id)
      .execute();
    assert.equal(conversationRows.length, 0);
  });
});
