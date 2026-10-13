// Request changes: a verified build goes back to the agent with the
// customer's feedback instead of only being accepted or rejected.
//
// AWAITING_ACCEPTANCE -> QUEUED, in one transaction with the change request
// row. The funding stays in escrow (nothing is settled or refunded), the next
// attempt continues from the delivered version (from_commit; see
// internal.ts's claim and repo-transfer.ts's repo bundle), and the result is
// verified again before it comes back for review. Rounds are capped so one
// payment cannot buy unlimited agent work.

import { assertTransition, type TaskStatus } from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";

export const MAX_CHANGE_ROUNDS = Number(process.env.MAX_CHANGE_ROUNDS ?? 2);

const Body = z.object({ feedback: z.string().trim().min(3, "Describe what should change").max(4000) });

export interface ChangeRequestView {
  round: number;
  feedback: string;
  createdAt: string;
}

/** A task's change requests, oldest first. */
export async function listChangeRequests(taskId: string): Promise<ChangeRequestView[]> {
  const rows = await db
    .selectFrom("task_change_requests")
    .select(["round", "feedback", "created_at"])
    .where("task_id", "=", taskId)
    .orderBy("round", "asc")
    .execute();
  return rows.map((r) => ({ round: r.round, feedback: r.feedback, createdAt: r.created_at.toISOString() }));
}

export async function changeRequestRoutes(app: FastifyInstance) {
  app.post("/v1/jobs/:id/request-changes", async (request, reply) => {
    try {
      const { organizationId, role, userId } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { feedback } = Body.parse(request.body);

      const result = await db.transaction().execute(async (trx) => {
        const task = await trx
          .selectFrom("tasks")
          .select(["id", "status", "version", "result_commit"])
          .where("id", "=", id)
          .where("organization_id", "=", organizationId)
          .forUpdate()
          .executeTakeFirst();
        if (!task) throw new HttpError(404, "Not found");
        if (task.status !== "AWAITING_ACCEPTANCE") {
          throw new HttpError(409, "Changes can only be requested while the build is ready for your review");
        }
        assertTransition(task.status as TaskStatus, "QUEUED");

        const { rounds } = await trx
          .selectFrom("task_change_requests")
          .select((eb) => eb.fn.countAll<string>().as("rounds"))
          .where("task_id", "=", task.id)
          .executeTakeFirstOrThrow();
        const used = Number(rounds);
        if (used >= MAX_CHANGE_ROUNDS) {
          throw new HttpError(409, `This build has used all ${MAX_CHANGE_ROUNDS} change rounds. Accept it, or reject it for a refund.`);
        }

        await trx
          .insertInto("task_change_requests")
          .values({
            task_id: task.id,
            organization_id: organizationId,
            round: used + 1,
            feedback,
            from_commit: task.result_commit,
            requested_by: userId,
          })
          .execute();

        const updated = await trx
          .updateTable("tasks")
          .set({ status: "QUEUED", version: task.version + 1, updated_at: new Date() })
          .where("id", "=", task.id)
          .where("status", "=", "AWAITING_ACCEPTANCE")
          .where("version", "=", task.version)
          .returning(["id", "status"])
          .executeTakeFirst();
        if (!updated) throw new HttpError(409, "The build changed while you were sending this; reload and try again");
        return { taskId: updated.id, status: updated.status, round: used + 1, roundsLeft: MAX_CHANGE_ROUNDS - used - 1 };
      });

      reply.status(201).send(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.issues[0]?.message ?? "Invalid request" });
        return;
      }
      // unique (task_id, round): a double submit lost the race.
      if ((err as { code?: string }).code === "23505") {
        reply.status(409).send({ error: "These changes were already requested" });
        return;
      }
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
