// Shared HTTP/DB fixtures for Phase 4E.1 funding tests (mirrors the helpers
// duplicated across the other test files). Importers must set DATABASE_URL and
// friends BEFORE importing this module (see project-funding.test.ts header).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";

import { db } from "../../src/db.js";

export const AUTH_ORIGIN = "http://localhost:3000";

export class CookieJar {
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

export async function signUpVerifiedAndSignIn(app: FastifyInstance, email: string, password: string, name: string) {
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

export async function createOrgAsOwner(app: FastifyInstance, jar: CookieJar, name: string, slug: string): Promise<string> {
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

export interface FundingTestTask {
  jar: CookieJar;
  userId: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  budgetAuthorizationId: string;
}

/** A canonical, provenance-bound AWAITING_FUNDING task (fixture APPROVED estimate + ACTIVE authorization, then the real canonical create endpoint). */
export async function createAwaitingFundingTask(app: FastifyInstance): Promise<FundingTestTask> {
  const suffix = randomUUID();
  const owner = await signUpVerifiedAndSignIn(app, `owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(app, owner.jar, `Org ${suffix}`, `org-${suffix}`);

  const project = await db
    .insertInto("projects")
    .values({ organization_id: organizationId, permitted_repository: "github.com/athernull/example", owner_user_id: owner.userId })
    .returningAll()
    .executeTakeFirstOrThrow();
  const agentProfile = await db
    .insertInto("agent_profiles")
    .values({
      organization_id: organizationId,
      model_tiers: JSON.stringify([{ tier: "fast", model: "anthropic/claude-haiku-4-5-20251001", maxComplexity: 1 }]),
      policy_version: "v1",
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const estimate = await db
    .insertInto("project_estimates")
    .values({
      lineage_id: randomUUID(),
      version: 1,
      status: "APPROVED",
      organization_id: organizationId,
      project_id: project.id,
      source_prompt: "fixture prompt",
      planner_output: JSON.stringify({
        goal: "Add a health check endpoint",
        scope: { included: ["core feature set"], excluded: [] },
        deliverables: ["A deployed change"],
        implementationPlan: ["Implement the objective"],
        assumptions: [],
        acceptanceCriteria: ["Returns 200"],
        infrastructureRequirements: [],
        risks: [],
        resourceEstimate: {
          complexity: 0.5,
          estimatedDurationHours: { min: 1, max: 2 },
          inferenceRequirements: { estimatedTier: "standard" },
        },
      }),
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
      project_id: project.id,
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
    url: `/v1/projects/${project.id}/tasks/from-budget-authorization`,
    headers: { cookie: owner.jar.header },
    payload: { budgetAuthorizationId: authorization.id, agentProfileId: agentProfile.id, repositoryRevision: "abc123" },
  });
  assert.equal(created.statusCode, 201, `canonical task creation failed: ${created.body}`);
  const taskId = (JSON.parse(created.body) as { id: string }).id;
  return {
    jar: owner.jar,
    userId: owner.userId,
    organizationId,
    projectId: project.id,
    taskId,
    budgetAuthorizationId: authorization.id,
  };
}

export async function countExecutionsForOrg(organizationId: string): Promise<number> {
  const r = await db
    .selectFrom("executions")
    .innerJoin("tasks", "tasks.id", "executions.task_id")
    .select(({ fn }) => [fn.count<string>("executions.id").as("n")])
    .where("tasks.organization_id", "=", organizationId)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
