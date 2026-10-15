import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  ThreadTypeSchema,
  ThreadStatusSchema,
  ThreadContextPointersSchema,
  type ThreadMeta,
  type ThreadMessage,
} from "@athernull/contracts";
import { db } from "../db.js";
import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";
import { getAPIMemoryManager } from "../memory-manager.js";

export function threadRoutes(app: FastifyInstance) {
  // POST /v1/projects/:projectId/threads - Create a new thread
  app.post(
    "/v1/projects/:projectId/threads",
    async (request, reply) => {
      try {
        const { userId, organizationId } = await requireOrgSession(request);
        const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
        const body = z
          .object({
            taskId: z.string().min(1),
            type: ThreadTypeSchema,
            parentThreadId: z.string().optional(),
            contextPointers: ThreadContextPointersSchema.optional(),
            initialMessage: z
              .object({
                role: z.enum(["user", "assistant", "system"]),
                content: z.string().min(1),
                metadata: z.record(z.string(), z.unknown()).optional(),
              })
              .optional(),
          })
          .parse(request.body);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);

        const threadId = `${body.type}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
        const now = new Date().toISOString();

        const meta: ThreadMeta = {
          id: threadId,
          projectId,
          taskId: body.taskId,
          type: body.type,
          status: "open",
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          parentThreadId: body.parentThreadId,
          contextPointers: body.contextPointers ?? {
          taskId: body.taskId,
          relatedThreads: [],
        },
          messageCount: 0,
        };

        memoryManager.createThread(meta);

        // Add initial message if provided
        if (body.initialMessage) {
          const message: ThreadMessage = {
            id: `msg-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
            threadId,
            role: body.initialMessage.role,
            content: body.initialMessage.content,
            metadata: body.initialMessage.metadata,
            createdAt: now,
          };
          memoryManager.appendMessage(threadId, message);
        }

        reply.status(201).send(meta);
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

  // GET /v1/projects/:projectId/threads - List threads for a project
  app.get(
    "/v1/projects/:projectId/threads",
    async (request, reply) => {
      try {
        const { organizationId } = await requireOrgSession(request);
        const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
        const query = z
          .object({
            taskId: z.string().optional(),
            type: ThreadTypeSchema.optional(),
            status: ThreadStatusSchema.optional(),
          })
          .parse(request.query);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);
        let threads = memoryManager.listThreads(query.taskId);

        if (query.type) {
          threads = threads.filter(t => t.type === query.type);
        }
        if (query.status) {
          threads = threads.filter(t => t.status === query.status);
        }

        reply.send(threads);
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

  // GET /v1/projects/:projectId/threads/:threadId - Get thread with messages
  app.get(
    "/v1/projects/:projectId/threads/:threadId",
    async (request, reply) => {
      try {
        const { organizationId } = await requireOrgSession(request);
        const { projectId, threadId } = z
          .object({ projectId: z.string(), threadId: z.string() })
          .parse(request.params);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);
        const meta = memoryManager.getThread(threadId);
        if (!meta) {
          reply.status(404).send({ error: "Thread not found" });
          return;
        }

        const messages = memoryManager.getMessages(threadId);

        reply.send({ ...meta, messages });
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

  // GET /v1/projects/:projectId/threads/:threadId/messages - Get thread messages (paginated)
  app.get(
    "/v1/projects/:projectId/threads/:threadId/messages",
    async (request, reply) => {
      try {
        const { organizationId } = await requireOrgSession(request);
        const { projectId, threadId } = z
          .object({ projectId: z.string(), threadId: z.string() })
          .parse(request.params);
        const query = z
          .object({
            limit: z.coerce.number().int().positive().optional(),
            offset: z.coerce.number().int().nonnegative().optional(),
          })
          .parse(request.query);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);
        const meta = memoryManager.getThread(threadId);
        if (!meta) {
          reply.status(404).send({ error: "Thread not found" });
          return;
        }

        const messages = memoryManager.getMessages(threadId, query.limit);
        const offset = query.offset || 0;
        const paginated = messages.slice(offset, offset + (query.limit || messages.length));

        reply.send({ messages: paginated, total: messages.length });
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

  // POST /v1/projects/:projectId/threads/:threadId/messages - Add message to thread
  app.post(
    "/v1/projects/:projectId/threads/:threadId/messages",
    async (request, reply) => {
      try {
        const { userId, organizationId } = await requireOrgSession(request);
        const { projectId, threadId } = z
          .object({ projectId: z.string(), threadId: z.string() })
          .parse(request.params);
        const body = z
          .object({
            role: z.enum(["user", "assistant", "system", "tool"]),
            content: z.string().min(1),
            metadata: z.record(z.string(), z.unknown()).optional(),
          })
          .parse(request.body);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);
        const meta = memoryManager.getThread(threadId);
        if (!meta) {
          reply.status(404).send({ error: "Thread not found" });
          return;
        }

        const message: ThreadMessage = {
          id: `msg-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
          threadId,
          role: body.role,
          content: body.content,
          metadata: body.metadata,
          createdAt: new Date().toISOString(),
        };

        memoryManager.appendMessage(threadId, message);

        reply.status(201).send(message);
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

  // PATCH /v1/projects/:projectId/threads/:threadId - Update thread (status, metadata)
  app.patch(
    "/v1/projects/:projectId/threads/:threadId",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);

        const { projectId, threadId } = z
          .object({ projectId: z.string(), threadId: z.string() })
          .parse(request.params);
        const body = z
          .object({
            status: ThreadStatusSchema.optional(),
            contextPointers: ThreadContextPointersSchema.optional(),
          })
          .parse(request.body);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);
        const meta = memoryManager.getThread(threadId);
        if (!meta) {
          reply.status(404).send({ error: "Thread not found" });
          return;
        }

        const updated = memoryManager.updateThread(threadId, body);
        if (!updated) {
          reply.status(404).send({ error: "Thread not found" });
          return;
        }

        reply.send(updated);
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

  // POST /v1/projects/:projectId/threads/:threadId/resolve - Mark thread as resolved
  app.post(
    "/v1/projects/:projectId/threads/:threadId/resolve",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);

        const { projectId, threadId } = z
          .object({ projectId: z.string(), threadId: z.string() })
          .parse(request.params);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);
        const updated = memoryManager.updateThread(threadId, { status: "resolved" });
        if (!updated) {
          reply.status(404).send({ error: "Thread not found" });
          return;
        }

        // If this is a planning thread, update project phase
        if (updated.type === "planning") {
          memoryManager.updateProjectPhase("planning", "done", threadId);
          memoryManager.updateProjectPhase("implementation", "in_progress");
        }

        reply.send(updated);
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

  // POST /v1/projects/:projectId/threads/:threadId/archive - Archive thread
  app.post(
    "/v1/projects/:projectId/threads/:threadId/archive",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);

        const { projectId, threadId } = z
          .object({ projectId: z.string(), threadId: z.string() })
          .parse(request.params);

        // Verify project ownership
        const project = await db
          .selectFrom("projects")
          .select(["id"])
          .where("id", "=", projectId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (!project) {
          reply.status(404).send({ error: "Project not found" });
          return;
        }

        const memoryManager = getAPIMemoryManager(projectId);
        const updated = memoryManager.updateThread(threadId, { status: "archived" });
        if (!updated) {
          reply.status(404).send({ error: "Thread not found" });
          return;
        }

        reply.send(updated);
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