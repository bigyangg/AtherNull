// Integration tests for tenant authorization (requireOrgSession +
// requirePrivilegedRole) and the funding transaction's concurrency guard.
// Runs against a real Postgres database — every step goes through the real
// Fastify app (via inject(), no real network) and the real Better Auth
// HTTP endpoints, not mocks, so this exercises the same code path
// production traffic does.
//
// Requires a migrated test database, separate from local dev data so these
// tests can't collide with it. Create + migrate it once:
//   createdb -h localhost -p 5433 -U athernull athernull_test
//   psql ... -f packages/database/migrations/0001_better_auth_schema.sql
//   psql ... -f packages/database/migrations/0002_platform_tables.sql
//   psql ... -f packages/database/migrations/0003_tasks_agent_profile.sql
//   psql ... -f packages/database/migrations/0004_task_reproducibility_snapshot.sql
// Override with TEST_DATABASE_URL if your setup differs.
//
// Env vars must be set before any app-dependent module loads (auth.ts reads
// them at import time via top-level betterAuth({...})) — hence the dynamic
// import() below instead of a static one.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
// Unset so email.ts's lazy Resend client stays null and just logs instead of
// trying to send real mail.
delete process.env.RESEND_API_KEY;
// This suite signs up/in more real users in one run than production's
// 5/60s sign-up and sign-in rate limits allow — inject() has no resolvable
// client IP, so every call shares one bucket (see auth.ts). Raised for this
// process only.
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";

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

// --- test helpers -----------------------------------------------------
//
// These drive setup through the real HTTP endpoints wherever Better Auth
// exposes one (sign-up, sign-in, create-org, set-active, remove-member) —
// only membership seeding for the second test user goes straight to SQL,
// since Better Auth's only member-adding endpoint is the full
// invite/accept-invitation flow, which isn't what's under test here.

// Better Auth's CSRF/origin protection rejects state-changing requests with
// no Origin header (or one outside trustedOrigins) — inject() sends none by
// default, so every POST to /api/auth/* needs this explicitly.
const AUTH_ORIGIN = "http://localhost:3000";

// A minimal cookie jar: Better Auth sets *two* cookies that must travel
// together — `session_token` (the real session) and `session_data` (a
// signed 5-minute cache, auth.ts's session.cookieCache). Confirmed by
// direct inspection: `/organization/create` does NOT reissue either cookie
// on success, even though it updates session.activeOrganizationId in the
// database — so a client still holding the pre-create-org session_data
// cache cookie keeps reading the *old* (null) activeOrganizationId from
// that signed cache for up to 5 minutes, never touching the database at
// all. Real production behavior, not a test-only quirk. Call
// dropSessionCache() after any request that can change
// activeOrganizationId (create-org, set-active) to force the next request
// to resolve the session from the database instead of the stale cache.
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

  // Bypass real email verification for tests — requireEmailVerification:
  // true (auth.ts) blocks sign-in otherwise, and clicking a real email link
  // isn't something a test should depend on.
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

async function removeMember(ownerJar: CookieJar, organizationId: string, memberIdOrEmail: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/remove-member",
    headers: { cookie: ownerJar.header, origin: AUTH_ORIGIN },
    payload: { organizationId, memberIdOrEmail },
  });
  assert.equal(res.statusCode, 200, `remove-member failed: ${res.body}`);
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

// --- tests --------------------------------------------------------------

describe("tenant authorization", () => {
  test("a freshly signed-up user has a working org with no explicit org action", async () => {
    const suffix = randomUUID();
    // No createOrgAsOwner/setActiveOrg call here — auth.ts's databaseHooks
    // (user.create.after + session.create.before) are what's under test:
    // sign-up alone must be enough for every /v1/* route to work.
    const user = await signUpVerifiedAndSignIn(
      `fresh-${suffix}@example.com`,
      "correct horse battery",
      "Fresh User",
    );

    const listProjects = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { cookie: user.jar.header },
    });
    assert.equal(listProjects.statusCode, 200, `expected 200: ${listProjects.body}`);
    assert.deepEqual(JSON.parse(listProjects.body), []);

    const listAgentProfiles = await app.inject({
      method: "GET",
      url: "/v1/agent-profiles",
      headers: { cookie: user.jar.header },
    });
    assert.equal(listAgentProfiles.statusCode, 200, `expected 200: ${listAgentProfiles.body}`);
    const profiles = JSON.parse(listAgentProfiles.body) as { policy_version: string }[];
    assert.equal(profiles.length, 1, "the auto-created org must have its seeded default agent profile");
    assert.equal(profiles[0]?.policy_version, "v1");
  });

  test("removed member cannot list/create/fund jobs", async () => {
    const suffix = randomUUID();
    const owner = await signUpVerifiedAndSignIn(`owner-${suffix}@example.com`, "correct horse battery", "Owner");
    const organizationId = await createOrgAsOwner(owner.jar, `Org ${suffix}`, `org-${suffix}`);

    const removedEmail = `removed-${suffix}@example.com`;
    const removedUser = await signUpVerifiedAndSignIn(removedEmail, "correct horse battery", "Removed");
    await addMemberDirect(organizationId, removedUser.userId, "member");
    await setActiveOrg(removedUser.jar, organizationId);

    // Sanity check: membership works before removal.
    const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
    const listBefore = await app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { cookie: removedUser.jar.header },
    });
    assert.equal(listBefore.statusCode, 200, `expected list to work before removal: ${listBefore.body}`);

    await removeMember(owner.jar, organizationId, removedEmail);

    // Same jar, unchanged — only the member row is gone now.
    const listAfter = await app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { cookie: removedUser.jar.header },
    });
    assert.equal(listAfter.statusCode, 403, `removed member must not be able to list jobs: ${listAfter.body}`);

    const createAfter = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { cookie: removedUser.jar.header },
      payload: createJobPayload(projectId, agentProfileId),
    });
    assert.equal(createAfter.statusCode, 403, `removed member must not be able to create jobs: ${createAfter.body}`);

    // Fund path: even if a task already existed, a removed member can't
    // touch it either. Create one as the (still-valid) owner first.
    const created = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { cookie: owner.jar.header },
      payload: createJobPayload(projectId, agentProfileId),
    });
    assert.equal(created.statusCode, 201, `owner job creation failed: ${created.body}`);
    const taskId = (JSON.parse(created.body) as { id: string }).id;

    const fundAfter = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskId}/fund`,
      headers: { cookie: removedUser.jar.header },
    });
    assert.equal(fundAfter.statusCode, 403, `removed member must not be able to fund jobs: ${fundAfter.body}`);
  });

  test("one organization cannot access another's project/task", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();

    const ownerA = await signUpVerifiedAndSignIn(`owner-a-${suffixA}@example.com`, "correct horse battery", "Owner A");
    const orgA = await createOrgAsOwner(ownerA.jar, `Org A ${suffixA}`, `org-a-${suffixA}`);
    const { projectId: projectA, agentProfileId: agentProfileA } = await seedProjectAndAgentProfile(orgA, ownerA.userId);

    const ownerB = await signUpVerifiedAndSignIn(`owner-b-${suffixB}@example.com`, "correct horse battery", "Owner B");
    const orgB = await createOrgAsOwner(ownerB.jar, `Org B ${suffixB}`, `org-b-${suffixB}`);
    void orgB;

    // Org B must not see Org A's project when listing its own.
    const listB = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: ownerB.jar.header } });
    assert.equal(listB.statusCode, 200);
    const projectIdsB = (JSON.parse(listB.body) as { id: string }[]).map((p) => p.id);
    assert.ok(!projectIdsB.includes(projectA), "org B must not see org A's project in its own list");

    // Org B creating a job against Org A's project must be rejected (the
    // project lookup in jobs.ts is already organization-scoped).
    const crossCreate = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { cookie: ownerB.jar.header },
      payload: createJobPayload(projectA, agentProfileA),
    });
    assert.equal(crossCreate.statusCode, 400, `org B must not be able to target org A's project: ${crossCreate.body}`);

    // A task that genuinely belongs to org A must be invisible to org B.
    const createdA = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { cookie: ownerA.jar.header },
      payload: createJobPayload(projectA, agentProfileA),
    });
    assert.equal(createdA.statusCode, 201);
    const taskA = (JSON.parse(createdA.body) as { id: string }).id;

    const crossGet = await app.inject({
      method: "GET",
      url: `/v1/jobs/${taskA}`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(crossGet.statusCode, 404, `org B must not be able to read org A's task: ${crossGet.body}`);

    const crossFund = await app.inject({
      method: "POST",
      url: `/v1/jobs/${taskA}/fund`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(crossFund.statusCode, 404, `org B must not be able to fund org A's task: ${crossFund.body}`);
  });

  test("concurrent funding yields one QUEUED task and one payment intent", async () => {
    const suffix = randomUUID();
    const owner = await signUpVerifiedAndSignIn(`owner-${suffix}@example.com`, "correct horse battery", "Owner");
    const organizationId = await createOrgAsOwner(owner.jar, `Org ${suffix}`, `org-${suffix}`);
    const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);

    const created = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { cookie: owner.jar.header },
      payload: createJobPayload(projectId, agentProfileId),
    });
    assert.equal(created.statusCode, 201, `job creation failed: ${created.body}`);
    const taskId = (JSON.parse(created.body) as { id: string }).id;

    // Two genuinely concurrent requests against the same app instance —
    // exercises the transaction + optimistic-lock guard in jobs.ts, not
    // just two sequential calls.
    const cookie = owner.jar.header;
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/jobs/${taskId}/fund`, headers: { cookie } }),
      app.inject({ method: "POST", url: `/v1/jobs/${taskId}/fund`, headers: { cookie } }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(
      statuses,
      [200, 409],
      `expected exactly one 200 and one 409, got ${first.statusCode} and ${second.statusCode}: ` +
        `${first.body} / ${second.body}`,
    );

    const finalTask = await db
      .selectFrom("tasks")
      .select(["status", "version"])
      .where("id", "=", taskId)
      .executeTakeFirstOrThrow();
    assert.equal(finalTask.status, "QUEUED");
    assert.equal(finalTask.version, 2, "version must have incremented exactly once");

    const paymentIntents = await db
      .selectFrom("payment_intents")
      .selectAll()
      .where("job_id", "=", taskId)
      .execute();
    assert.equal(paymentIntents.length, 1, "exactly one payment intent must exist for this job");
    assert.equal(paymentIntents[0]?.status, "CONFIRMED");
  });
});
