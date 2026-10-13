// Delivery (routes/delivery.ts): the accepted build's code as a zip, only
// after acceptance and only for the build's own organization. Real Postgres
// and a real hosted git repository.
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";

process.env.REPOS_ROOT = mkdtempSync(join(tmpdir(), "athernull-delivery-"));

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { createRepo, repoPath } = await import("../src/repos/index.js");
const { createAwaitingFundingTask, signUpVerifiedAndSignIn } = await import("./support/app-fixtures.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(process.env.REPOS_ROOT!, { recursive: true, force: true });
});

/** A build whose hosted repository holds `commit` as its result, in `status`. */
async function deliveredBuild(status: string) {
  const t = await createAwaitingFundingTask(app);
  const commit = await createRepo(repoPath(t.organizationId, t.projectId), "Calculator");
  await db.updateTable("projects").set({ repo_kind: "hosted" }).where("id", "=", t.projectId).execute();
  await db.updateTable("tasks").set({ status: "CANCELLED", result_commit: commit }).where("id", "=", t.taskId).execute();
  await db.updateTable("tasks").set({ status }).where("id", "=", t.taskId).execute();
  return t;
}

const download = (taskId: string, cookie: string) => app.inject({ method: "GET", url: `/v1/jobs/${taskId}/download`, headers: { cookie } });

describe("delivery", () => {
  test("an accepted build downloads as a zip of the delivered project", async () => {
    const b = await deliveredBuild("SETTLED");
    const res = await download(b.taskId, b.jar.header);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["content-type"], "application/zip");
    assert.match(String(res.headers["content-disposition"]), /attachment; filename=".+\.zip"/);
    const zip = res.rawPayload;
    assert.equal(zip.subarray(0, 2).toString("latin1"), "PK", "a zip archive");
    assert.ok(zip.includes(Buffer.from("README.md")), "contains the project's files");
  });

  test("before acceptance there is only the preview, not the code", async () => {
    for (const status of ["AWAITING_ACCEPTANCE", "VERIFYING", "REJECTED", "REFUNDED"]) {
      const b = await deliveredBuild(status);
      assert.equal((await download(b.taskId, b.jar.header)).statusCode, 409, status);
    }
  });

  test("another organization cannot download it", async () => {
    const b = await deliveredBuild("SETTLED");
    const stranger = await signUpVerifiedAndSignIn(app, `stranger-${randomUUID()}@example.com`, "correct horse battery", "Stranger");
    assert.equal((await download(b.taskId, stranger.jar.header)).statusCode, 404);
  });
});
