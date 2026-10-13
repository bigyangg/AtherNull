// Request changes (routes/change-requests.ts): a verified build goes back to
// the agent with the customer's feedback, on the same funding, continuing
// from the delivered version, a limited number of times. Real Postgres via
// Fastify inject().
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";
process.env.INTERNAL_API_TOKEN ??= "test-internal-token-not-for-real-use";
process.env.MAX_CHANGE_ROUNDS = "2";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { createAwaitingFundingTask, signUpVerifiedAndSignIn } = await import("./support/app-fixtures.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

// Builds this file sends back to QUEUED must not be claimed by another test
// file's worker (the claim queue is shared): cancel them when done.
const created: string[] = [];

after(async () => {
  if (created.length) await db.updateTable("tasks").set({ status: "CANCELLED" }).where("id", "in", created).execute();
  await app.close();
});

const RESULT = "a".repeat(40);

/** A build that passed verification and waits for the customer. */
async function reviewableBuild() {
  const t = await createAwaitingFundingTask(app);
  created.push(t.taskId);
  await db.updateTable("tasks").set({ status: "AWAITING_ACCEPTANCE", result_commit: RESULT }).where("id", "=", t.taskId).execute();
  return t;
}

const requestChanges = (taskId: string, cookie: string, feedback: unknown) =>
  app.inject({ method: "POST", url: `/v1/jobs/${taskId}/request-changes`, headers: { cookie, origin: "http://localhost:3000" }, payload: { feedback } });

describe("request changes", () => {
  test("sends a verified build back to the agent, recording the feedback and the delivered version", async () => {
    const b = await reviewableBuild();
    const res = await requestChanges(b.taskId, b.jar.header, "The buttons and the keyboard do nothing.");
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(JSON.parse(res.body), { taskId: b.taskId, status: "QUEUED", round: 1, roundsLeft: 1 });

    const task = await db.selectFrom("tasks").select(["status"]).where("id", "=", b.taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "QUEUED");
    const row = await db.selectFrom("task_change_requests").selectAll().where("task_id", "=", b.taskId).executeTakeFirstOrThrow();
    assert.equal(row.round, 1);
    assert.equal(row.feedback, "The buttons and the keyboard do nothing.");
    assert.equal(row.from_commit, RESULT);
  });

  test("only while the build waits for review, and with real feedback", async () => {
    const b = await createAwaitingFundingTask(app); // still AWAITING_FUNDING
    assert.equal((await requestChanges(b.taskId, b.jar.header, "please change it")).statusCode, 409);
    const r = await reviewableBuild();
    assert.equal((await requestChanges(r.taskId, r.jar.header, "  ")).statusCode, 400);
    assert.equal((await requestChanges(r.taskId, r.jar.header, "x".repeat(4001))).statusCode, 400);
  });

  test("rounds are capped per build", async () => {
    const b = await reviewableBuild();
    assert.equal((await requestChanges(b.taskId, b.jar.header, "round one")).statusCode, 201);
    await db.updateTable("tasks").set({ status: "AWAITING_ACCEPTANCE" }).where("id", "=", b.taskId).execute();
    assert.equal((await requestChanges(b.taskId, b.jar.header, "round two")).statusCode, 201);
    await db.updateTable("tasks").set({ status: "AWAITING_ACCEPTANCE" }).where("id", "=", b.taskId).execute();
    const third = await requestChanges(b.taskId, b.jar.header, "round three");
    assert.equal(third.statusCode, 409);
    assert.match(JSON.parse(third.body).error, /used all 2 change rounds/);
  });

  test("another organization cannot request changes on it", async () => {
    const b = await reviewableBuild();
    const stranger = await signUpVerifiedAndSignIn(app, `stranger-${randomUUID()}@example.com`, "correct horse battery", "Stranger");
    const res = await requestChanges(b.taskId, stranger.jar.header, "let me change your build");
    assert.ok([403, 404].includes(res.statusCode), `expected 403/404, got ${res.statusCode}`);
    const task = await db.selectFrom("tasks").select("status").where("id", "=", b.taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "AWAITING_ACCEPTANCE");
  });
});
