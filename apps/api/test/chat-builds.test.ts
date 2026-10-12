// Chat-native builds — integration tests against a real Postgres via the
// real Fastify app, with a fake org sandbox serving the discussion
// transcript. Covers drafting a plan from a discussion into a new hosted
// project (idempotent), updating it from the chat, the build state the
// in-chat card reads, and that the rest of the chain (approve, budget,
// task) runs through the existing guarded endpoints unchanged.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";

const reposRoot = mkdtempSync(join(tmpdir(), "athernull-chat-repos-"));
process.env.REPOS_ROOT = reposRoot;

const { buildApp } = await import("../src/app.js");
const { setPlannerClientForTests } = await import("../src/planner.js");
const { db } = await import("../src/db.js");
const { repoPath, headOf } = await import("../src/repos/repos.js");
const { AUTH_ORIGIN, createAwaitingFundingTask } = await import("./support/app-fixtures.js");

// The org sandbox: answers the transcript read with a short discussion.
async function fakeSandbox() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const message = (source: string, text: string) => ({ kind: "MessageEvent", source, llm_message: { content: [{ type: "text", text }] } });
    res.end(
      req.url!.includes("/events/search")
        ? JSON.stringify({
            items: [message("user", "lets build a calculator app"), message("agent", "Plan: a web calculator with + - × ÷.")],
            next_page_id: null,
          })
        : "{}",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const prompts: string[] = [];
setPlannerClientForTests(async (prompt: string) => {
  prompts.push(prompt);
  return {
    goal: `Calculator v${prompts.length}`,
    scope: { included: ["basic arithmetic"], excluded: [] },
    deliverables: ["index.html", "calculator.js"],
    implementationPlan: ["Build the UI", "Wire the operations"],
    assumptions: [],
    acceptanceCriteria: ["2 + 2 = 4"],
    infrastructureRequirements: [],
    risks: [],
    resourceEstimate: { complexity: 0.2, estimatedDurationHours: { min: 1, max: 2 }, inferenceRequirements: { estimatedTier: "fast" } },
  };
});

let app: FastifyInstance;
let sandbox: Awaited<ReturnType<typeof fakeSandbox>>;
type T = Awaited<ReturnType<typeof createAwaitingFundingTask>>;
let org: T;
let other: T;

const req = (t: T, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: t.jar.header, origin: AUTH_ORIGIN }, payload });

async function newDiscussion(t: T): Promise<string> {
  const id = randomUUID();
  await db.insertInto("discussion_conversations").values({ conversation_id: id, organization_id: t.organizationId, created_by: t.userId }).execute();
  return id;
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  sandbox = await fakeSandbox();
  org = await createAwaitingFundingTask(app);
  other = await createAwaitingFundingTask(app);
  for (const t of [org, other]) {
    await db.insertInto("org_agent_servers").values({ organization_id: t.organizationId, base_url: sandbox.url, session_api_key: randomBytes(32).toString("hex") }).execute();
  }
});

after(async () => {
  await app.close();
  await sandbox.close();
  setPlannerClientForTests(null);
  rmSync(reposRoot, { recursive: true, force: true });
});

describe("chat-native builds", () => {
  test("build state: 404 for a conversation that isn't this org's discussion; empty before a plan", async () => {
    const id = await newDiscussion(org);
    assert.equal((await req(org, "GET", `/v1/discussions/${randomUUID()}/build`)).statusCode, 404);
    assert.equal((await req(other, "GET", `/v1/discussions/${id}/build`)).statusCode, 404);
    const res = await req(org, "GET", `/v1/discussions/${id.replace(/-/g, "")}/build`);
    assert.equal(res.statusCode, 200, res.body);
    const state = JSON.parse(res.body);
    assert.equal(state.plan, null);
    assert.equal(state.task, null);
    assert.deepEqual(state.defaultBudget, { amountMinor: 2000, currency: "USD" });
  });

  test("Draft plan creates one hosted project and plan, idempotently, with no repository URL", async () => {
    const id = await newDiscussion(org);
    const [a, b] = await Promise.all([req(org, "POST", `/v1/discussions/${id}/plan`), req(org, "POST", `/v1/discussions/${id}/plan`)]);
    assert.equal(a.statusCode, 201, a.body);
    assert.equal(b.statusCode, 201, b.body);
    const plan = JSON.parse(a.body);
    assert.equal(JSON.parse(b.body).id, plan.id, "a double click must not make two plans");
    const again = JSON.parse((await req(org, "POST", `/v1/discussions/${id}/plan`)).body);
    assert.equal(again.id, plan.id);

    const project = await db.selectFrom("projects").selectAll().where("id", "=", plan.projectId).executeTakeFirstOrThrow();
    assert.equal(project.repo_kind, "hosted");
    assert.equal(project.permitted_repository, `athernull://hosted/${project.id}`);
    assert.equal(project.scope, "lets build a calculator app");
    const repo = repoPath(org.organizationId, project.id);
    assert.ok(existsSync(repo));
    assert.match(await headOf(repo), /^[0-9a-f]{40}$/);
    assert.match(plan.sourcePrompt, /^\[Planned from a canvas discussion\]/);
    assert.match(plan.sourcePrompt, /lets build a calculator app/);

    const row = await db.selectFrom("discussion_conversations").select("planned_lineage_id").where("conversation_id", "=", id).executeTakeFirstOrThrow();
    assert.equal(row.planned_lineage_id, plan.lineageId);
  });

  test("Update plan re-plans from the chat with the current plan as the starting point", async () => {
    const id = await newDiscussion(org);
    const v1 = JSON.parse((await req(org, "POST", `/v1/discussions/${id}/plan`)).body);
    const res = await req(org, "POST", `/v1/discussions/${id}/plan/update`);
    assert.equal(res.statusCode, 201, res.body);
    const v2 = JSON.parse(res.body);
    assert.equal(v2.version, 2);
    assert.equal(v2.lineageId, v1.lineageId);
    assert.match(prompts.at(-1)!, /lets build a calculator app/);
    assert.ok(prompts.at(-1)!.includes(JSON.stringify(v1.plannerOutput)), "the current plan reaches the planner");
    const state = JSON.parse((await req(org, "GET", `/v1/discussions/${id}/build`)).body);
    assert.equal(state.plan.id, v2.id);
  });

  test("approve, budget and task go through the existing endpoints; the state follows; a billed plan is frozen", async () => {
    const id = await newDiscussion(org);
    const plan = JSON.parse((await req(org, "POST", `/v1/discussions/${id}/plan`)).body);
    assert.equal((await req(org, "POST", `/v1/projects/${plan.projectId}/estimates/${plan.id}/approve`)).statusCode, 200);
    const auth = await req(org, "POST", `/v1/projects/${plan.projectId}/estimates/${plan.id}/budget-authorization`, {
      source: "USER_SET",
      amountMinor: 2000,
      currency: "USD",
    });
    assert.equal(auth.statusCode, 201, auth.body);
    const profile = await db.selectFrom("agent_profiles").select("id").where("organization_id", "=", org.organizationId).executeTakeFirstOrThrow();
    const task = await req(org, "POST", `/v1/projects/${plan.projectId}/tasks/from-budget-authorization`, {
      budgetAuthorizationId: JSON.parse(auth.body).id,
      agentProfileId: profile.id,
      repositoryRevision: "main",
    });
    assert.equal(task.statusCode, 201, task.body);

    const state = JSON.parse((await req(org, "GET", `/v1/discussions/${id}/build`)).body);
    assert.equal(state.plan.status, "APPROVED");
    assert.equal(state.authorization.status, "CONSUMED");
    assert.equal(state.task.id, JSON.parse(task.body).id);
    assert.equal(state.task.status, "AWAITING_FUNDING");
    assert.equal(state.task.budgetMinor, 2000);

    assert.equal((await req(org, "POST", `/v1/discussions/${id}/plan/update`)).statusCode, 409);
    assert.equal((await req(other, "POST", `/v1/discussions/${id}/plan`)).statusCode, 404);
  });
});
