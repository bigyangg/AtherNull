import type { FastifyInstance } from "fastify";
import { sql } from "kysely";

import { db } from "../db.js";
import { requireOrgSession, sendHttpError } from "../session.js";

// Org-level rollup on top of usage_events, which until now was only ever
// queried per-task (jobs.ts's GET /v1/jobs/:id spend calculation). Same
// leftJoin + coalesce shape as that query, just scoped by organization_id
// instead of a single task_id.
export async function usageRoutes(app: FastifyInstance) {
  app.get("/v1/usage/summary", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);

      const totalRow = await db
        .selectFrom("tasks")
        .innerJoin("executions", "executions.task_id", "tasks.id")
        .leftJoin("usage_events", "usage_events.execution_id", "executions.id")
        .select(({ fn }) => [
          fn.coalesce(fn.sum<string>("usage_events.cost_minor"), sql<string>`0`).as("total"),
        ])
        .where("tasks.organization_id", "=", organizationId)
        .executeTakeFirstOrThrow();

      const dailyRows = await db
        .selectFrom("tasks")
        .innerJoin("executions", "executions.task_id", "tasks.id")
        .innerJoin("usage_events", "usage_events.execution_id", "executions.id")
        .select(({ fn }) => [
          sql<string>`date_trunc('day', usage_events.created_at)`.as("day"),
          fn.sum<string>("usage_events.cost_minor").as("spent"),
        ])
        .where("tasks.organization_id", "=", organizationId)
        .where("usage_events.created_at", ">=", sql<Date>`now() - interval '14 days'`)
        .groupBy(sql`date_trunc('day', usage_events.created_at)`)
        .orderBy(sql`date_trunc('day', usage_events.created_at)`, "asc")
        .execute();

      const statusRows = await db
        .selectFrom("tasks")
        .select(({ fn }) => ["status", fn.count<string>("id").as("count")])
        .where("organization_id", "=", organizationId)
        .groupBy("status")
        .execute();

      reply.send({
        totalSpentMinor: Number(totalRow.total),
        currency: "usd",
        dailySpend: dailyRows.map((row) => ({
          date: new Date(row.day).toISOString(),
          spentMinor: Number(row.spent),
        })),
        taskCountsByStatus: Object.fromEntries(
          statusRows.map((row) => [row.status, Number(row.count)]),
        ),
      });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
