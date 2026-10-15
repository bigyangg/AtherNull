import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";
import { db } from "../db.js";
import { provisionTaskSandbox, decommissionTaskSandbox, getTaskSandbox } from "../sandbox/task-provisioner.js";

export function taskSandboxRoutes(app: FastifyInstance) {
  // POST /internal/task-sandboxes - Provision a per-task sandbox
  app.post(
    "/internal/task-sandboxes",
    async (request, reply) => {
      try {
        // Auth: Bearer token from worker (TASK_API_KEY)
        const authHeader = request.headers["authorization"];
        if (!authHeader?.startsWith("Bearer ")) {
          reply.status(401).send({ error: "Missing Authorization header" });
          return;
        }
        const token = authHeader.slice(7);

        // In production, validate this against a known worker token
        // For now, accept any non-empty token
        if (!token) {
          reply.status(401).send({ error: "Invalid token" });
          return;
        }

        const body = z
          .object({
            taskId: z.string().uuid(),
            orgId: z.string().uuid(),
            projectId: z.string().uuid(),
            image: z.string().optional(),
          })
          .parse(request.body);

        // Verify org owns the task
        const task = await db
          .selectFrom("tasks")
          .select(["id", "organization_id", "project_id"])
          .where("id", "=", body.taskId)
          .executeTakeFirst();

        if (!task || task.organization_id !== body.orgId || task.project_id !== body.projectId) {
          reply.status(404).send({ error: "Task not found or access denied" });
          return;
        }

        // Provision the sandbox
        const sandbox = await provisionTaskSandbox({
          taskId: body.taskId,
          orgId: body.orgId,
          projectId: body.projectId,
          memoryGB: 2,
          cpus: 2,
          pidsLimit: 512,
          networkMode: "isolated",
          image: body.image || "athernull/agent-server:v2024.12.0", // pinned image
          env: {},
        });

        reply.status(201).send({
          containerName: sandbox.containerName,
          baseUrl: sandbox.baseUrl,
          sessionApiKey: sandbox.sessionApiKey,
        });
      } catch (err) {
        if (sendHttpError(reply, err)) return;
        if (err instanceof z.ZodError) {
          reply.status(400).send({ error: err.message });
          return;
        }
        console.error("[task-sandbox] Provision error:", err);
        reply.status(500).send({ error: "Failed to provision task sandbox" });
      }
    }
  );

  // DELETE /internal/task-sandboxes/:taskId - Decommission a task sandbox
  app.delete(
    "/internal/task-sandboxes/:taskId",
    async (request, reply) => {
      try {
        const authHeader = request.headers["authorization"];
        if (!authHeader?.startsWith("Bearer ")) {
          reply.status(401).send({ error: "Missing Authorization header" });
          return;
        }
        const token = authHeader.slice(7);
        if (!token) {
          reply.status(401).send({ error: "Invalid token" });
          return;
        }

        const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params);

        await decommissionTaskSandbox(taskId);
        reply.status(204).send();
      } catch (err) {
        if (sendHttpError(reply, err)) return;
        if (err instanceof z.ZodError) {
          reply.status(400).send({ error: err.message });
          return;
        }
        console.error("[task-sandbox] Decommission error:", err);
        reply.status(500).send({ error: "Failed to decommission task sandbox" });
      }
    }
  );

  // GET /internal/task-sandboxes/:taskId - Get sandbox info
  app.get(
    "/internal/task-sandboxes/:taskId",
    async (request, reply) => {
      try {
        const authHeader = request.headers["authorization"];
        if (!authHeader?.startsWith("Bearer ")) {
          reply.status(401).send({ error: "Missing Authorization header" });
          return;
        }
        const token = authHeader.slice(7);
        if (!token) {
          reply.status(401).send({ error: "Invalid token" });
          return;
        }

        const { taskId } = z.object({ taskId: z.string().uuid() }).parse(request.params);

        const sandbox = await getTaskSandbox(taskId);
        if (!sandbox) {
          reply.status(404).send({ error: "Task sandbox not found" });
          return;
        }

        reply.send({
          taskId: sandbox.taskId,
          orgId: sandbox.orgId,
          projectId: sandbox.projectId,
          containerName: sandbox.containerName,
          baseUrl: sandbox.baseUrl,
          networkName: sandbox.networkName,
          createdAt: sandbox.createdAt,
        });
      } catch (err) {
        if (sendHttpError(reply, err)) return;
        if (err instanceof z.ZodError) {
          reply.status(400).send({ error: err.message });
          return;
        }
        throw err;
      }
    }
  );
}