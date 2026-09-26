// Integration tests for Phase 4A's project-estimate lineage: generate,
// list, get, revise, approve. Runs against a real Postgres database via
// Fastify inject(), same style as tenant-authorization.test.ts/
// job-lifecycle.test.ts — see tenant-authorization.test.ts's header for how
// to create/migrate the test database (must include migrations through
// 0008_project_estimates.sql).
//
// The planner LLM call (apps/api/src/planner.ts) is swapped for a
// deterministic fake via setPlannerClientForTests() for the whole file —
// this suite tests apps/api's own logic (persistence, tenant scoping, the
// revise/approve state machine, pricing wiring), not a real Anthropic call.
// generatePlannerOutput()'s schema-validation step still runs for real
// against whatever the fake client returns, so a malformed-output test
// below still exercises the real rejection path.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { PlannerOutput } from "@athernull/contracts";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { setPlannerClientForTests } = await import("../src/planner.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  setPlannerClientForTests(null);
});

// --- fake planner client -------------------------------------------------

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

// Default fake client: deterministic, echoes the prompt into the goal so
// tests can tell v1 and v2's planner_output apart. Individual tests may
// call setPlannerClientForTests again to install a scripted/delayed/broken
// variant, then restore this default in a `finally`.
function installDefaultFakePlanner() {
  setPlannerClientForTests(async (prompt: string) => fakePlannerOutput(`Plan for: ${prompt}`));
}
installDefaultFakePlanner();

// --- test helpers (mirrors tenant-authorization.test.ts) -----------------

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

// A full owner+org+project fixture, one call.
async function ownerOrgAndProject(suffix: string) {
  const owner = await signUpVerifiedAndSignIn(`owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `Org ${suffix}`, `org-${suffix}`);
  const projectId = await createProject(owner.jar);
  return { owner, organizationId, projectId };
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

// --- tests ----------------------------------------------------------------

describe("estimate generation", () => {
  test("generating v1 persists a READY_FOR_REVIEW estimate with the planner's validated output", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const res = await generate(owner.jar, projectId, "Build a small SaaS issue tracker");
    assert.equal(res.statusCode, 201, `generate failed: ${res.body}`);
    const body = JSON.parse(res.body) as {
      id: string;
      lineageId: string;
      version: number;
      status: string;
      plannerOutput: PlannerOutput;
      pricingStatus: string;
    };
    assert.equal(body.version, 1);
    assert.equal(body.status, "READY_FOR_REVIEW");
    assert.equal(body.plannerOutput.goal, "Plan for: Build a small SaaS issue tracker");
    // No real rate config exists today — pricing must be honestly UNPRICED,
    // never a fabricated dollar figure (apps/api/src/pricing/rates.ts).
    assert.equal(body.pricingStatus, "UNPRICED");
  });

  test("any authorized org member (not just privileged roles) can generate an estimate", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);

    const memberEmail = `member-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const res = await generate(member.jar, projectId, "Build a landing page");
    assert.equal(res.statusCode, 201, `plain member must be able to generate: ${res.body}`);
    void owner;
  });

  test("malformed planner output is rejected outright and never persisted", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const before = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/estimates`,
      headers: { cookie: owner.jar.header },
    });
    const beforeCount = (JSON.parse(before.body) as unknown[]).length;

    setPlannerClientForTests(async () => ({ goal: "missing everything else" }));
    try {
      const res = await generate(owner.jar, projectId, "Build something");
      assert.equal(res.statusCode, 502, `expected malformed output to be rejected: ${res.body}`);
    } finally {
      installDefaultFakePlanner();
    }

    const after = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/estimates`,
      headers: { cookie: owner.jar.header },
    });
    const afterCount = (JSON.parse(after.body) as unknown[]).length;
    assert.equal(afterCount, beforeCount, "a rejected planner output must not create any row");
  });

  test("an injected price field in planner output never reaches the persisted row", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    setPlannerClientForTests(async () => ({
      ...fakePlannerOutput("Plan with injected price"),
      price: 999999,
      estimatedCostMinor: 42,
    }));
    try {
      const res = await generate(owner.jar, projectId, "Build something");
      assert.equal(res.statusCode, 201, `generate failed: ${res.body}`);
      const body = JSON.parse(res.body) as { plannerOutput: Record<string, unknown> };
      assert.equal(body.plannerOutput.price, undefined);
      assert.equal(body.plannerOutput.estimatedCostMinor, undefined);
    } finally {
      installDefaultFakePlanner();
    }
  });
});

describe("estimate listing and reading", () => {
  test("v1 remains readable after a revision creates v2 (revision creates a new row, never overwrites)", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build an issue tracker");
    const v1 = JSON.parse(genRes.body) as { id: string; lineageId: string; version: number };

    const revRes = await revise(owner.jar, projectId, v1.id, "Also add email notifications");
    assert.equal(revRes.statusCode, 201, `revise failed: ${revRes.body}`);
    const v2 = JSON.parse(revRes.body) as { id: string; lineageId: string; version: number; status: string };
    assert.equal(v2.version, 2);
    assert.equal(v2.lineageId, v1.lineageId, "revision must stay in the same lineage");
    assert.equal(v2.status, "READY_FOR_REVIEW");
    assert.notEqual(v2.id, v1.id, "revision must create a new row, not overwrite v1's id");

    const getV1 = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/estimates/${v1.id}`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(getV1.statusCode, 200, `v1 must remain readable: ${getV1.body}`);
    const v1Read = JSON.parse(getV1.body) as { status: string; version: number };
    assert.equal(v1Read.version, 1);
    assert.equal(v1Read.status, "SUPERSEDED", "the old head must be superseded by the revision");

    const list = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/estimates`,
      headers: { cookie: owner.jar.header },
    });
    const rows = JSON.parse(list.body) as { id: string; version: number }[];
    assert.equal(rows.length, 2, "both versions must be listed");
  });

  test("cross-org read/revise/approve are all denied", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, projectId: projectA } = await ownerOrgAndProject(suffixA);
    const { owner: ownerB } = await ownerOrgAndProject(suffixB);

    const genRes = await generate(ownerA.jar, projectA, "Org A's private project plan");
    const estimateA = JSON.parse(genRes.body) as { id: string };

    const crossList = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectA}/estimates`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(crossList.statusCode, 404, `org B must not list org A's estimates: ${crossList.body}`);

    const crossGet = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectA}/estimates/${estimateA.id}`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(crossGet.statusCode, 404, `org B must not read org A's estimate: ${crossGet.body}`);

    const crossRevise = await revise(ownerB.jar, projectA, estimateA.id, "Hijack this plan");
    assert.equal(crossRevise.statusCode, 404, `org B must not revise org A's estimate: ${crossRevise.body}`);

    const crossApprove = await approve(ownerB.jar, projectA, estimateA.id);
    assert.equal(crossApprove.statusCode, 404, `org B must not approve org A's estimate: ${crossApprove.body}`);
  });
});

describe("approval", () => {
  test("approval is privileged-only; a plain member is denied", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);

    const memberEmail = `member-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };

    const res = await approve(member.jar, projectId, v1.id);
    assert.equal(res.statusCode, 403, `plain member must not be able to approve: ${res.body}`);
  });

  test("approval records the exact actor and timestamp", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };

    const before = new Date();
    const res = await approve(owner.jar, projectId, v1.id);
    assert.equal(res.statusCode, 200, `approve failed: ${res.body}`);
    const body = JSON.parse(res.body) as {
      status: string;
      approvedBy: string | null;
      approvedAt: string | null;
    };
    assert.equal(body.status, "APPROVED");
    assert.equal(body.approvedBy, owner.userId);
    assert.ok(body.approvedAt, "approvedAt must be set");
    assert.ok(new Date(body.approvedAt!).getTime() >= before.getTime() - 1000);
  });

  test("approval is idempotent: approving an already-approved estimate returns the same success, no duplicate transition", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };

    const first = await approve(owner.jar, projectId, v1.id);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body) as { approvedBy: string; approvedAt: string };

    const second = await approve(owner.jar, projectId, v1.id);
    assert.equal(second.statusCode, 200, `double-approve must succeed idempotently: ${second.body}`);
    const secondBody = JSON.parse(second.body) as { approvedBy: string; approvedAt: string; status: string };
    assert.equal(secondBody.status, "APPROVED");
    assert.equal(secondBody.approvedBy, firstBody.approvedBy);
    assert.equal(secondBody.approvedAt, firstBody.approvedAt, "re-approving must not change the recorded approval time");
  });

  test("a superseded estimate can never be approved — 409 naming the current head version", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };
    const revRes = await revise(owner.jar, projectId, v1.id, "Revise it");
    const v2 = JSON.parse(revRes.body) as { version: number };
    assert.equal(v2.version, 2);

    const res = await approve(owner.jar, projectId, v1.id);
    assert.equal(res.statusCode, 409, `approving a superseded estimate must 409: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /version 2/);
  });

  test("a DRAFT estimate cannot be approved — 409 'not ready for review'", async () => {
    // No current endpoint produces a DRAFT row (generate/revise both create
    // READY_FOR_REVIEW directly — see routes/estimates.ts's comment on why).
    // DRAFT is exercised here by inserting one directly, the same
    // fixture-not-through-the-API pattern job-lifecycle.test.ts uses for
    // states its own endpoints don't produce.
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);

    const lineageId = randomUUID();
    const draft = await db
      .insertInto("project_estimates")
      .values({
        lineage_id: lineageId,
        version: 1,
        status: "DRAFT",
        organization_id: organizationId,
        project_id: projectId,
        source_prompt: "draft prompt",
        planner_output: JSON.stringify(fakePlannerOutput("draft goal")),
        planner_model: "test-fixture",
        created_by: owner.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const res = await approve(owner.jar, projectId, draft.id);
    assert.equal(res.statusCode, 409, `approving a DRAFT estimate must 409: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /not ready for review/i);
  });

  test("approving, revising, or generating an estimate never touches tasks or executions", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);

    const tasksBefore = await db
      .selectFrom("tasks")
      .select(({ fn }) => [fn.count<string>("id").as("n")])
      .where("organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const executionsBefore = await db
      .selectFrom("executions")
      .select(({ fn }) => [fn.count<string>("executions.id").as("n")])
      .innerJoin("tasks", "tasks.id", "executions.task_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };
    await revise(owner.jar, projectId, v1.id, "Revise it");
    const list = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/estimates`,
      headers: { cookie: owner.jar.header },
    });
    const rows = JSON.parse(list.body) as { id: string; version: number }[];
    const head = rows.find((r) => r.version === 2)!;
    await approve(owner.jar, projectId, head.id);

    const tasksAfter = await db
      .selectFrom("tasks")
      .select(({ fn }) => [fn.count<string>("id").as("n")])
      .where("organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const executionsAfter = await db
      .selectFrom("executions")
      .select(({ fn }) => [fn.count<string>("executions.id").as("n")])
      .innerJoin("tasks", "tasks.id", "executions.task_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    assert.equal(tasksAfter.n, tasksBefore.n, "no task row must be created by estimate generation/revision/approval");
    assert.equal(
      executionsAfter.n,
      executionsBefore.n,
      "no execution row must be created by estimate generation/revision/approval",
    );
  });
});

describe("revise/approve race resolution", () => {
  test("approve-then-revise: revise still succeeds on an APPROVED head and preserves its approval metadata", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };

    const approveRes = await approve(owner.jar, projectId, v1.id);
    assert.equal(approveRes.statusCode, 200, `approve failed: ${approveRes.body}`);
    const approved = JSON.parse(approveRes.body) as { approvedBy: string; approvedAt: string };

    const reviseRes = await revise(owner.jar, projectId, v1.id, "Add a new requirement");
    assert.equal(reviseRes.statusCode, 201, `revise on an approved head must still succeed: ${reviseRes.body}`);
    const v2 = JSON.parse(reviseRes.body) as { version: number; status: string };
    assert.equal(v2.version, 2);
    assert.equal(v2.status, "READY_FOR_REVIEW");

    const v1Reread = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/estimates/${v1.id}`,
      headers: { cookie: owner.jar.header },
    });
    const v1Body = JSON.parse(v1Reread.body) as {
      status: string;
      approvedBy: string | null;
      approvedAt: string | null;
    };
    assert.equal(v1Body.status, "SUPERSEDED", "the approved v1 must be superseded once v2 exists");
    assert.equal(
      v1Body.approvedBy,
      approved.approvedBy,
      "supersession must NOT erase historical approval metadata",
    );
    assert.equal(v1Body.approvedAt, approved.approvedAt);
  });

  test("revise-then-approve: approving the now-stale version 409s naming the new head", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };

    const reviseRes = await revise(owner.jar, projectId, v1.id, "Add a new requirement");
    assert.equal(reviseRes.statusCode, 201, `revise failed: ${reviseRes.body}`);
    const v2 = JSON.parse(reviseRes.body) as { id: string; version: number };

    const approveStale = await approve(owner.jar, projectId, v1.id);
    assert.equal(approveStale.statusCode, 409, `approving the stale v1 must 409: ${approveStale.body}`);

    const approveHead = await approve(owner.jar, projectId, v2.id);
    assert.equal(approveHead.statusCode, 200, `approving the actual head must succeed: ${approveHead.body}`);
  });

  test("a genuine concurrent approve+revise on the same estimate resolves to one consistent final state", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };

    const [approveRes, reviseRes] = await Promise.all([
      approve(owner.jar, projectId, v1.id),
      revise(owner.jar, projectId, v1.id, "Concurrent revision"),
    ]);

    // Revise must always succeed in this race: nothing about a concurrent
    // approve blocks superseding the row, whichever order the two
    // transactions actually interleaved in.
    assert.equal(reviseRes.statusCode, 201, `revise must succeed regardless of race order: ${reviseRes.body}`);
    assert.ok(
      [200, 409].includes(approveRes.statusCode),
      `approve must resolve to either 200 (won the race) or 409 (lost it): got ${approveRes.statusCode}`,
    );

    const v1Final = await db
      .selectFrom("project_estimates")
      .selectAll()
      .where("id", "=", v1.id)
      .executeTakeFirstOrThrow();
    assert.equal(v1Final.status, "SUPERSEDED", "v1 must end up superseded either way");

    if (approveRes.statusCode === 200) {
      assert.ok(v1Final.approved_by, "if approve won the race, v1's approval metadata must be recorded");
    } else {
      assert.equal(v1Final.approved_by, null, "if approve lost the race, v1 must never have been approved");
    }

    const lineageRows = await db
      .selectFrom("project_estimates")
      .select(["version", "status"])
      .where("lineage_id", "=", v1Final.lineage_id)
      .execute();
    assert.equal(lineageRows.length, 2, "exactly one revision must have been created, not a duplicate");
    const approvedCount = lineageRows.filter((r) => r.status === "APPROVED").length;
    assert.ok(approvedCount <= 1, "at most one row in the lineage may be currently APPROVED");
  });
});

describe("tenant-integrity DB constraints", () => {
  test("the composite FK rejects a project_id/organization_id pair that doesn't actually match", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, projectId: projectA } = await ownerOrgAndProject(suffixA);
    const { organizationId: organizationB } = await ownerOrgAndProject(suffixB);

    await assert.rejects(
      db
        .insertInto("project_estimates")
        .values({
          lineage_id: randomUUID(),
          version: 1,
          status: "DRAFT",
          // Mismatched on purpose: projectA genuinely belongs to
          // organizationA (from ownerOrgAndProject), not organizationB.
          organization_id: organizationB,
          project_id: projectA,
          source_prompt: "should never be persisted",
          planner_output: JSON.stringify(fakePlannerOutput("x")),
          planner_model: "test-fixture",
          created_by: ownerA.userId,
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject a project_id/organization_id pair that doesn't match projects_id_organization_id_unique",
    );
  });

  test("at most one APPROVED row per lineage is enforced at the DB level, not just app logic", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);

    const lineageId = randomUUID();
    const v1 = await db
      .insertInto("project_estimates")
      .values({
        lineage_id: lineageId,
        version: 1,
        status: "READY_FOR_REVIEW",
        organization_id: organizationId,
        project_id: projectId,
        source_prompt: "sibling one",
        planner_output: JSON.stringify(fakePlannerOutput("sibling one")),
        planner_model: "test-fixture",
        created_by: owner.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // A second, sibling READY_FOR_REVIEW row in the SAME lineage — the app
    // layer would never produce this (revise always supersedes the prior
    // head in the same transaction it inserts the new one), but this test
    // is specifically about whether the DB schema itself, independent of
    // app logic, still refuses to let two versions in one lineage both be
    // APPROVED.
    const v2 = await db
      .insertInto("project_estimates")
      .values({
        lineage_id: lineageId,
        version: 2,
        status: "READY_FOR_REVIEW",
        organization_id: organizationId,
        project_id: projectId,
        source_prompt: "sibling two",
        planner_output: JSON.stringify(fakePlannerOutput("sibling two")),
        planner_model: "test-fixture",
        created_by: owner.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("project_estimates")
      .set({ status: "APPROVED", approved_by: owner.userId, approved_at: new Date() })
      .where("id", "=", v1.id)
      .execute();

    await assert.rejects(
      db
        .updateTable("project_estimates")
        .set({ status: "APPROVED", approved_by: owner.userId, approved_at: new Date() })
        .where("id", "=", v2.id)
        .execute(),
      /duplicate key|violates|unique/i,
      "project_estimates_one_approved_per_lineage must reject a second APPROVED row in the same lineage",
    );
  });
});
