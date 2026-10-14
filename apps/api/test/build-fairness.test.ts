// Several build workers run side by side (scripts/dev.mjs WORKER_CONCURRENCY);
// the claim gives at most one running build per organization, so one
// customer's queue cannot hold every worker (routes/internal.ts). Real
// Postgres. This file's builds are dated as the oldest in the shared queue,
// so the global FIFO claim reaches them first (see job-lifecycle.test.ts's
// header on the shared claim queue).
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

import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { createAwaitingFundingTask } = await import("./support/app-fixtures.js");

let app: FastifyInstance;
const mine: string[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  // Leave nothing claimable behind for other files.
  if (mine.length) await db.updateTable("tasks").set({ status: "CANCELLED" }).where("id", "in", mine).execute();
  await app.close();
});

/** A QUEUED build in `organizationId` (or a new one), dated `secondsAfterEpoch`. */
async function queuedBuild(secondsAfterEpoch: number, organizationId?: string) {
  const t = await createAwaitingFundingTask(app);
  let taskId = t.taskId;
  if (organizationId) {
    // A second build in an existing organization: a copy of its first.
    await db.updateTable("tasks").set({ status: "CANCELLED" }).where("id", "=", t.taskId).execute();
    mine.push(t.taskId);
    const other = await db.selectFrom("tasks").selectAll().where("organization_id", "=", organizationId).executeTakeFirstOrThrow();
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = other;
    const values = Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [k, v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v]),
    );
    taskId = (
      await db
        .insertInto("tasks")
        .values({ ...(values as typeof rest), id: randomUUID(), status: "QUEUED", source_estimate_id: null, source_budget_authorization_id: null })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  }
  await db
    .updateTable("tasks")
    .set({ status: "QUEUED", created_at: new Date(secondsAfterEpoch * 1000) })
    .where("id", "=", taskId)
    .execute();
  mine.push(taskId);
  const org = (await db.selectFrom("tasks").select("organization_id").where("id", "=", taskId).executeTakeFirstOrThrow()).organization_id;
  return { taskId, organizationId: org };
}

async function claim(): Promise<string | null> {
  const res = await app.inject({
    method: "POST",
    url: "/internal/executions/claim",
    headers: { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` },
    payload: { workerId: `worker-${randomUUID()}` },
  });
  if (res.statusCode === 204) return null;
  assert.equal(res.statusCode, 200, res.body);
  return (JSON.parse(res.body) as { jobId: string }).jobId;
}

describe("parallel build workers", () => {
  test("a second worker takes another customer's build, not a second build of a busy one", async () => {
    const a1 = await queuedBuild(1);
    const a2 = await queuedBuild(2, a1.organizationId);
    const b1 = await queuedBuild(3);

    assert.equal(await claim(), a1.taskId, "oldest first");
    assert.equal(await claim(), b1.taskId, "skips A's second build while A's first runs");
    const third = await claim();
    assert.notEqual(third, a2.taskId, "A's second build waits");
    if (third) mine.push(third);

    // A's first build finishes: its second is next.
    await db.updateTable("tasks").set({ status: "VERIFYING" }).where("id", "=", a1.taskId).execute();
    assert.equal(await claim(), a2.taskId);
  });
});
