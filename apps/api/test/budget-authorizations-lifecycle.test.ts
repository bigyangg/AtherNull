// Integration tests for Phase 4B's authorized project budget: eligibility,
// pricing semantics, idempotency, superseding/correction, concurrency, DB
// tenant-integrity constraints, and the no-execution-path invariant. Runs
// against a real Postgres database via Fastify inject(), same style as
// estimates-lifecycle.test.ts/tenant-authorization.test.ts — see
// tenant-authorization.test.ts's header for how to create/migrate the test
// database (must include migrations through
// 0009_project_budget_authorizations.sql).
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
// This file creates substantially more orgs/users than other lifecycle test
// files (many small, isolated eligibility/pricing/concurrency/tenant-
// integrity cases, each with its own fresh org) — a higher rate-limit
// ceiling than the "50" other test files use is needed purely to avoid
// tripping Better Auth's sign-up/sign-in rate limiter within this file's own
// run; it has no effect on any other test file's process (node:test runs
// each file in its own process).
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "500";

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

// --- fake planner client (never actually invoked by budget-authorization
// code paths — see budget-authorizations-no-execution-path.test.ts's static
// check — but generate()/revise() still need one to produce the estimates
// this file authorizes against) -------------------------------------------

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

// --- test helpers (mirrors estimates-lifecycle.test.ts) -------------------

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

// Full-flow fixture: generate v1 (UNPRICED, since RATE_CONFIG is null) and
// approve it. Returns the approved estimate body.
async function approvedUnpricedEstimate(jar: CookieJar, projectId: string, prompt = "Build a plan") {
  const genRes = await generate(jar, projectId, prompt);
  assert.equal(genRes.statusCode, 201, `generate failed: ${genRes.body}`);
  const v1 = JSON.parse(genRes.body) as { id: string; lineageId: string; version: number };
  const approveRes = await approve(jar, projectId, v1.id);
  assert.equal(approveRes.statusCode, 200, `approve failed: ${approveRes.body}`);
  return JSON.parse(approveRes.body) as {
    id: string;
    lineageId: string;
    version: number;
    status: string;
    pricingStatus: string;
  };
}

// No endpoint in this codebase ever produces a PRICED estimate (RATE_CONFIG
// is null — see apps/api/src/pricing/rates.ts) — inserted directly, same
// fixture-not-through-the-API pattern estimates-lifecycle.test.ts uses for
// states its own endpoints don't produce (e.g. its DRAFT test).
async function insertPricedApprovedEstimate(
  ownerUserId: string,
  organizationId: string,
  projectId: string,
  proposedBudgetCapMinor: number,
  currency = "USD",
) {
  return db
    .insertInto("project_estimates")
    .values({
      lineage_id: randomUUID(),
      version: 1,
      status: "APPROVED",
      organization_id: organizationId,
      project_id: projectId,
      source_prompt: "priced fixture prompt",
      planner_output: JSON.stringify(fakePlannerOutput("priced goal")),
      planner_model: "test-fixture",
      pricing_status: "PRICED",
      currency,
      estimated_min_minor: String(Math.floor(proposedBudgetCapMinor * 0.6)),
      estimated_max_minor: String(Math.floor(proposedBudgetCapMinor * 0.8)),
      proposed_budget_cap_minor: String(proposedBudgetCapMinor),
      rate_version: "test-rate-v1",
      created_by: ownerUserId,
      approved_by: ownerUserId,
      approved_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function insertDraftEstimate(ownerUserId: string, organizationId: string, projectId: string) {
  return db
    .insertInto("project_estimates")
    .values({
      lineage_id: randomUUID(),
      version: 1,
      status: "DRAFT",
      organization_id: organizationId,
      project_id: projectId,
      source_prompt: "draft fixture prompt",
      planner_output: JSON.stringify(fakePlannerOutput("draft goal")),
      planner_model: "test-fixture",
      created_by: ownerUserId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

interface AuthorizeBody {
  source: "USER_SET" | "ESTIMATE_PROPOSED_CAP";
  amountMinor?: number;
  currency: string;
}

async function authorize(
  jar: CookieJar,
  projectId: string,
  estimateId: string,
  body: AuthorizeBody,
) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/estimates/${estimateId}/budget-authorization`,
    headers: { cookie: jar.header },
    payload: body,
  });
}

async function listAuthorizationsForEstimate(jar: CookieJar, projectId: string, estimateId: string) {
  return app.inject({
    method: "GET",
    url: `/v1/projects/${projectId}/estimates/${estimateId}/budget-authorizations`,
    headers: { cookie: jar.header },
  });
}

// --- tests ------------------------------------------------------------

describe("eligibility", () => {
  test("an exact APPROVED estimate can receive a budget authorization", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 250_000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `authorize failed: ${res.body}`);
    const body = JSON.parse(res.body) as { status: string; estimateId: string };
    assert.equal(body.status, "ACTIVE");
    assert.equal(body.estimateId, approved.id);
  });

  test("a READY_FOR_REVIEW estimate is rejected", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string; status: string };
    assert.equal(v1.status, "READY_FOR_REVIEW");

    const res = await authorize(owner.jar, projectId, v1.id, {
      source: "USER_SET",
      amountMinor: 1000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 409, `expected rejection: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /READY_FOR_REVIEW/);
  });

  test("a SUPERSEDED estimate is rejected", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };
    await revise(owner.jar, projectId, v1.id, "Revise it");

    const res = await authorize(owner.jar, projectId, v1.id, {
      source: "USER_SET",
      amountMinor: 1000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 409, `expected rejection: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /SUPERSEDED/);
  });

  test("a DRAFT estimate is rejected", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);
    const draft = await insertDraftEstimate(owner.userId, organizationId, projectId);

    const res = await authorize(owner.jar, projectId, draft.id, {
      source: "USER_SET",
      amountMinor: 1000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 409, `expected rejection: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /DRAFT/);
  });

  test("cross-org access is rejected on both read and authorize", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, projectId: projectA } = await ownerOrgAndProject(suffixA);
    const { owner: ownerB } = await ownerOrgAndProject(suffixB);
    const approvedA = await approvedUnpricedEstimate(ownerA.jar, projectA);

    const crossAuthorize = await authorize(ownerB.jar, projectA, approvedA.id, {
      source: "USER_SET",
      amountMinor: 1000,
      currency: "USD",
    });
    assert.equal(crossAuthorize.statusCode, 404, `org B must not authorize org A's estimate: ${crossAuthorize.body}`);

    const crossRead = await listAuthorizationsForEstimate(ownerB.jar, projectA, approvedA.id);
    assert.equal(crossRead.statusCode, 404, `org B must not read org A's authorizations: ${crossRead.body}`);
  });

  test("a non-privileged member cannot authorize", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const memberEmail = `member-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const res = await authorize(member.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 1000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 403, `plain member must not be able to authorize: ${res.body}`);
  });

  test("a privileged owner can authorize", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 1000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `owner must be able to authorize: ${res.body}`);
  });

  test("a privileged admin (not just owner) can authorize", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const adminEmail = `admin-${suffix}@example.com`;
    const admin = await signUpVerifiedAndSignIn(adminEmail, "correct horse battery", "Admin");
    await addMemberDirect(organizationId, admin.userId, "admin");
    await setActiveOrg(admin.jar, organizationId);

    const res = await authorize(admin.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 1000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `admin must be able to authorize: ${res.body}`);
  });
});

describe("recorded fields", () => {
  test("authorization records the exact estimate_id/lineage_id/version", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 5000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `authorize failed: ${res.body}`);
    const body = JSON.parse(res.body) as {
      estimateId: string;
      estimateLineageId: string;
      estimateVersion: number;
    };
    assert.equal(body.estimateId, approved.id);
    assert.equal(body.estimateLineageId, approved.lineageId);
    assert.equal(body.estimateVersion, approved.version);
  });

  test("authorization records the exact actor and timestamp", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const before = new Date();
    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 5000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `authorize failed: ${res.body}`);
    const body = JSON.parse(res.body) as { authorizedBy: string; authorizedAt: string };
    assert.equal(body.authorizedBy, owner.userId);
    assert.ok(new Date(body.authorizedAt).getTime() >= before.getTime() - 1000);
  });

  test("authorization records the exact currency", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 5000,
      currency: "EUR",
    });
    assert.equal(res.statusCode, 201, `authorize failed: ${res.body}`);
    const body = JSON.parse(res.body) as { currency: string };
    assert.equal(body.currency, "EUR");
  });

  test("authorization records amount_minor exactly", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 123_456_789,
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `authorize failed: ${res.body}`);
    const body = JSON.parse(res.body) as { amountMinor: number };
    assert.equal(body.amountMinor, 123_456_789);

    const row = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", (JSON.parse(res.body) as { id: string }).id)
      .executeTakeFirstOrThrow();
    assert.equal(row.amount_minor, "123456789");
  });
});

describe("pricing semantics", () => {
  test("an UNPRICED estimate never silently becomes $0 — ESTIMATE_PROPOSED_CAP is rejected outright", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);
    assert.equal(approved.pricingStatus, "UNPRICED");

    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "ESTIMATE_PROPOSED_CAP",
      currency: "USD",
    });
    assert.equal(res.statusCode, 400, `UNPRICED + ESTIMATE_PROPOSED_CAP must be rejected: ${res.body}`);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /UNPRICED/);

    const rows = await db
      .selectFrom("project_budget_authorizations")
      .select(["id"])
      .where("estimate_id", "=", approved.id)
      .execute();
    assert.equal(rows.length, 0, "a rejected request must never create a $0 (or any) authorization row");
  });

  test("an UNPRICED estimate with an explicit USER_SET cap works", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const res = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 75_000,
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `USER_SET on UNPRICED must succeed: ${res.body}`);
    const body = JSON.parse(res.body) as { source: string; amountMinor: number };
    assert.equal(body.source, "USER_SET");
    assert.equal(body.amountMinor, 75_000);
  });

  test("planner/model output is never consulted for monetary authorization", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    // Install a planner client that throws if invoked at all — if authorize
    // somehow called generatePlannerOutput() under the hood, this test would
    // fail loudly instead of silently passing.
    setPlannerClientForTests(async () => {
      throw new Error("the planner must never be called by budget authorization");
    });
    try {
      const res = await authorize(owner.jar, projectId, approved.id, {
        source: "USER_SET",
        amountMinor: 10_000,
        currency: "USD",
      });
      assert.equal(res.statusCode, 201, `authorize must succeed without ever calling the planner: ${res.body}`);
    } finally {
      installDefaultFakePlanner();
    }
  });

  test("a PRICED estimate uses its own persisted proposed_budget_cap_minor, never a regenerated value", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);
    const priced = await insertPricedApprovedEstimate(owner.userId, organizationId, projectId, 999_000, "USD");

    const res = await authorize(owner.jar, projectId, priced.id, {
      source: "ESTIMATE_PROPOSED_CAP",
      currency: "USD",
    });
    assert.equal(res.statusCode, 201, `ESTIMATE_PROPOSED_CAP on a PRICED estimate must succeed: ${res.body}`);
    const body = JSON.parse(res.body) as { amountMinor: number; source: string };
    assert.equal(body.source, "ESTIMATE_PROPOSED_CAP");
    assert.equal(body.amountMinor, 999_000, "must use the estimate's own persisted cap exactly");
  });

  test("a client-supplied amountMinor that doesn't match the persisted cap is rejected, never substituted", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);
    const priced = await insertPricedApprovedEstimate(owner.userId, organizationId, projectId, 500_000, "USD");

    const res = await authorize(owner.jar, projectId, priced.id, {
      source: "ESTIMATE_PROPOSED_CAP",
      amountMinor: 1, // deliberately mismatched
      currency: "USD",
    });
    assert.equal(res.statusCode, 400, `mismatched amountMinor must be rejected: ${res.body}`);

    const rows = await db
      .selectFrom("project_budget_authorizations")
      .select(["id"])
      .where("estimate_id", "=", priced.id)
      .execute();
    assert.equal(rows.length, 0, "a rejected mismatched amount must never be silently substituted and persisted");
  });

  test("amount_minor <= 0 is rejected", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    for (const bad of [0, -1, -1000]) {
      const res = await authorize(owner.jar, projectId, approved.id, {
        source: "USER_SET",
        amountMinor: bad,
        currency: "USD",
      });
      assert.equal(res.statusCode, 400, `amountMinor=${bad} must be rejected: ${res.body}`);
    }
  });

  test("a malformed monetary amount is rejected: float, string, NaN, over the technical bound", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);
    const url = `/v1/projects/${projectId}/estimates/${approved.id}/budget-authorization`;

    const floatRes = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 100.5,
      currency: "USD",
    });
    assert.equal(floatRes.statusCode, 400, `float amount must be rejected: ${floatRes.body}`);

    const stringRes = await app.inject({
      method: "POST",
      url,
      headers: { cookie: owner.jar.header },
      payload: { source: "USER_SET", amountMinor: "100", currency: "USD" },
    });
    assert.equal(stringRes.statusCode, 400, `string amount must be rejected: ${stringRes.body}`);

    const nanRes = await app.inject({
      method: "POST",
      url,
      headers: { cookie: owner.jar.header, "content-type": "application/json" },
      payload: '{"source":"USER_SET","amountMinor":NaN,"currency":"USD"}',
    });
    assert.equal(nanRes.statusCode, 400, `NaN amount must be rejected: ${nanRes.body}`);

    const overBoundRes = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 100_000_000_001,
      currency: "USD",
    });
    assert.equal(overBoundRes.statusCode, 400, `over-bound amount must be rejected: ${overBoundRes.body}`);
  });
});

describe("idempotency and concurrency", () => {
  test("an exact-duplicate identical authorization request is idempotent", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);
    const payload: AuthorizeBody = { source: "USER_SET", amountMinor: 42_000, currency: "USD" };

    const first = await authorize(owner.jar, projectId, approved.id, payload);
    assert.equal(first.statusCode, 201, `first authorize failed: ${first.body}`);
    const firstBody = JSON.parse(first.body) as { id: string };

    const second = await authorize(owner.jar, projectId, approved.id, payload);
    assert.equal(second.statusCode, 200, `identical repeat must be idempotent (200, not 201): ${second.body}`);
    const secondBody = JSON.parse(second.body) as { id: string };
    assert.equal(secondBody.id, firstBody.id, "an identical repeat must return the same row, not a new one");

    const rows = await db
      .selectFrom("project_budget_authorizations")
      .select(["id"])
      .where("estimate_id", "=", approved.id)
      .execute();
    assert.equal(rows.length, 1, "an identical repeat must never create a second row");
  });

  // The route handler locks the TARGET ESTIMATE row (`SELECT ... FOR
  // UPDATE`) before ever touching project_budget_authorizations — the same
  // idiom routes/estimates.ts's /revise uses on project_estimates itself.
  // Two concurrent authorize() calls against the SAME estimate therefore
  // fully serialize at that lock: there is no window in which both read
  // "no ACTIVE row yet" or a stale ACTIVE row at once. Confirmed here: both
  // concurrent requests succeed (201 each — the second is a legitimate,
  // correctly-chained correction of the first, not a race loser), and the
  // database ends up in exactly the same consistent state a fully
  // sequential pair of calls would produce, every time. The partial unique
  // index (project_budget_authorizations_one_active_per_estimate) is the
  // last-resort backstop for a path that does NOT take this lock — proven
  // directly, independent of the route, in the "partial unique index
  // backstop" test below.
  test("concurrent authorization requests on a fresh estimate serialize cleanly to exactly one ACTIVE row", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const [resA, resB] = await Promise.all([
      authorize(owner.jar, projectId, approved.id, { source: "USER_SET", amountMinor: 11_000, currency: "USD" }),
      authorize(owner.jar, projectId, approved.id, { source: "USER_SET", amountMinor: 22_000, currency: "USD" }),
    ]);

    // Both requests are legitimate distinct amounts targeting the same
    // estimate — the estimate-row lock serializes them, so both succeed:
    // whichever transaction runs first creates the row (201), and the
    // other one, running strictly after, correctly observes it as the
    // current ACTIVE row and supersedes it (also 201, as a correction).
    assert.equal(resA.statusCode, 201, `first-in-program-order request failed: ${resA.body}`);
    assert.equal(resB.statusCode, 201, `second-in-program-order request failed: ${resB.body}`);

    const activeRows = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("estimate_id", "=", approved.id)
      .where("status", "=", "ACTIVE")
      .execute();
    assert.equal(activeRows.length, 1, "exactly one ACTIVE row must exist after the race, regardless of interleaving");

    const allRows = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("estimate_id", "=", approved.id)
      .execute();
    assert.equal(allRows.length, 2, "exactly two rows total: the first insert, superseded by the second");
    const superseded = allRows.find((r) => r.status === "SUPERSEDED");
    const active = allRows.find((r) => r.status === "ACTIVE");
    assert.ok(superseded && active, "one row must be SUPERSEDED and one ACTIVE — never two ACTIVE, never zero");
    assert.equal(active!.supersedes_id, superseded!.id, "the ACTIVE row's supersedes_id must point at the SUPERSEDED one");
  });

  test("concurrent CORRECTIONS on an already-authorized estimate serialize cleanly to exactly one ACTIVE row", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const initial = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 5_000,
      currency: "USD",
    });
    assert.equal(initial.statusCode, 201, `initial authorize failed: ${initial.body}`);

    const [resA, resB] = await Promise.all([
      authorize(owner.jar, projectId, approved.id, { source: "USER_SET", amountMinor: 33_000, currency: "USD" }),
      authorize(owner.jar, projectId, approved.id, { source: "USER_SET", amountMinor: 44_000, currency: "USD" }),
    ]);

    assert.equal(resA.statusCode, 201, `first correction failed: ${resA.body}`);
    assert.equal(resB.statusCode, 201, `second correction failed: ${resB.body}`);

    const activeRows = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("estimate_id", "=", approved.id)
      .where("status", "=", "ACTIVE")
      .execute();
    assert.equal(activeRows.length, 1, "exactly one ACTIVE row must exist after the correction race");
    const activeAmount = Number(activeRows[0]!.amount_minor);
    assert.ok(
      activeAmount === 33_000 || activeAmount === 44_000,
      "the final ACTIVE row must be one of the two submitted corrections, not a corrupted merge",
    );

    const totalRows = await db
      .selectFrom("project_budget_authorizations")
      .select(["id"])
      .where("estimate_id", "=", approved.id)
      .execute();
    assert.equal(totalRows.length, 3, "the initial row plus both corrections, chained — never a duplicate ACTIVE row");
  });

  // Direct-DB race, bypassing the route entirely (no estimate-row lock is
  // taken at all here) — this is what specifically exercises
  // project_budget_authorizations_one_active_per_estimate itself as the
  // "ultimate guarantee" the design doc describes, independent of the
  // application-level serialization the route happens to also provide.
  test("partial unique index backstop: two genuinely concurrent raw inserts for the same estimate_id cannot both succeed", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const insertRaw = (amountMinor: number) =>
      db
        .insertInto("project_budget_authorizations")
        .values({
          organization_id: organizationId,
          project_id: projectId,
          estimate_id: approved.id,
          estimate_lineage_id: approved.lineageId,
          estimate_version: approved.version,
          amount_minor: String(amountMinor),
          currency: "USD",
          source: "USER_SET",
          status: "ACTIVE",
          authorized_by: owner.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

    const results = await Promise.allSettled([insertRaw(1_111), insertRaw(2_222)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one of the two genuinely concurrent raw inserts must succeed");
    assert.equal(rejected.length, 1, "exactly one of the two genuinely concurrent raw inserts must be rejected");
    const rejection = rejected[0] as PromiseRejectedResult;
    assert.match(
      String((rejection.reason as { message?: string }).message ?? rejection.reason),
      /duplicate key|unique|violates/i,
      "the rejection must come from the partial unique index, not some other error",
    );

    const activeRows = await db
      .selectFrom("project_budget_authorizations")
      .select(["id"])
      .where("estimate_id", "=", approved.id)
      .where("status", "=", "ACTIVE")
      .execute();
    assert.equal(activeRows.length, 1, "exactly one ACTIVE row must survive the genuine race");
  });
});

describe("superseding / versioning", () => {
  test("a changed amount supersedes the old ACTIVE row correctly", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const first = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 10_000,
      currency: "USD",
    });
    assert.equal(first.statusCode, 201);
    const firstBody = JSON.parse(first.body) as { id: string; authorizedAt: string };

    const second = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 20_000,
      currency: "USD",
    });
    assert.equal(second.statusCode, 201, `correction must succeed: ${second.body}`);
    const secondBody = JSON.parse(second.body) as { id: string; status: string; supersedesId: string | null };
    assert.equal(secondBody.status, "ACTIVE");
    assert.equal(secondBody.supersedesId, firstBody.id);
    assert.notEqual(secondBody.id, firstBody.id);

    const oldRow = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", firstBody.id)
      .executeTakeFirstOrThrow();
    assert.equal(oldRow.status, "SUPERSEDED");
  });

  test("the superseded row's original amount/actor/timestamp remain exactly unchanged forever", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

    const first = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 15_000,
      currency: "USD",
    });
    const firstBody = JSON.parse(first.body) as { id: string; authorizedBy: string; authorizedAt: string };

    await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 25_000,
      currency: "USD",
    });

    const oldRow = await db
      .selectFrom("project_budget_authorizations")
      .selectAll()
      .where("id", "=", firstBody.id)
      .executeTakeFirstOrThrow();
    assert.equal(oldRow.amount_minor, "15000", "superseded row's original amount must never change");
    assert.equal(oldRow.authorized_by, firstBody.authorizedBy);
    assert.equal(
      oldRow.authorized_at instanceof Date ? oldRow.authorized_at.toISOString() : oldRow.authorized_at,
      firstBody.authorizedAt,
      "superseded row's original authorized_at must never change",
    );
    assert.equal(oldRow.status, "SUPERSEDED");
  });

  test("estimate revision (v2 -> v3) does not mutate or inherit v2's budget authorization", async () => {
    const suffix = randomUUID();
    const { owner, projectId } = await ownerOrgAndProject(suffix);

    const genRes = await generate(owner.jar, projectId, "Build a plan");
    const v1 = JSON.parse(genRes.body) as { id: string };
    const revRes = await revise(owner.jar, projectId, v1.id, "Add more scope");
    const v2 = JSON.parse(revRes.body) as { id: string; version: number };
    assert.equal(v2.version, 2);
    const approveV2 = await approve(owner.jar, projectId, v2.id);
    assert.equal(approveV2.statusCode, 200, `approve v2 failed: ${approveV2.body}`);

    const authRes = await authorize(owner.jar, projectId, v2.id, {
      source: "USER_SET",
      amountMinor: 60_000,
      currency: "USD",
    });
    assert.equal(authRes.statusCode, 201, `authorize v2 failed: ${authRes.body}`);

    // Revising v2 (still an ACTIVE-authorization holder) into v3 must
    // succeed exactly like any other revise, and v3 must start with zero
    // budget authorizations of its own — no inheritance across versions.
    const rev2Res = await revise(owner.jar, projectId, v2.id, "One more change");
    assert.equal(rev2Res.statusCode, 201, `revise v2->v3 failed: ${rev2Res.body}`);
    const v3 = JSON.parse(rev2Res.body) as { id: string; version: number };
    assert.equal(v3.version, 3);

    const v3AuthList = await listAuthorizationsForEstimate(owner.jar, projectId, v3.id);
    assert.equal(v3AuthList.statusCode, 200, `list v3 authorizations failed: ${v3AuthList.body}`);
    const v3Auths = JSON.parse(v3AuthList.body) as unknown[];
    assert.equal(v3Auths.length, 0, "v3 must start with zero budget authorizations — no inheritance from v2");

    // v2's own authorization must remain untouched by the revision.
    const v2AuthList = await listAuthorizationsForEstimate(owner.jar, projectId, v2.id);
    const v2Auths = JSON.parse(v2AuthList.body) as { status: string; amountMinor: number }[];
    assert.equal(v2Auths.length, 1);
    const v2Auth = v2Auths[0];
    assert.ok(v2Auth);
    assert.equal(v2Auth.status, "ACTIVE");
    assert.equal(v2Auth.amountMinor, 60_000);
  });
});

describe("DB tenant-integrity constraints (direct inserts, real Postgres)", () => {
  test("DB rejects a project_id/organization_id mismatch", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, projectId: projectA } = await ownerOrgAndProject(suffixA);
    const { owner: ownerB, organizationId: organizationB, projectId: projectB } = await ownerOrgAndProject(suffixB);
    const approvedB = await approvedUnpricedEstimate(ownerB.jar, projectB);
    void ownerA;

    await assert.rejects(
      db
        .insertInto("project_budget_authorizations")
        .values({
          organization_id: organizationB,
          // Mismatched on purpose: projectA genuinely belongs to
          // organizationA, not organizationB.
          project_id: projectA,
          estimate_id: approvedB.id,
          estimate_lineage_id: approvedB.lineageId,
          estimate_version: approvedB.version,
          amount_minor: "1000",
          currency: "USD",
          source: "USER_SET",
          authorized_by: ownerB.userId,
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject a project_id/organization_id pair that doesn't match projects_id_organization_id_unique",
    );
  });

  test("DB rejects an estimate/organization mismatch even when project/org and estimate tuple are each individually valid", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, organizationId: organizationA, projectId: projectA } = await ownerOrgAndProject(suffixA);
    const { owner: ownerB, projectId: projectB } = await ownerOrgAndProject(suffixB);
    const approvedB = await approvedUnpricedEstimate(ownerB.jar, projectB);

    // organization_id/project_id pair is genuinely valid (org A, project A).
    // estimate_id/lineage_id/version tuple is genuinely valid too (all three
    // really belong to estimate B). The only thing wrong is that estimate B
    // belongs to organization B, not organization A — exactly the gap the
    // corrected schema's (estimate_id, organization_id) FK closes.
    await assert.rejects(
      db
        .insertInto("project_budget_authorizations")
        .values({
          organization_id: organizationA,
          project_id: projectA,
          estimate_id: approvedB.id,
          estimate_lineage_id: approvedB.lineageId,
          estimate_version: approvedB.version,
          amount_minor: "1000",
          currency: "USD",
          source: "USER_SET",
          authorized_by: ownerA.userId,
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject an estimate_id whose real organization_id differs from this row's organization_id",
    );
  });

  test("DB rejects a fabricated estimate_id paired with a real but unrelated lineage_id/version combination", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, organizationId: organizationA, projectId: projectA } = await ownerOrgAndProject(suffixA);
    const { owner: ownerB, projectId: projectB } = await ownerOrgAndProject(suffixB);
    const approvedA = await approvedUnpricedEstimate(ownerA.jar, projectA);
    const approvedB = await approvedUnpricedEstimate(ownerB.jar, projectB);

    // estimate_id genuinely exists (estimate A) and organization matches (A)
    // — but estimate_lineage_id/estimate_version are estimate B's, which do
    // NOT actually belong to estimate A's id. The (estimate_id, lineage_id,
    // version) composite FK must reject this tuple.
    await assert.rejects(
      db
        .insertInto("project_budget_authorizations")
        .values({
          organization_id: organizationA,
          project_id: projectA,
          estimate_id: approvedA.id,
          estimate_lineage_id: approvedB.lineageId,
          estimate_version: approvedB.version,
          amount_minor: "1000",
          currency: "USD",
          source: "USER_SET",
          authorized_by: ownerA.userId,
        })
        .execute(),
      /foreign key|violates/i,
      "Postgres must reject an (estimate_id, lineage_id, version) tuple that doesn't genuinely belong together",
    );
  });
});

describe("no-execution / no-settlement boundary (runtime)", () => {
  test("a full authorize/re-authorize cycle creates zero tasks, executions, or payment_intents rows", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId } = await ownerOrgAndProject(suffix);
    const approved = await approvedUnpricedEstimate(owner.jar, projectId);

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
    const paymentIntentsBefore = await db
      .selectFrom("payment_intents")
      .select(({ fn }) => [fn.count<string>("payment_intents.id").as("n")])
      .innerJoin("tasks", "tasks.id", "payment_intents.job_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    const first = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 10_000,
      currency: "USD",
    });
    assert.equal(first.statusCode, 201, `authorize failed: ${first.body}`);
    const second = await authorize(owner.jar, projectId, approved.id, {
      source: "USER_SET",
      amountMinor: 20_000,
      currency: "USD",
    });
    assert.equal(second.statusCode, 201, `re-authorize failed: ${second.body}`);

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
    const paymentIntentsAfter = await db
      .selectFrom("payment_intents")
      .select(({ fn }) => [fn.count<string>("payment_intents.id").as("n")])
      .innerJoin("tasks", "tasks.id", "payment_intents.job_id")
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();

    assert.equal(tasksAfter.n, tasksBefore.n, "budget authorization must never create a task row");
    assert.equal(executionsAfter.n, executionsBefore.n, "budget authorization must never create an execution row");
    assert.equal(
      paymentIntentsAfter.n,
      paymentIntentsBefore.n,
      "budget authorization must never create a payment_intents row — no settlement/payment action occurs",
    );
  });
});
