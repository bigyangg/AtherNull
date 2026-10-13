// ADR-0019 — code moves between the hosted repositories and sandboxes as
// git bundles, carried by the worker; no sandbox ever holds a repository
// credential.
//
//   worker   -> GET  /internal/executions/:id/repo-bundle    (worker token + lease)
//   worker   -> POST /internal/executions/:id/result-bundle  (worker token + lease)
//   verifier -> GET  /internal/verifications/:id/bundle      (verifier token + claim)

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { requireInternalToken } from "../internal-auth.js";
import { BundleRejected, bundleOf, diffOf, receiveBuildBundle, repoPath, withRepoLock } from "../repos/index.js";
import { requireVerifierToken } from "./verification.js";

const MAX_BUNDLE_BYTES = Number(process.env.MAX_RESULT_BUNDLE_BYTES ?? 50 * 1024 * 1024);
const MAX_PATCH_BYTES = 5 * 1024 * 1024;

const WorkerQuery = z.object({ workerId: z.string().min(1) });
const VerifierQuery = z.object({ verifierId: z.string().min(1) });

/** The execution and its task, if this worker still holds the lease. */
async function leasedExecution(id: string, workerId: string, reply: FastifyReply) {
  const row = await db
    .selectFrom("executions")
    .innerJoin("tasks", "tasks.id", "executions.task_id")
    .innerJoin("projects", "projects.id", "tasks.project_id")
    .select([
      "executions.id",
      "executions.lease_owner",
      "tasks.id as task_id",
      "tasks.organization_id",
      "tasks.project_id",
      "tasks.base_commit",
      "projects.repo_kind",
    ])
    .where("executions.id", "=", id)
    .executeTakeFirst();
  if (!row) {
    reply.status(404).send({ error: "Not found" });
    return null;
  }
  if (row.lease_owner !== workerId) {
    reply.status(409).send({ error: "Lease no longer owned by this worker" });
    return null;
  }
  if (!row.base_commit || row.repo_kind !== "hosted") {
    reply.status(409).send({ error: "This build has no hosted repository" });
    return null;
  }
  return { ...row, base_commit: row.base_commit, repo: repoPath(row.organization_id, row.project_id) };
}

function sendBundle(reply: FastifyReply, bundle: Buffer) {
  reply.header("content-type", "application/octet-stream").header("content-length", bundle.length).send(bundle);
}

export async function repoTransferRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_BUNDLE_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  // The build's base commit, for the worker to load into the sandbox.
  app.get("/internal/executions/:id/repo-bundle", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId } = WorkerQuery.parse(request.query);
    const execution = await leasedExecution(id, workerId, reply);
    if (!execution) return;
    // A change round continues from the delivered version; its history
    // includes the base, so the worker can still squash onto the base.
    const latestChange = await db
      .selectFrom("task_change_requests")
      .select("from_commit")
      .where("task_id", "=", execution.task_id)
      .orderBy("round", "desc")
      .limit(1)
      .executeTakeFirst();
    sendBundle(reply, await bundleOf(execution.repo, latestChange?.from_commit ?? execution.base_commit));
  });

  // The build's result: one commit on builds/<task id> on top of its base.
  // Stored on that branch (never main), and its diff recorded as the
  // execution's patch (ADR-0017) with the commit the verifier will check out.
  app.post("/internal/executions/:id/result-bundle", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { workerId } = WorkerQuery.parse(request.query);
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      reply.status(400).send({ error: "Expected a git bundle (application/octet-stream)" });
      return;
    }
    const bundle = request.body;
    const execution = await leasedExecution(id, workerId, reply);
    if (!execution) return;

    let resultCommit: string;
    let diff: Awaited<ReturnType<typeof diffOf>>;
    try {
      ({ resultCommit, diff } = await withRepoLock(execution.project_id, async () => {
        const commit = await receiveBuildBundle(execution.repo, bundle, `builds/${execution.task_id}`, execution.base_commit);
        return { resultCommit: commit, diff: await diffOf(execution.repo, execution.base_commit, commit) };
      }));
    } catch (err) {
      if (err instanceof BundleRejected) {
        reply.status(422).send({ error: err.message });
        return;
      }
      throw err;
    }
    if (Buffer.byteLength(diff.patch) > MAX_PATCH_BYTES) {
      reply.status(413).send({ error: "The build's change is too large to review" });
      return;
    }

    const sha256 = createHash("sha256").update(diff.patch).digest("hex");
    const inserted = await db
      .insertInto("execution_patches")
      .values({
        execution_id: execution.id,
        task_id: execution.task_id,
        organization_id: execution.organization_id,
        base_revision: execution.base_commit,
        patch: diff.patch,
        sha256,
        files_changed: diff.filesChanged,
        insertions: diff.insertions,
        deletions: diff.deletions,
        result_commit: resultCommit,
      })
      .onConflict((oc) => oc.column("execution_id").doNothing())
      .returning("sha256")
      .executeTakeFirst();
    if (!inserted) {
      const existing = await db
        .selectFrom("execution_patches")
        .select(["sha256", "result_commit"])
        .where("execution_id", "=", execution.id)
        .executeTakeFirstOrThrow();
      if (existing.result_commit !== resultCommit) {
        reply.status(409).send({ error: "A different result was already captured for this execution" });
        return;
      }
    }
    await db.updateTable("tasks").set({ result_commit: resultCommit }).where("id", "=", execution.task_id).execute();
    reply.status(201).send({
      resultCommit,
      sha256,
      files: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
    });
  });

  // The exact commit under verification, for the verifier that claimed it.
  app.get("/internal/verifications/:executionId/bundle", async (request, reply) => {
    if (!requireVerifierToken(request, reply)) return;
    const { executionId } = z.object({ executionId: z.string() }).parse(request.params);
    const { verifierId } = VerifierQuery.parse(request.query);
    const row = await db
      .selectFrom("execution_patches as p")
      .innerJoin("tasks as t", "t.id", "p.task_id")
      .select(["p.result_commit", "p.verify_lease_owner", "t.organization_id", "t.project_id"])
      .where("p.execution_id", "=", executionId)
      .executeTakeFirst();
    if (!row || !row.result_commit) {
      reply.status(404).send({ error: "Not found" });
      return;
    }
    if (row.verify_lease_owner !== verifierId) {
      reply.status(409).send({ error: "Verification not claimed by this verifier" });
      return;
    }
    sendBundle(reply, await bundleOf(repoPath(row.organization_id, row.project_id), row.result_commit));
  });
}
