import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import type { EstimateResponse } from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  discussionPrompt,
  fetchTranscript,
  findDiscussion,
  markDiscussionPlanned,
} from "../agent-gateway/discussions.js";
import { loadOrgServer } from "../agent-gateway/org-server.js";
import { db } from "../db.js";
import { createRepo, repoPath } from "../repos/repos.js";
import { HttpError, requireOrgSession, sendHttpError } from "../session.js";
import { createEstimate, reviseEstimate, toEstimateResponse } from "./estimates.js";
import { listChangeRequests, MAX_CHANGE_ROUNDS } from "./change-requests.js";
import { hasPreview, PREVIEWABLE_STATUSES } from "./previews.js";

// Chat-native builds: the canvas discussion is where a build is planned,
// approved, billed and paid. These routes only draft and read; approval,
// the budget, the task, funding and activation still go through their own
// guarded endpoints (estimates, budget-authorizations, task-provenance,
// project-funding, jobs), which the in-chat card calls in order. Nothing
// here queues a build.

/** The spending cap a build gets when its plan has no priced range (no rate card yet). */
export function defaultBudget(): { amountMinor: number; currency: string } {
  const raw = Number(process.env.CHAT_BUILD_DEFAULT_BUDGET_MINOR ?? 2000);
  return {
    amountMinor: Number.isSafeInteger(raw) && raw > 0 ? raw : 2000,
    currency: (process.env.CHAT_BUILD_DEFAULT_CURRENCY ?? "USD").toUpperCase(),
  };
}

/** Marks a project that lives only in AtherNull's hosted repository (no external URL). */
export const HOSTED_REPOSITORY_PREFIX = "athernull://hosted/";

function projectTitle(turns: { role: string; text: string }[]): string {
  const first = turns.find((t) => t.role === "customer")?.text ?? "";
  const line = first.split("\n").map((l) => l.trim()).find(Boolean) ?? "New project";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

async function headOfLineage(lineageId: string, organizationId: string) {
  return db
    .selectFrom("project_estimates")
    .selectAll()
    .where("lineage_id", "=", lineageId)
    .where("organization_id", "=", organizationId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
}

async function buildState(conversationId: string, organizationId: string) {
  const discussion = await findDiscussion(conversationId, organizationId);
  if (!discussion) throw new HttpError(404, "Not a discussion of this organization");
  const head = discussion.planned_lineage_id ? await headOfLineage(discussion.planned_lineage_id, organizationId) : undefined;

  let authorization = null;
  let task = null;
  if (head) {
    task =
      (await db
        .selectFrom("tasks")
        .innerJoin("project_estimates as e", "e.id", "tasks.source_estimate_id")
        .select(["tasks.id", "tasks.status", "tasks.project_id", "tasks.max_budget_minor", "tasks.currency"])
        // The current attempt: the build made from the current plan version.
        // "Try again" (below) starts a new version, so earlier attempts stay
        // on older ones and are only counted.
        .where("tasks.source_estimate_id", "=", head.id)
        .where("tasks.organization_id", "=", organizationId)
        .orderBy("tasks.created_at", "desc")
        .executeTakeFirst()) ?? null;
    authorization =
      (await db
        .selectFrom("project_budget_authorizations")
        .select(["id", "status", "amount_minor", "currency", "source"])
        .where("estimate_id", "=", head.id)
        .where("status", "in", ["ACTIVE", "CONSUMED"])
        .orderBy("created_at", "desc")
        .executeTakeFirst()) ?? null;
  }

  let previousAttempts = 0;
  let agentConversationId: string | null = null;
  if (head) {
    const { n } = await db
      .selectFrom("tasks")
      .innerJoin("project_estimates as e", "e.id", "tasks.source_estimate_id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("e.lineage_id", "=", head.lineage_id)
      .where("e.id", "<>", head.id)
      .where("tasks.organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    previousAttempts = Number(n);
  }
  if (task) {
    // Where the agent is working on this build right now (its latest
    // attempt): the build panel links to it as "Watch the agent work".
    const latest = await db
      .selectFrom("executions")
      .select("conversation_id")
      .where("task_id", "=", task.id)
      .where("conversation_id", "is not", null)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    agentConversationId = latest?.conversation_id ?? null;
  }

  // A queued build: how many builds the workers take before it (claim order
  // is oldest first). An aggregate count only — nothing about whose they are.
  let queuePosition: number | null = null;
  if (task?.status === "QUEUED") {
    const { ahead } = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<string>().as("ahead"))
      .where("status", "=", "QUEUED")
      .where("created_at", "<", (await db.selectFrom("tasks").select("created_at").where("id", "=", task.id).executeTakeFirstOrThrow()).created_at)
      .executeTakeFirstOrThrow();
    queuePosition = Number(ahead);
  }

  return {
    discussionId: discussion.conversation_id,
    messageCount: discussion.message_count,
    plan: head ? toEstimateResponse(head) : null,
    authorization: authorization && {
      id: authorization.id,
      status: authorization.status,
      amountMinor: Number(authorization.amount_minor),
      currency: authorization.currency,
      source: authorization.source,
    },
    task: task && {
      id: task.id,
      status: task.status,
      projectId: task.project_id,
      budgetMinor: Number(task.max_budget_minor),
      currency: task.currency,
      // The verified app, live (routes/previews.ts); null until published.
      previewUrl: PREVIEWABLE_STATUSES.has(task.status) && hasPreview(task.id) ? `/preview/${task.id}/` : null,
      queuePosition,
      agentConversationId,
    },
    /** Earlier attempts in this chat that ended without a delivery. */
    previousAttempts,
    // Request changes: what the customer asked for so far, and the cap.
    changeRequests: task ? await listChangeRequests(task.id) : [],
    maxChangeRounds: MAX_CHANGE_ROUNDS,
    defaultBudget: defaultBudget(),
  };
}

// One draft at a time per discussion (a double click must not make two
// projects). In-process: the API runs as a single process today.
const drafting = new Map<string, Promise<EstimateResponse>>();

async function draftPlan(conversationId: string, organizationId: string, userId: string): Promise<EstimateResponse> {
  const discussion = await findDiscussion(conversationId, organizationId);
  if (!discussion) throw new HttpError(404, "Not a discussion of this organization");
  if (discussion.planned_lineage_id) {
    const head = await headOfLineage(discussion.planned_lineage_id, organizationId);
    if (head) return toEstimateResponse(head);
  }

  const turns = await fetchTranscript(await loadOrgServer(organizationId), discussion.conversation_id);
  if (!turns.some((t) => t.role === "customer")) throw new HttpError(409, "Describe what you want built first");

  // A new idea gets an AtherNull-hosted repository (ADR-0019): no GitHub
  // URL needed. The repository exists before the project row says so.
  const projectId = randomUUID();
  const repo = repoPath(organizationId, projectId);
  const title = projectTitle(turns);
  await createRepo(repo, title);
  try {
    await db
      .insertInto("projects")
      .values({
        id: projectId,
        organization_id: organizationId,
        permitted_repository: `${HOSTED_REPOSITORY_PREFIX}${projectId}`,
        revision: "main",
        scope: title,
        owner_user_id: userId,
        repo_kind: "hosted",
      })
      .execute();
  } catch (err) {
    await rm(repo, { recursive: true, force: true });
    throw err;
  }

  const estimate = await createEstimate({ organizationId, userId, projectId, sourcePrompt: discussionPrompt(turns) });
  await markDiscussionPlanned(discussion.conversation_id, organizationId, estimate.lineageId);
  return estimate;
}

export async function chatBuildRoutes(app: FastifyInstance) {
  const params = z.object({ id: z.string().min(1).max(64) });

  // Where this discussion is in plan -> approve -> bill -> pay -> build.
  app.get("/v1/discussions/:id/build", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = params.parse(request.params);
      reply.send(await buildState(id, organizationId));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  // "Draft plan" in the chat: plan v1 from the transcript, attached to a new
  // hosted project. Idempotent per discussion: returns the existing plan.
  app.post("/v1/discussions/:id/plan", async (request, reply) => {
    try {
      const { organizationId, userId } = await requireOrgSession(request);
      const { id } = params.parse(request.params);
      const key = `${organizationId}:${id.replace(/-/g, "").toLowerCase()}`;
      let pending = drafting.get(key);
      if (!pending) {
        pending = draftPlan(id, organizationId, userId).finally(() => drafting.delete(key));
        drafting.set(key, pending);
      }
      reply.status(201).send(await pending);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  // "Update plan": the customer kept talking; re-plan from the whole
  // conversation so far, with the current plan as the starting point.
  app.post("/v1/discussions/:id/plan/update", async (request, reply) => {
    try {
      const { organizationId, userId } = await requireOrgSession(request);
      const { id } = params.parse(request.params);
      const state = await buildState(id, organizationId);
      if (!state.plan) throw new HttpError(409, "There is no plan yet — draft one first");
      if (state.task) throw new HttpError(409, "This plan is already billed — it can't be changed");

      const turns = await fetchTranscript(await loadOrgServer(organizationId), state.discussionId);
      const prompt =
        `${discussionPrompt(turns)}\n\n` +
        `The plan currently on the table (version ${state.plan.version}) is below as JSON. ` +
        `Produce the updated plan that matches the latest agreement in the discussion; keep whatever still applies.\n` +
        JSON.stringify(state.plan.plannerOutput);
      const estimate = await reviseEstimate({
        organizationId,
        userId,
        projectId: state.plan.projectId,
        estimateId: state.plan.id,
        prompt,
      });
      reply.status(201).send(estimate);
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  // "Try again" in the chat, after a build ended without a delivery and its
  // money is back (refunded or cancelled): the same plan as a new version,
  // ready for review, so the chat goes through approve -> bill -> pay again
  // instead of the customer starting a new chat. The new version has no
  // budget, task or funding of its own yet; nothing is charged here.
  app.post("/v1/discussions/:id/build/retry", async (request, reply) => {
    try {
      const { organizationId, userId } = await requireOrgSession(request);
      const { id } = params.parse(request.params);
      const state = await buildState(id, organizationId);
      if (!state.plan || !state.task) throw new HttpError(409, "There is no build to try again");
      if (!RETRYABLE_STATUSES.has(state.task.status)) {
        throw new HttpError(
          409,
          state.task.status === "FAILED" ? "Get your refund first, then try again" : "This build can't be tried again",
        );
      }
      reply.status(201).send(await copyPlanAsNewVersion(state.plan.id, organizationId, userId));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  // What a canvas conversation is to AtherNull: a customer's discussion, or
  // the agent's workspace for one of its builds (each build attempt runs in
  // its own conversation). The canvas hides build conversations from the
  // sidebar and, when one is opened, points back to its discussion.
  app.get("/v1/conversations/:id/owner", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = params.parse(request.params);
      const discussion = await findDiscussion(id, organizationId);
      if (discussion) return reply.send({ kind: "discussion", discussionId: discussion.conversation_id });
      const plain = id.replace(/-/g, "").toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(plain)) throw new HttpError(404, "Not found");
      const dashed = `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`;
      const build = await db
        .selectFrom("executions")
        .innerJoin("tasks", "tasks.id", "executions.task_id")
        .innerJoin("project_estimates as e", "e.id", "tasks.source_estimate_id")
        .innerJoin("discussion_conversations as d", (join) =>
          join.onRef("d.planned_lineage_id", "=", "e.lineage_id").onRef("d.organization_id", "=", "tasks.organization_id"),
        )
        .select(["d.conversation_id", "tasks.id as task_id"])
        .where("executions.conversation_id", "in", [plain, dashed])
        .where("tasks.organization_id", "=", organizationId)
        .executeTakeFirst();
      if (!build) throw new HttpError(404, "Not found");
      reply.send({ kind: "build", discussionId: build.conversation_id, taskId: build.task_id });
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}

/** Builds that ended without a delivery and whose money is back. */
const RETRYABLE_STATUSES = new Set(["REFUNDED", "CANCELLED"]);

/** The plan again, as the lineage's new head version, ready for review. */
async function copyPlanAsNewVersion(estimateId: string, organizationId: string, userId: string): Promise<EstimateResponse> {
  try {
    const row = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("project_estimates")
        .selectAll()
        .where("id", "=", estimateId)
        .where("organization_id", "=", organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const head = await trx
        .selectFrom("project_estimates")
        .select("id")
        .where("lineage_id", "=", current.lineage_id)
        .orderBy("version", "desc")
        .limit(1)
        .executeTakeFirstOrThrow();
      if (head.id !== current.id) throw new HttpError(409, "The plan changed meanwhile; reload and try again");
      await trx.updateTable("project_estimates").set({ status: "SUPERSEDED" }).where("id", "=", current.id).execute();
      return trx
        .insertInto("project_estimates")
        .values({
          lineage_id: current.lineage_id,
          version: current.version + 1,
          status: "READY_FOR_REVIEW",
          organization_id: current.organization_id,
          project_id: current.project_id,
          source_prompt: current.source_prompt,
          planner_output: JSON.stringify(current.planner_output),
          planner_model: current.planner_model,
          pricing_status: current.pricing_status,
          currency: current.currency,
          estimated_min_minor: current.estimated_min_minor,
          estimated_max_minor: current.estimated_max_minor,
          proposed_budget_cap_minor: current.proposed_budget_cap_minor,
          pricing_breakdown: current.pricing_breakdown === null ? null : JSON.stringify(current.pricing_breakdown),
          rate_version: current.rate_version,
          created_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return toEstimateResponse(row);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new HttpError(409, "Already being tried again");
    throw err;
  }
}
