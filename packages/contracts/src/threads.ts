import { z } from "zod";

/**
 * Thread types for organizing project conversations.
 * 
 * Planning → Build → Fix-N → Review → Accept/Reject
 * 
 * Each thread type has specific semantics and UI treatment.
 */

export const ThreadTypeSchema = z.enum([
  "planning",      // Initial scope/planning discussion
  "build",         // Main implementation conversation
  "fix",           // Automated fix attempt after verification failure
  "review",        // Human review of completed build
  "discussion",    // General discussion (pre-funding, etc.)
  "change_request", // Customer-requested changes post-verification
]);

export type ThreadType = z.infer<typeof ThreadTypeSchema>;

export const ThreadStatusSchema = z.enum([
  "open",          // Active conversation
  "resolved",      // Completed successfully
  "archived",      // Closed without resolution
  "blocked",       // Waiting on external input
]);

export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadContextPointersSchema = z.object({
  taskId: z.string().optional(),
  relatedThreads: z.array(z.string()).default([]),
  parentThreadId: z.string().optional(),
  checkpointId: z.string().optional(),
  branchName: z.string().optional(),
});

export type ThreadContextPointers = z.infer<typeof ThreadContextPointersSchema>;

export interface ThreadMeta {
  id: string;
  projectId: string;
  taskId: string | null;
  type: ThreadType;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  parentThreadId: string | null;
  contextPointers: ThreadContextPointers;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export const CreateThreadRequestSchema = z.object({
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
});

export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

export const ThreadListQuerySchema = z.object({
  taskId: z.string().optional(),
  type: ThreadTypeSchema.optional(),
  status: ThreadStatusSchema.optional(),
});

export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>;

export const ThreadMessageListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export type ThreadMessageListQuery = z.infer<typeof ThreadMessageListQuerySchema>;

export const AddMessageRequestSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AddMessageRequest = z.infer<typeof AddMessageRequestSchema>;

export const UpdateThreadRequestSchema = z.object({
  status: ThreadStatusSchema.optional(),
  contextPointers: ThreadContextPointersSchema.optional(),
});

export type UpdateThreadRequest = z.infer<typeof UpdateThreadRequestSchema>;