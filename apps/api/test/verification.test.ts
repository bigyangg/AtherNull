// ADR-0017 independent verification: patch capture (worker), claim and
// verdict (verifier), and the separation that keeps a worker from approving
// its own work. Real Postgres via Fastify inject().
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";
process.env.INTERNAL_API_TOKEN ??= "test-internal-token-not-for-real-use";
process.env.VERIFIER_API_TOKEN = "test-verifier-token-not-for-real-use";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { createAwaitingFundingTask } = await import("./support/app-fixtures.js");

const WORKER = { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` };
const VERIFIER = { authorization: `Bearer ${process.env.VERIFIER_API_TOKEN}` };
const PATCH = [
  "diff --git a/src/app.js b/src/app.js",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,1 +1,2 @@",
  " const a = 1;",
  "+const b = 2;",
  "diff --git a/test/b.test.js b/test/b.test.js",
  "--- /dev/null",
  "+++ b/test/b.test.js",
  "@@ -0,0 +1,1 @@",
  "+test('b')",
  "",
].join("\n");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

/** A VERIFYING task whose latest execution is leased to `workerId`. */
async function verifyingBuild(workerId: string) {
  const t = await createAwaitingFundingTask(app);
  const execution = await db
    .insertInto("executions")
    .values({ task_id: t.taskId, status: "SUCCEEDED", lease_owner: workerId, started_at: new Date(), ended_at: new Date() })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.updateTable("tasks").set({ status: "VERIFYING" }).where("id", "=", t.taskId).execute();
  return { ...t, executionId: execution.id };
}

const submitPatch = (executionId: string, workerId: string, patch = PATCH) =>
  app.inject({ method: "POST", url: `/internal/executions/${executionId}/patch`, headers: WORKER, payload: { workerId, baseRevision: "abc123", patch } });

/** Claims until this test's own build comes up (other files share the queue). */
async function claimMine(executionId: string, verifierId: string) {
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({ method: "POST", url: "/internal/verifications/claim", headers: VERIFIER, payload: { verifierId } });
    if (res.statusCode === 204) return null;
    const job = JSON.parse(res.body) as { executionId: string; patch: string; patchSha256: string; repository: string; baseRevision: string };
    if (job.executionId === executionId) return job;
  }
  return null;
}

describe("independent verification", () => {
  test("the worker's patch is stored once, with its hash and stats, under its lease only", async () => {
    const workerId = `worker-${randomUUID()}`;
    const b = await verifyingBuild(workerId);
    assert.equal((await submitPatch(b.executionId, "someone-else")).statusCode, 409, "lease owner only");
    const res = await submitPatch(b.executionId, workerId);
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(JSON.parse(res.body), {
      sha256: createHash("sha256").update(PATCH).digest("hex"),
      files: 2,
      insertions: 2,
      deletions: 0,
    });
    assert.equal((await submitPatch(b.executionId, workerId)).statusCode, 201, "same patch is idempotent");
    assert.equal((await submitPatch(b.executionId, workerId, `${PATCH}+more\n`)).statusCode, 409, "a different patch is refused");
  });

  test("a PASS from the verifier moves the build to review and records evidence against the patch", async () => {
    const workerId = `worker-${randomUUID()}`;
    const b = await verifyingBuild(workerId);
    await submitPatch(b.executionId, workerId);
    const job = await claimMine(b.executionId, "verifier-a");
    assert.ok(job, "build is claimable");
    assert.equal(job.patch, PATCH);
    assert.equal(job.repository, "github.com/athernull/example");
    assert.equal(job.baseRevision, "abc123");

    // Only the claiming verifier can report.
    const other = await app.inject({
      method: "POST",
      url: `/internal/verifications/${b.executionId}/result`,
      headers: VERIFIER,
      payload: { verifierId: "verifier-b", outcome: "PASS", tests: [], evidence: {} },
    });
    assert.equal(other.statusCode, 409);

    const res = await app.inject({
      method: "POST",
      url: `/internal/verifications/${b.executionId}/result`,
      headers: VERIFIER,
      payload: { verifierId: "verifier-a", outcome: "PASS", tests: [{ name: "b", passed: true }], evidence: { exitCode: 0 } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const task = await db.selectFrom("tasks").select("status").where("id", "=", b.taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "AWAITING_ACCEPTANCE");
    const run = await db.selectFrom("verification_runs").selectAll().where("execution_id", "=", b.executionId).executeTakeFirstOrThrow();
    assert.equal(run.outcome, "PASS");
    assert.equal(run.artifact_hash, job.patchSha256);
    assert.equal(run.verifier_version, "athernull-verifier/1");
    assert.equal((run.evidence as { independent?: boolean }).independent, true);

    // The customer sees exactly the verified change; other orgs do not.
    const mine = await app.inject({ method: "GET", url: `/v1/jobs/${b.taskId}/patch`, headers: { cookie: b.jar.header } });
    assert.equal(mine.statusCode, 200, mine.body);
    assert.equal((JSON.parse(mine.body) as { sha256: string }).sha256, job.patchSha256);
    const stranger = await createAwaitingFundingTask(app);
    const theirs = await app.inject({ method: "GET", url: `/v1/jobs/${b.taskId}/patch`, headers: { cookie: stranger.jar.header } });
    assert.equal(theirs.statusCode, 404);

    // Exactly once: verified builds are not claimable or reportable again.
    assert.equal(await claimMine(b.executionId, "verifier-a"), null);
  });

  test("a FAIL fails the build (refundable)", async () => {
    const workerId = `worker-${randomUUID()}`;
    const b = await verifyingBuild(workerId);
    await submitPatch(b.executionId, workerId);
    assert.ok(await claimMine(b.executionId, "verifier-c"));
    const res = await app.inject({
      method: "POST",
      url: `/internal/verifications/${b.executionId}/result`,
      headers: VERIFIER,
      payload: { verifierId: "verifier-c", outcome: "FAIL", tests: [{ name: "b", passed: false }], evidence: { reason: "1 of 1 tests failed" } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const task = await db.selectFrom("tasks").select("status").where("id", "=", b.taskId).executeTakeFirstOrThrow();
    assert.equal(task.status, "FAILED");
  });

  test("a failed hosted build goes back to the agent with the findings, then fails after the fix rounds", async () => {
    const b = await verifyingBuild(`worker-${randomUUID()}`);
    const commits = ["a", "b", "c"].map((c) => c.repeat(40));
    try {
      let executionId = b.executionId;
      for (const [i, commit] of commits.entries()) {
        if (i > 0) {
          // The fix round ran and is back for verification.
          const workerId = `worker-${randomUUID()}`;
          executionId = (
            await db
              .insertInto("executions")
              .values({ task_id: b.taskId, status: "SUCCEEDED", lease_owner: workerId, started_at: new Date(), ended_at: new Date() })
              .returning("id")
              .executeTakeFirstOrThrow()
          ).id;
          await db.updateTable("tasks").set({ status: "VERIFYING" }).where("id", "=", b.taskId).execute();
          assert.equal((await submitPatch(executionId, workerId)).statusCode, 201);
        } else {
          const lease = await db.selectFrom("executions").select("lease_owner").where("id", "=", executionId).executeTakeFirstOrThrow();
          await submitPatch(executionId, lease.lease_owner!);
        }
        await db.updateTable("execution_patches").set({ result_commit: commit }).where("execution_id", "=", executionId).execute();
        assert.ok(await claimMine(executionId, "verifier-fix"));
        const res = await app.inject({
          method: "POST",
          url: `/internal/verifications/${executionId}/result`,
          headers: VERIFIER,
          payload: {
            verifierId: "verifier-fix",
            outcome: "FAIL",
            tests: [{ name: "adds", passed: true }, { name: "browser", passed: false }],
            evidence: { reason: "the page has errors in a browser: SyntaxError", logTail: "ok 1 adds" },
          },
        });
        assert.equal(res.statusCode, 200, res.body);
        const task = await db.selectFrom("tasks").select("status").where("id", "=", b.taskId).executeTakeFirstOrThrow();
        assert.equal(task.status, i < 2 ? "QUEUED" : "FAILED", `round ${i + 1}`);
      }

      const rounds = await db
        .selectFrom("task_change_requests")
        .select(["round", "source", "from_commit", "feedback", "requested_by"])
        .where("task_id", "=", b.taskId)
        .orderBy("round")
        .execute();
      assert.equal(rounds.length, 2, "two automatic fix rounds");
      assert.deepEqual(
        rounds.map((r) => [r.round, r.source, r.from_commit, r.requested_by]),
        [
          [1, "verifier", commits[0], null],
          [2, "verifier", commits[1], null],
        ],
      );
      assert.match(rounds[0]!.feedback, /SyntaxError/);
      assert.match(rounds[0]!.feedback, /Failed checks: browser/);
    } finally {
      await db.updateTable("tasks").set({ status: "CANCELLED" }).where("id", "=", b.taskId).where("status", "=", "QUEUED").execute();
    }
  });

  test("a worker can never act as the verifier", async () => {
    const asWorker = await app.inject({ method: "POST", url: "/internal/verifications/claim", headers: WORKER, payload: { verifierId: "x" } });
    assert.equal(asWorker.statusCode, 401);
    const report = await app.inject({
      method: "POST",
      url: `/internal/verifications/${randomUUID()}/result`,
      headers: WORKER,
      payload: { verifierId: "x", outcome: "PASS", tests: [], evidence: {} },
    });
    assert.equal(report.statusCode, 401);

    // And a deployment that gives both the same token gets no verifier at all.
    const saved = process.env.VERIFIER_API_TOKEN;
    process.env.VERIFIER_API_TOKEN = process.env.INTERNAL_API_TOKEN;
    try {
      const shared = await app.inject({ method: "POST", url: "/internal/verifications/claim", headers: WORKER, payload: { verifierId: "x" } });
      assert.equal(shared.statusCode, 401);
    } finally {
      process.env.VERIFIER_API_TOKEN = saved;
    }
  });
});
