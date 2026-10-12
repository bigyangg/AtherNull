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
        .where("e.lineage_id", "=", head.lineage_id)
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
    },
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
}
