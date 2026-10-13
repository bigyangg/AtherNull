// Phase 4 — independent verification (ADR-0017).
//
//   worker   -> POST /internal/executions/:id/patch        (worker token + lease)
//   verifier -> POST /internal/verifications/claim         (verifier token)
//   verifier -> POST /internal/verifications/:id/result    (verifier token + claim)
//
// The verifier authenticates with its OWN token (VERIFIER_API_TOKEN), which
// must differ from the worker's: a worker can submit its patch but can never
// report a verification, so it cannot approve its own work (PLAN.md §1).
// The verifier only ever receives the patch and the approved revision —
// never the worker's success claim or the agent's own test output.

import { createHash } from "node:crypto";

import { assertTransition, type TaskStatus } from "@athernull/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";

import { db } from "../db.js";
import { requireInternalToken } from "../internal-auth.js";
import { requireOrgSession, sendHttpError } from "../session.js";

export const VERIFIER_VERSION = "athernull-verifier/1";
const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const VERIFY_LEASE_SECONDS = Number(process.env.VERIFY_LEASE_SECONDS ?? 900);

export function requireVerifierToken(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = process.env.VERIFIER_API_TOKEN;
  const header = request.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : null;
  // Fail closed if the verifier and worker share a credential.
  if (!expected || expected === process.env.INTERNAL_API_TOKEN || !provided || provided !== expected) {
    reply.status(401).send({ error: "Invalid or missing verifier token" });
    return false;
  }
  return true;
}

export function patchStats(patch: string) {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { files, insertions, deletions };
}

const PatchBody = z.object({
  workerId: z.string().min(1),
  baseRevision: z.string().min(1),
  patch: z.string(),
});

const ResultBody = z.object({
  verifierId: z.string().min(1),
  outcome: z.enum(["PASS", "FAIL"]),
  tests: z.array(z.object({ name: z.string().max(500), passed: z.boolean() })).max(2000),
  evidence: z.record(z.string(), z.unknown()),
});

/** Automatic fix rounds per build after a failed verification. */
export const MAX_AUTO_FIX_ROUNDS = Number(process.env.MAX_AUTO_FIX_ROUNDS ?? 2);

/** What the agent is told to fix: the verifier's reason, the failed checks
 *  and the end of the test output — never more than the column allows. */
export function verifierFeedback(body: z.infer<typeof ResultBody>): string {
  const lines = ["The independent checks rejected the previous version."];
  if (typeof body.evidence.reason === "string") lines.push(`Reason: ${body.evidence.reason}`);
  const failed = body.tests.filter((t) => !t.passed).map((t) => t.name);
  if (failed.length) lines.push(`Failed checks: ${failed.slice(0, 20).join("; ")}`);
  if (typeof body.evidence.logTail === "string" && body.evidence.logTail.trim()) {
    lines.push(`End of the test output:\n${body.evidence.logTail.trim().slice(-1500)}`);
  }
  return lines.join("\n").slice(0, 4000);
}

export async function verificationRoutes(app: FastifyInstance) {
  // The exact change under review for a build (its latest captured patch):
  // what the verifier tested and what the customer is accepting.
  app.get("/v1/jobs/:id/patch", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const row = await db
        .selectFrom("execution_patches")
        .select(["execution_id", "base_revision", "patch", "sha256", "files_changed", "insertions", "deletions", "created_at"])
        .where("task_id", "=", id)
        .where("organization_id", "=", organizationId)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!row) {
        reply.status(404).send({ error: "No captured change for this build" });
        return;
      }
      reply.send({
        executionId: row.execution_id,
        baseRevision: row.base_revision,
        patch: row.patch,
        sha256: row.sha256,
        filesChanged: row.files_changed,
        insertions: row.insertions,
        deletions: row.deletions,
        capturedAt: row.created_at.toISOString(),
      });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  // The agent's change for this execution, captured by the worker after the
  // run. Idempotent for the same patch; a different patch is refused.
  app.post("/internal/executions/:id/patch", { bodyLimit: MAX_PATCH_BYTES + 64 * 1024 }, async (request, reply) => {
    if (!requireInternalToken(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = PatchBody.parse(request.body);
    if (Buffer.byteLength(body.patch) > MAX_PATCH_BYTES) {
      reply.status(413).send({ error: "Patch too large" });
      return;
    }
    const execution = await db
      .selectFrom("executions")
      .innerJoin("tasks", "tasks.id", "executions.task_id")
      .select(["executions.id", "executions.lease_owner", "executions.task_id", "tasks.organization_id"])
      .where("executions.id", "=", id)
      .executeTakeFirst();
    if (!execution) {
      reply.status(404).send({ error: "Not found" });
      return;
    }
    if (execution.lease_owner !== body.workerId) {
      reply.status(409).send({ error: "Lease no longer owned by this worker" });
      return;
    }
    const sha256 = createHash("sha256").update(body.patch).digest("hex");
    const stats = patchStats(body.patch);
    const inserted = await db
      .insertInto("execution_patches")
      .values({
        execution_id: id,
        task_id: execution.task_id,
        organization_id: execution.organization_id,
        base_revision: body.baseRevision,
        patch: body.patch,
        sha256,
        files_changed: stats.files,
        insertions: stats.insertions,
        deletions: stats.deletions,
      })
      .onConflict((oc) => oc.column("execution_id").doNothing())
      .returning("sha256")
      .executeTakeFirst();
    if (!inserted) {
      const existing = await db.selectFrom("execution_patches").select("sha256").where("execution_id", "=", id).executeTakeFirstOrThrow();
      if (existing.sha256 !== sha256) {
        reply.status(409).send({ error: "A different patch was already captured for this execution" });
        return;
      }
    }
    reply.status(201).send({ sha256, ...stats });
  });

  // Next build awaiting verification: VERIFYING, its latest execution has a
  // captured patch, no verification run yet, and no live claim.
  app.post("/internal/verifications/claim", async (request, reply) => {
    if (!requireVerifierToken(request, reply)) return;
    const { verifierId } = z.object({ verifierId: z.string().min(1) }).parse(request.body);

    const job = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("execution_patches as p")
        .innerJoin("tasks as t", "t.id", "p.task_id")
        .innerJoin("projects as pr", "pr.id", "t.project_id")
        .select([
          "p.execution_id",
          "p.task_id",
          "p.organization_id",
          "p.base_revision",
          "p.patch",
          "p.sha256",
          "p.result_commit",
          "t.acceptance_criteria",
          "pr.permitted_repository",
        ])
        .where("t.status", "=", "VERIFYING")
        .where((eb) => eb.or([eb("p.verify_lease_expires_at", "is", null), eb("p.verify_lease_expires_at", "<", new Date())]))
        .where(({ not, exists, selectFrom }) =>
          not(exists(selectFrom("verification_runs as v").select("v.id").whereRef("v.execution_id", "=", "p.execution_id"))),
        )
        // Only the task's latest execution is the one under review.
        .where(({ eb, selectFrom }) =>
          eb(
            "p.execution_id",
            "=",
            selectFrom("executions as e").select("e.id").whereRef("e.task_id", "=", "p.task_id").orderBy("e.created_at", "desc").limit(1),
          ),
        )
        .orderBy("p.created_at", "asc")
        .limit(1)
        .forUpdate("p")
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;
      await trx
        .updateTable("execution_patches")
        .set({
          verify_lease_owner: verifierId,
          verify_lease_expires_at: sql<Date>`now() + make_interval(secs => ${VERIFY_LEASE_SECONDS})`,
        })
        .where("execution_id", "=", row.execution_id)
        .execute();
      return row;
    });

    if (!job) {
      reply.status(204).send();
      return;
    }
    reply.send({
      executionId: job.execution_id,
      taskId: job.task_id,
      organizationId: job.organization_id,
      repository: job.permitted_repository,
      baseRevision: job.base_revision,
      patch: job.patch,
      patchSha256: job.sha256,
      // ADR-0019: when set, fetch this exact commit (GET
      // /internal/verifications/:id/bundle) instead of applying the patch.
      resultCommit: job.result_commit,
      acceptanceCriteria: Array.isArray(job.acceptance_criteria) ? job.acceptance_criteria : [],
      leaseSeconds: VERIFY_LEASE_SECONDS,
    });
  });

  // The verifier's verdict: records the run and moves the task out of
  // VERIFYING, exactly once. PASS -> AWAITING_ACCEPTANCE. FAIL -> QUEUED for
  // an automatic fix round while any are left (the verifier's findings go
  // back to the agent, continuing from the failed version), else FAILED.
  app.post("/internal/verifications/:executionId/result", async (request, reply) => {
    if (!requireVerifierToken(request, reply)) return;
    const { executionId } = z.object({ executionId: z.string() }).parse(request.params);
    const body = ResultBody.parse(request.body);

    const result = await db.transaction().execute(async (trx) => {
      const patch = await trx
        .selectFrom("execution_patches")
        .selectAll()
        .where("execution_id", "=", executionId)
        .forUpdate()
        .executeTakeFirst();
      if (!patch) return { status: 404 as const, error: "Not found" };
      if (patch.verify_lease_owner !== body.verifierId) return { status: 409 as const, error: "Verification is not claimed by this verifier" };

      const task = await trx.selectFrom("tasks").selectAll().where("id", "=", patch.task_id).forUpdate().executeTakeFirstOrThrow();
      if (task.status !== "VERIFYING") return { status: 409 as const, error: "Task is not awaiting verification" };

      let next: TaskStatus = body.outcome === "PASS" ? "AWAITING_ACCEPTANCE" : "FAILED";
      if (body.outcome === "FAIL" && patch.result_commit) {
        const rounds = await trx
          .selectFrom("task_change_requests")
          .select(["round", "source"])
          .where("task_id", "=", task.id)
          .execute();
        const autoFixes = rounds.filter((r) => r.source === "verifier").length;
        if (autoFixes < MAX_AUTO_FIX_ROUNDS) {
          await trx
            .insertInto("task_change_requests")
            .values({
              task_id: task.id,
              organization_id: task.organization_id,
              round: Math.max(0, ...rounds.map((r) => r.round)) + 1,
              feedback: verifierFeedback(body),
              from_commit: patch.result_commit,
              requested_by: null,
              source: "verifier",
            })
            .execute();
          next = "QUEUED";
        }
      }
      assertTransition("VERIFYING", next);

      await trx
        .insertInto("verification_runs")
        .values({
          task_id: task.id,
          execution_id: executionId,
          artifact_hash: patch.sha256,
          verifier_version: VERIFIER_VERSION,
          tests: JSON.stringify(body.tests),
          outcome: body.outcome,
          evidence: JSON.stringify({ ...body.evidence, independent: true }),
        })
        .execute();
      await trx
        .updateTable("tasks")
        .set({ status: next, version: task.version + 1, updated_at: new Date() })
        .where("id", "=", task.id)
        .where("status", "=", "VERIFYING")
        .where("version", "=", task.version)
        .execute();
      await trx
        .updateTable("execution_patches")
        .set({ verify_lease_owner: null, verify_lease_expires_at: null })
        .where("execution_id", "=", executionId)
        .execute();
      return { status: 200 as const, taskStatus: next };
    });

    if (result.status !== 200) {
      reply.status(result.status).send({ error: result.error });
      return;
    }
    reply.send({ taskStatus: result.taskStatus });
  });
}
