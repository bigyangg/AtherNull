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

      // usage_events.created_at was renamed to recorded_at by
      // 0011_usage_metering.sql (Phase 4D.1) — recorded_at is still the
      // right column for "when was this usage recorded" (DB insert time),
      // distinct from the new observed_at (when the worker polled and first
      // saw it) — see that migration's own comment for the full split.
      const dailyRows = await db
        .selectFrom("tasks")
        .innerJoin("executions", "executions.task_id", "tasks.id")
        .innerJoin("usage_events", "usage_events.execution_id", "executions.id")
        .select(({ fn }) => [
          sql<string>`date_trunc('day', usage_events.recorded_at)`.as("day"),
          fn.sum<string>("usage_events.cost_minor").as("spent"),
        ])
        .where("tasks.organization_id", "=", organizationId)
        .where("usage_events.recorded_at", ">=", sql<Date>`now() - interval '14 days'`)
        .groupBy(sql`date_trunc('day', usage_events.recorded_at)`)
        .orderBy(sql`date_trunc('day', usage_events.recorded_at)`, "asc")
        .execute();

      const statusRows = await db
        .selectFrom("tasks")
        .select(({ fn }) => ["status", fn.count<string>("id").as("count")])
        .where("organization_id", "=", organizationId)
        .groupBy("status")
        .execute();

      // Phase 4D.1 — real usage metering. Additive sibling fields alongside
      // the existing envelope above (left untouched: totalSpentMinor/
      // dailySpend/taskCountsByStatus keep their pre-existing shape and
      // computation). `usage` is the org-wide raw token aggregate now that
      // usage_events actually has writers; `pricing` makes explicit what was
      // previously only implicit (totalSpentMinor being permanently 0 because
      // nothing had ever priced anything) — always UNPRICED in this phase,
      // since no rate card exists yet (apps/api/src/pricing/rates.ts).
      const usageRow = await db
        .selectFrom("tasks")
        .innerJoin("executions", "executions.task_id", "tasks.id")
        .innerJoin("usage_events", "usage_events.execution_id", "executions.id")
        .select(({ fn }) => [
          fn.coalesce(fn.sum<string>("usage_events.input_tokens"), sql<string>`0`).as("inputTokens"),
          fn.coalesce(fn.sum<string>("usage_events.output_tokens"), sql<string>`0`).as("outputTokens"),
          fn.coalesce(fn.sum<string>("usage_events.cache_read_tokens"), sql<string>`0`).as("cacheReadTokens"),
          fn.coalesce(fn.sum<string>("usage_events.cache_write_tokens"), sql<string>`0`).as("cacheWriteTokens"),
          fn.coalesce(fn.sum<string>("usage_events.reasoning_tokens"), sql<string>`0`).as("reasoningTokens"),
          fn.coalesce(fn.sum<string>("usage_events.total_tokens"), sql<string>`0`).as("totalTokens"),
        ])
        .where("tasks.organization_id", "=", organizationId)
        .executeTakeFirstOrThrow();

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
        usage: {
          inputTokens: Number(usageRow.inputTokens),
          outputTokens: Number(usageRow.outputTokens),
          cacheReadTokens: Number(usageRow.cacheReadTokens),
          cacheWriteTokens: Number(usageRow.cacheWriteTokens),
          reasoningTokens: Number(usageRow.reasoningTokens),
          totalTokens: Number(usageRow.totalTokens),
        },
        pricing: { status: "UNPRICED", amountMinor: null, currency: null },
      });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
