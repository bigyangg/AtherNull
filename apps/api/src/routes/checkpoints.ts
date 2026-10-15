import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  CheckpointSchema,
  CheckpointLabelSchema,
  RollbackDecisionSchema,
  RollbackResultSchema,
  type Checkpoint,
  type CheckpointLabel,
  type RollbackDecision,
  type RollbackResult,
} from "@athernull/contracts";
import { db } from "../db.js";
import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";

// In-memory checkpoint store (in production, this would be in the sandbox volume)
// For now, we'll use a simple in-memory store with persistence to disk
const checkpointStore = new Map<string, Checkpoint>();

export function checkpointRoutes(app: FastifyInstance) {
  // POST /v1/tasks/:taskId/checkpoints - Create a checkpoint
  app.post(
    "/v1/tasks/:taskId/checkpoints",
    async (request, reply) => {
      try {
        const { userId, organizationId } = await requireOrgSession(request);
        requirePrivilegedRole(
          (request as any).user?.role
        ); // TODO: proper role extraction

        const { taskId } = z.object({ taskId: z.string() }).parse(request.params);
        const body = z
          .object({
            label: CheckpointLabelSchema,
            reason: z.string().min(1),
            gitCommit: z.string().min(1),
            conversationState: z.record(z.string(), z.unknown()).optional(),
            environment: z.record(z.string(), z.unknown()).optional(),
            parentCheckpoint: z.string().optional(),
            executionId: z.string(),
            projectId: z.string(),
            filesChanged: z.array(z.string()).optional(),
          })
          .parse(request.body);

        const checkpointId = `cp-${crypto.randomUUID().slice(0, 8)}`;
        const checkpoint: Checkpoint = {
          id: checkpointId,
          label: body.label,
          reason: body.reason,
          gitCommit: body.gitCommit,
          conversationState: body.conversationState ?? {},
          environment: body.environment ?? {},
          timestamp: new Date().toISOString(),
          parentCheckpoint: body.parentCheckpoint,
          taskId,
          executionId: body.executionId,
          projectId: body.projectId,
          filesChanged: body.filesChanged,
        };

        checkpointStore.set(checkpointId, checkpoint);

        // TODO: Persist to sandbox volume
        // await persistCheckpointToVolume(checkpoint);

        reply.status(201).send(checkpoint);
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

  // GET /v1/tasks/:taskId/checkpoints - List checkpoints for a task
  app.get(
    "/v1/tasks/:taskId/checkpoints",
    async (request, reply) => {
      try {
        const { organizationId } = await requireOrgSession(request);
        const { taskId } = z.object({ taskId: z.string() }).parse(request.params);

        // Filter checkpoints for this task
        const checkpoints = Array.from(checkpointStore.values())
          .filter((cp) => cp.taskId === taskId)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        reply.send(checkpoints);
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

  // GET /v1/tasks/:taskId/checkpoints/:checkpointId - Get checkpoint details
  app.get(
    "/v1/tasks/:taskId/checkpoints/:checkpointId",
    async (request, reply) => {
      try {
        const { organizationId } = await requireOrgSession(request);
        const { taskId, checkpointId } = z
          .object({ taskId: z.string(), checkpointId: z.string() })
          .parse(request.params);

        const checkpoint = checkpointStore.get(checkpointId);
        if (!checkpoint || checkpoint.taskId !== taskId) {
          reply.status(404).send({ error: "Checkpoint not found" });
          return;
        }

        reply.send(checkpoint);
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

  // POST /v1/tasks/:taskId/checkpoints/:checkpointId/rollback - Rollback to checkpoint
  app.post(
    "/v1/tasks/:taskId/checkpoints/:checkpointId/rollback",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);

        const { taskId, checkpointId } = z
          .object({ taskId: z.string(), checkpointId: z.string() })
          .parse(request.params);

        const checkpoint = checkpointStore.get(checkpointId);
        if (!checkpoint || checkpoint.taskId !== taskId) {
          reply.status(404).send({ error: "Checkpoint not found" });
          return;
        }

        // In a real implementation, this would trigger the worker to rollback
        // For now, we return the checkpoint data and a success indicator
        const result: RollbackResult = {
          success: true,
          newConversationId: undefined, // Would be set by worker after rollback
          checkpoint,
          filesRestored: checkpoint.filesChanged,
        };

        reply.send(result);
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

  // DELETE /v1/tasks/:taskId/checkpoints/:checkpointId - Delete a checkpoint
  app.delete(
    "/v1/tasks/:taskId/checkpoints/:checkpointId",
    async (request, reply) => {
      try {
        const { userId, organizationId, role } = await requireOrgSession(request);
        requirePrivilegedRole(role);

        const { taskId, checkpointId } = z
          .object({ taskId: z.string(), checkpointId: z.string() })
          .parse(request.params);

        const checkpoint = checkpointStore.get(checkpointId);
        if (!checkpoint || checkpoint.taskId !== taskId) {
          reply.status(404).send({ error: "Checkpoint not found" });
          return;
        }

        checkpointStore.delete(checkpointId);

        // TODO: Remove from sandbox volume

        reply.status(204).send();
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

// Helper to load checkpoints from sandbox volume on startup
export async function loadCheckpointsFromVolume(projectId: string): Promise<void> {
  // TODO: Implement loading from /workspace/.athernull/<project-id>/checkpoints/
  // This would be called on API startup
}

// Helper to persist checkpoint to sandbox volume
export async function persistCheckpointToVolume(checkpoint: Checkpoint): Promise<void> {
  // TODO: Implement writing to /workspace/.athernull/<project-id>/checkpoints/<checkpoint-id>.json
  // And update index.json
}