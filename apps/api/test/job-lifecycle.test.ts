// Integration tests for the task lifecycle beyond funding: estimate, verify,
// accept, reject. Runs against a real Postgres database via Fastify
// inject(), same style as tenant-authorization.test.ts — see that file's
// header comment for how to create/migrate the test database (must include
// 0005_verification_runs_task_fk.sql).
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

// Drives a fresh task through CREATED -> ... -> VERIFYING using the owner's
// session for customer-facing calls and the internal token for the
// worker-facing claim/complete calls — the exact path a real task takes
// before either /verify outcome is decided.
async function createFundedAndRunningTask(
  ownerCookie: string,
  projectId: string,
  agentProfileId: string,
  completeOutcome: "success" | "failure" = "success",
) {
  const created = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: { cookie: ownerCookie },
    payload: createJobPayload(projectId, agentProfileId),
  });
  assert.equal(created.statusCode, 201, `job creation failed: ${created.body}`);
  const taskId = (JSON.parse(created.body) as { id: string }).id;

  const funded = await app.inject({
    method: "POST",
    url: `/v1/jobs/${taskId}/fund`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(funded.statusCode, 200, `fund failed: ${funded.body}`);

  // /internal/executions/claim claims the globally oldest QUEUED task, not a
  // specific one — correct for a real worker pool, but it means a leftover
  // QUEUED task orphaned by an earlier test run (this suite shares a
  // persistent Postgres DB across runs, nothing resets it between them) can
  // get claimed ahead of the task this test just created. Loop, draining any
  // such stragglers with a "success" complete so they stop clogging the
  // queue, until the claim actually returns our own task.
  let executionId: string | null = null;
  for (let attempt = 0; attempt < 50 && executionId === null; attempt++) {
    const workerId = `worker-${randomUUID()}`;
    const claimed = await app.inject({
      method: "POST",
      url: "/internal/executions/claim",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId },
    });
    assert.equal(claimed.statusCode, 200, `claim failed: ${claimed.body}`);
    const claimedBody = JSON.parse(claimed.body) as { jobId: string; executionId: string };

    const completed = await app.inject({
      method: "POST",
      url: `/internal/executions/${claimedBody.executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: claimedBody.jobId === taskId ? completeOutcome : "success" },
    });
    assert.equal(completed.statusCode, 200, `complete failed: ${completed.body}`);

    if (claimedBody.jobId === taskId) {
      executionId = claimedBody.executionId;
    }
  }
  assert.ok(executionId, "claim never returned this test's own task within 50 attempts");

  return { taskId, executionId };
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
    const { owner, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId, executionId } = await createFundedAndRunningTask(owner.jar.header, projectId, agentProfileId);

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
    const { owner, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId } = await createFundedAndRunningTask(owner.jar.header, projectId, agentProfileId);

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
    const { owner, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId } = await createFundedAndRunningTask(owner.jar.header, projectId, agentProfileId);

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
