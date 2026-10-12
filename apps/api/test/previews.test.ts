// Live previews (routes/previews.ts): only the verifier holding the lease
// can publish; only verified builds are served; every response is sandboxed
// so customer code never runs with AtherNull's origin. Real Postgres via
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
process.env.VERIFIER_API_TOKEN = "test-verifier-token-not-for-real-use";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";

const previewsDir = mkdtempSync(join(tmpdir(), "athernull-previews-"));
process.env.PREVIEWS_ROOT = previewsDir;

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { safePreviewPath } = await import("../src/routes/previews.js");
const { createAwaitingFundingTask } = await import("./support/app-fixtures.js");

const VERIFIER = { authorization: `Bearer ${process.env.VERIFIER_API_TOKEN}` };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const SITE = [
  { path: "index.html", content: b64('<!doctype html><script type="module" src="./assets/app.js"></script><h1>Calculator</h1>') },
  { path: "assets/app.js", content: b64("document.title = 'calc';") },
];

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(previewsDir, { recursive: true, force: true });
});

/** A VERIFYING task whose patch is claimed by `verifierId`. */
async function claimedBuild(verifierId: string) {
  const t = await createAwaitingFundingTask(app);
  const execution = await db
    .insertInto("executions")
    .values({ task_id: t.taskId, status: "SUCCEEDED", lease_owner: "w", started_at: new Date(), ended_at: new Date() })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.updateTable("tasks").set({ status: "VERIFYING" }).where("id", "=", t.taskId).execute();
  await db
    .insertInto("execution_patches")
    .values({
      execution_id: execution.id,
      task_id: t.taskId,
      organization_id: t.organizationId,
      base_revision: "abc123",
      patch: "diff",
      sha256: "0".repeat(64),
      files_changed: 1,
      insertions: 1,
      deletions: 0,
      verify_lease_owner: verifierId,
      verify_lease_expires_at: new Date(Date.now() + 60_000),
    })
    .execute();
  return { taskId: t.taskId, executionId: execution.id };
}

const publish = (executionId: string, verifierId: string, files = SITE, headers = VERIFIER) =>
  app.inject({ method: "POST", url: `/internal/verifications/${executionId}/preview`, headers, payload: { verifierId, files } });

describe("live previews", () => {
  test("paths that could escape the preview are refused", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "a\\b", "C:/x", "a//b", "./a", ""]) {
      assert.equal(safePreviewPath(bad), null, bad);
    }
    assert.equal(safePreviewPath("assets/app.js"), "assets/app.js");
  });

  test("only the verifier holding the lease can publish, with an index.html and safe paths", async () => {
    const { executionId } = await claimedBuild("verifier-a");
    assert.equal((await publish(executionId, "verifier-a", SITE, { authorization: "Bearer wrong" })).statusCode, 401);
    assert.equal((await publish(executionId, "verifier-b")).statusCode, 409);
    assert.equal((await publish(executionId, "verifier-a", [{ path: "app.js", content: b64("x") }])).statusCode, 400);
    assert.equal((await publish(executionId, "verifier-a", [...SITE, { path: "../evil.html", content: b64("x") }])).statusCode, 400);
    const ok = await publish(executionId, "verifier-a");
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(JSON.parse(ok.body).files, 2);
  });

  test("served only once verified, always sandboxed, with SPA fallback and no traversal", async () => {
    const { taskId, executionId } = await claimedBuild("verifier-c");
    assert.equal((await publish(executionId, "verifier-c")).statusCode, 200);

    // Still VERIFYING: not visible yet.
    assert.equal((await app.inject({ method: "GET", url: `/preview/${taskId}/` })).statusCode, 404);

    await db.updateTable("tasks").set({ status: "AWAITING_ACCEPTANCE" }).where("id", "=", taskId).execute();
    const page = await app.inject({ method: "GET", url: `/preview/${taskId}/` });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] as string, /text\/html/);
    assert.match(page.body, /Calculator/);
    const csp = page.headers["content-security-policy"] as string;
    assert.match(csp, /^sandbox /);
    assert.doesNotMatch(csp, /allow-same-origin/, "the app must run in an opaque origin");
    assert.equal(page.headers["x-content-type-options"], "nosniff");

    const js = await app.inject({ method: "GET", url: `/preview/${taskId}/assets/app.js` });
    assert.equal(js.statusCode, 200);
    assert.match(js.headers["content-type"] as string, /javascript/);
    assert.equal(js.headers["access-control-allow-origin"], "*");

    assert.match((await app.inject({ method: "GET", url: `/preview/${taskId}/some/route` })).body, /Calculator/);
    assert.equal((await app.inject({ method: "GET", url: `/preview/${taskId}/missing.js` })).statusCode, 404);
    assert.notEqual((await app.inject({ method: "GET", url: `/preview/${taskId}/..%2F..%2Fpackage.json` })).statusCode, 200);

    const bare = await app.inject({ method: "GET", url: `/preview/${taskId}` });
    assert.equal(bare.statusCode, 308);
    assert.equal(bare.headers.location, `/preview/${taskId}/`);
  });

  test("a build that failed or was rejected shows no preview", async () => {
    const { taskId, executionId } = await claimedBuild("verifier-d");
    assert.equal((await publish(executionId, "verifier-d")).statusCode, 200);
    await db.updateTable("tasks").set({ status: "FAILED" }).where("id", "=", taskId).execute();
    assert.equal((await app.inject({ method: "GET", url: `/preview/${taskId}/` })).statusCode, 404);
  });
});
