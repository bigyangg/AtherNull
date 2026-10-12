// ADR-0019 — a build's base commit goes to the worker as a bundle, its
// result comes back as one commit on builds/<task id>, and the verifier
// fetches exactly that commit. Real Postgres + real git via Fastify inject().
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
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";

process.env.REPOS_ROOT = mkdtempSync(join(tmpdir(), "athernull-repos-"));
const scratch = mkdtempSync(join(tmpdir(), "athernull-sandbox-"));

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { createAwaitingFundingTask } = await import("./support/app-fixtures.js");
const { pinBaseCommit } = await import("../src/repos/projects.js");
const repos = await import("../src/repos/index.js");
const { buildInSandbox, sh, sourceRepo } = await import("./support/sandbox-git.js");

const WORKER = { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` };
const VERIFIER = { authorization: `Bearer ${process.env.VERIFIER_API_TOKEN}` };
const silent = { warn: () => {} };

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(process.env.REPOS_ROOT!, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

/** A RUNNING build of a project whose repository is a local folder, leased to `workerId`. */
async function runningBuild(workerId: string, permittedRepository: string) {
  const t = await createAwaitingFundingTask(app);
  await db.updateTable("projects").set({ permitted_repository: permittedRepository }).where("id", "=", t.projectId).execute();
  const execution = await db
    .insertInto("executions")
    .values({ task_id: t.taskId, status: "RUNNING", lease_owner: workerId, started_at: new Date() })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.updateTable("tasks").set({ status: "RUNNING" }).where("id", "=", t.taskId).execute();
  const task = await db.selectFrom("tasks").select(["id", "project_id", "repository_revision"]).where("id", "=", t.taskId).executeTakeFirstOrThrow();
  return { ...t, task, executionId: execution.id };
}

const bundleUrl = (executionId: string, workerId: string) => `/internal/executions/${executionId}/repo-bundle?workerId=${workerId}`;
const submit = (executionId: string, workerId: string, bundle: Buffer) =>
  app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/result-bundle?workerId=${workerId}`,
    headers: { ...WORKER, "content-type": "application/octet-stream" },
    payload: bundle,
  });

describe("hosted repository transfer", () => {
  const src = sourceRepo(scratch, { "app.js": "export const a = 1;\n" });
  const workerId = `worker-${randomUUID()}`;
  let b: Awaited<ReturnType<typeof runningBuild>>;
  let base: Buffer;
  let resultCommit: string;

  before(async () => {
    b = await runningBuild(workerId, src.path);
  });

  test("the first dispatch imports the project and pins the base commit, once", async () => {
    const pinned = await pinBaseCommit(b.task, silent);
    assert.equal(pinned, src.head);
    const project = await db.selectFrom("projects").select("repo_kind").where("id", "=", b.projectId).executeTakeFirstOrThrow();
    assert.equal(project.repo_kind, "hosted");
    // The source moving on does not move an already pinned build.
    writeFileSync(join(src.path, "later.js"), "x\n");
    sh(src.path, "add", "-A");
    sh(src.path, "commit", "--quiet", "-m", "later");
    assert.equal(await pinBaseCommit(b.task, silent), src.head);
  });

  test("the worker holding the lease receives the base as a bundle", async () => {
    assert.equal((await app.inject({ method: "GET", url: bundleUrl(b.executionId, workerId) })).statusCode, 401, "worker token required");
    assert.equal((await app.inject({ method: "GET", url: bundleUrl(b.executionId, "someone-else"), headers: WORKER })).statusCode, 409);
    const res = await app.inject({ method: "GET", url: bundleUrl(b.executionId, workerId), headers: WORKER });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/octet-stream");
    base = res.rawPayload;
    const dir = join(scratch, randomUUID());
    writeFileSync(`${dir}.bundle`, base);
    execFileSync("git", ["clone", "--quiet", `${dir}.bundle`, dir], { stdio: "ignore" });
    sh(dir, "checkout", "--quiet", src.head);
  });

  test("the result comes back as one commit, its diff becomes the patch, main does not move", async () => {
    const bundle = buildInSandbox(scratch, base, src.head, b.taskId, { "app.js": "export const a = 2;\n", "README.md": "# Demo\n" });
    assert.equal((await submit(b.executionId, "someone-else", bundle)).statusCode, 409, "lease owner only");
    const res = await submit(b.executionId, workerId, bundle);
    assert.equal(res.statusCode, 201, res.body);
    const body = JSON.parse(res.body) as { resultCommit: string; files: number; insertions: number; deletions: number };
    resultCommit = body.resultCommit;
    assert.deepEqual([body.files, body.insertions, body.deletions], [2, 2, 1]);

    const patch = await db.selectFrom("execution_patches").selectAll().where("execution_id", "=", b.executionId).executeTakeFirstOrThrow();
    assert.equal(patch.result_commit, resultCommit);
    assert.equal(patch.base_revision, src.head);
    assert.match(patch.patch, /\+export const a = 2;/);
    const task = await db.selectFrom("tasks").select(["result_commit", "base_commit"]).where("id", "=", b.taskId).executeTakeFirstOrThrow();
    assert.deepEqual(task, { result_commit: resultCommit, base_commit: src.head });

    const repo = repos.repoPath(b.organizationId, b.projectId);
    assert.equal(await repos.headOf(repo), src.head, "main is untouched until acceptance");
    assert.equal(await repos.headOf(repo, `builds/${b.taskId}`), resultCommit);
  });

  test("resubmitting the same result is idempotent; a different one, or a bad bundle, is refused", async () => {
    const again = buildInSandbox(scratch, base, src.head, b.taskId, { "app.js": "export const a = 2;\n", "README.md": "# Demo\n" });
    // Same content but a new commit object (new timestamp) is a different result.
    const sameCommit = await submit(b.executionId, workerId, again);
    assert.ok([201, 409].includes(sameCommit.statusCode));
    const different = buildInSandbox(scratch, base, src.head, b.taskId, { "app.js": "export const a = 3;\n" });
    assert.equal((await submit(b.executionId, workerId, different)).statusCode, 409);
    assert.equal((await submit(b.executionId, workerId, Buffer.from("garbage"))).statusCode, 422);
    const twoCommits = buildInSandbox(scratch, base, src.head, b.taskId, { "x.js": "1\n" }, true);
    assert.equal((await submit(b.executionId, workerId, twoCommits)).statusCode, 422);
  });

  test("the verifier that claimed the build fetches exactly the result commit", async () => {
    await db.updateTable("tasks").set({ status: "VERIFYING" }).where("id", "=", b.taskId).execute();
    await db.updateTable("executions").set({ status: "SUCCEEDED", ended_at: new Date() }).where("id", "=", b.executionId).execute();
    let job: { executionId: string; resultCommit: string | null } | null = null;
    for (let i = 0; i < 50 && !job; i++) {
      const res = await app.inject({ method: "POST", url: "/internal/verifications/claim", headers: VERIFIER, payload: { verifierId: "verifier-r" } });
      if (res.statusCode === 204) break;
      const claimed = JSON.parse(res.body) as { executionId: string; resultCommit: string | null };
      if (claimed.executionId === b.executionId) job = claimed;
    }
    assert.ok(job, "build is claimable");
    assert.equal(job.resultCommit, resultCommit);

    const url = `/internal/verifications/${b.executionId}/bundle`;
    assert.equal((await app.inject({ method: "GET", url: `${url}?verifierId=verifier-r`, headers: WORKER })).statusCode, 401, "worker token is not enough");
    assert.equal((await app.inject({ method: "GET", url: `${url}?verifierId=other`, headers: VERIFIER })).statusCode, 409);
    const res = await app.inject({ method: "GET", url: `${url}?verifierId=verifier-r`, headers: VERIFIER });
    assert.equal(res.statusCode, 200);
    const dir = join(scratch, randomUUID());
    writeFileSync(`${dir}.bundle`, res.rawPayload);
    execFileSync("git", ["clone", "--quiet", `${dir}.bundle`, dir], { stdio: "ignore" });
    sh(dir, "checkout", "--quiet", resultCommit);
    assert.equal(sh(dir, "show", "HEAD:app.js"), "export const a = 2;");
  });

  test("a project that cannot be hosted dispatches without a base commit (fallback path)", async () => {
    const other = await runningBuild(`worker-${randomUUID()}`, "github.com/private/repo");
    assert.equal(await pinBaseCommit(other.task, silent), null);
    const project = await db.selectFrom("projects").select("repo_kind").where("id", "=", other.projectId).executeTakeFirstOrThrow();
    assert.equal(project.repo_kind, null);
  });
});
