import { z } from "zod";

/**
 * Phase 5 — Hierarchical Memory System for AtherNull.
 *
 * Three-tier memory architecture:
 * 1. Project Permanent Memory — overall progress, TODO list, decisions, artifacts
 * 2. Running/Temp Memory — active task, checkpoints, agent assignments, resource usage
 * 3. Per-Agent Memory — agent-specific permanent knowledge + running state
 *
 * Stored as JSON files in the sandbox volume at:
 *   /workspace/.athernull/<project-id>/
 *     ├── memory.json          # ProjectMemory
 *     ├── running.json         # RunningMemory
 *     ├── checkpoints/         # Checkpoint files
 *     ├── threads/             # ThreadMessage files
 *     └── agents/
 *         └── <agent-id>/
 *             ├── memory.json  # AgentMemory (permanent)
 *             └── running.json # AgentRunningMemory
 */

// ============================================================================
// Project Permanent Memory
// ============================================================================

export const ProjectPhaseStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "blocked",
]);
export type ProjectPhaseStatus = z.infer<typeof ProjectPhaseStatusSchema>;

export const ProjectPhaseSchema = z.object({
  status: ProjectPhaseStatusSchema,
  threadId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type ProjectPhase = z.infer<typeof ProjectPhaseSchema>;

export const ProjectOverallStatusSchema = z.enum([
  "PLANNING",
  "BUILDING",
  "VERIFYING",
  "AWAITING_ACCEPTANCE",
  "SETTLED",
  "REFUNDED",
  "FAILED",
  "ARCHIVED",
]);
export type ProjectOverallStatus = z.infer<typeof ProjectOverallStatusSchema>;

export const ProjectPhasesSchema = z.object({
  planning: ProjectPhaseSchema,
  implementation: ProjectPhaseSchema,
  verification: ProjectPhaseSchema,
  acceptance: ProjectPhaseSchema,
});
export type ProjectPhases = z.infer<typeof ProjectPhasesSchema>;

export const TodoItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "done", "blocked"]),
  deliverable: z.string().optional(),
  assignee: z.string().optional(), // agent-id or user-id
  dependsOn: z.array(z.string()).optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  question: z.string(),
  decision: z.string(),
  rationale: z.string().optional(),
  threadRef: z.string().optional(), // reference to thread message
  timestamp: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ProjectArtifactsSchema = z.object({
  repoUrl: z.string().optional(),
  deployUrl: z.string().optional(),
  livePreview: z.string().optional(),
  finalCommit: z.string().optional(),
  buildLogs: z.string().optional(),
});
export type ProjectArtifacts = z.infer<typeof ProjectArtifactsSchema>;

export const ProjectMemorySchema = z.object({
  projectId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  owner: z.string(),
  overallStatus: z.enum([
    "PLANNING",
    "BUILDING",
    "VERIFYING",
    "AWAITING_ACCEPTANCE",
    "SETTLED",
    "REFUNDED",
    "FAILED",
    "ARCHIVED",
  ]),
  phases: ProjectPhasesSchema,
  todoList: z.array(TodoItemSchema),
  decisions: z.array(DecisionSchema),
  artifacts: ProjectArtifactsSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;

// ============================================================================
// Running/Temp Memory
// ============================================================================

export const AgentAssignmentSchema = z.object({
  task: z.string(),
  status: z.enum(["assigned", "running", "waiting", "handed_off", "done"]),
  startedAt: z.string().optional(),
  checkpointId: z.string().optional(),
});
export type AgentAssignment = z.infer<typeof AgentAssignmentSchema>;

export const OpenIssueSchema = z.object({
  id: z.string(),
  type: z.enum([
    "test_failure",
    "build_error",
    "verification_failure",
    "timeout",
    "resource_exhausted",
    "blocked",
    "other",
  ]),
  threadRef: z.string().optional(),
  status: z.enum(["open", "resolved", "escalated"]),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
  resolution: z.string().optional(),
});
export type OpenIssue = z.infer<typeof OpenIssueSchema>;

export const ResourceUsageSchema = z.object({
  tokensUsed: z.number().default(0),
  wallTimeSec: z.number().default(0),
  checkpointsCreated: z.number().default(0),
  rollbacksPerformed: z.number().default(0),
  apiCalls: z.number().default(0),
});
export type ResourceUsage = z.infer<typeof ResourceUsageSchema>;

export const RunningMemorySchema = z.object({
  activeTaskId: z.string().optional(),
  activeThreadId: z.string().optional(),
  currentCheckpoint: z.string().optional(),
  checkpointHistory: z.array(z.string()),
  agentAssignments: z.record(z.string(), AgentAssignmentSchema),
  openIssues: z.array(OpenIssueSchema),
  resourceUsage: ResourceUsageSchema,
  lastSyncAt: z.string(),
});
export type RunningMemory = z.infer<typeof RunningMemorySchema>;

// ============================================================================
// Per-Agent Memory
// ============================================================================

export const AgentRoleSchema = z.enum([
  "coordinator",
  "planner",
  "implementer",
  "fixer",
  "reviewer",
  "researcher",
  "verifier",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentCapabilitySchema = z.enum([
  "terminal",
  "file_editor",
  "task_tracker",
  "git",
  "web_search",
  "code_search",
  "browser",
  "database",
]);
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const AgentPermanentKnowledgeSchema = z.object({
  projectConventions: z.string(),
  codeStyle: z.string(),
  knownGotchas: z.array(z.string()),
  domainKnowledge: z.record(z.string(), z.string()).optional(),
});
export type AgentPermanentKnowledge = z.infer<typeof AgentPermanentKnowledgeSchema>;

export const AgentRunningStateSchema = z.object({
  currentSubtask: z.string().optional(),
  workingFiles: z.array(z.string()),
  blockers: z.array(z.string()),
  recentDecisions: z.array(z.string()),
  lastHeartbeat: z.string().optional(),
});
export type AgentRunningState = z.infer<typeof AgentRunningStateSchema>;

export const AgentMemorySchema = z.object({
  agentId: z.string(),
  role: AgentRoleSchema,
  capabilities: z.array(AgentCapabilitySchema),
  permanentKnowledge: AgentPermanentKnowledgeSchema,
  runningState: AgentRunningStateSchema,
  interactionLog: z.array(
    z.object({
      timestamp: z.string(),
      type: z.enum(["user_instruction", "tool_result", "decision", "error", "handoff"]),
      content: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentMemory = z.infer<typeof AgentMemorySchema>;

// ============================================================================
// Thread System
// ============================================================================

export const ThreadTypeSchema = z.enum([
  "planning",
  "build",
  "fix",
  "review",
  "discussion",
]);
export type ThreadType = z.infer<typeof ThreadTypeSchema>;

export const ThreadStatusSchema = z.enum(["open", "resolved", "archived"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadContextPointersSchema = z.object({
  taskId: z.string(),
  checkpointId: z.string().optional(),
  executionId: z.string().optional(),
  relatedThreads: z.array(z.string()),
  parentThreadId: z.string().optional(),
});
export type ThreadContextPointers = z.infer<typeof ThreadContextPointersSchema>;

export const ThreadMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  metadata: z
    .object({
      checkpointId: z.string().optional(),
      toolCalls: z.array(z.unknown()).optional(),
      artifacts: z.array(z.unknown()).optional(),
      fromAgent: z.string().optional(),
      toAgent: z.string().optional(),
      messageType: z.enum(["instruction", "result", "decision", "error", "handoff"]).optional(),
    })
    .optional(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const ThreadMetaSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  type: ThreadTypeSchema,
  status: ThreadStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  parentThreadId: z.string().optional(),
  contextPointers: ThreadContextPointersSchema,
  messageCount: z.number().default(0),
  lastMessageAt: z.string().optional(),
});
export type ThreadMeta = z.infer<typeof ThreadMetaSchema>;

// ============================================================================
// Checkpoint System
// ============================================================================

export const CheckpointLabelSchema = z.enum([
  "baseline",
  "milestone",
  "pre_risk",
  "pre_failure",
  "manual",
  "handoff",
]);
export type CheckpointLabel = z.infer<typeof CheckpointLabelSchema>;

export const CheckpointSchema = z.object({
  id: z.string(), // cp-<uuid8>
  label: CheckpointLabelSchema,
  reason: z.string(),
  gitCommit: z.string(),
  conversationState: z.record(z.string(), z.unknown()), // Agent Server conversation snapshot
  environment: z.record(z.string(), z.unknown()), // env vars, packages, processes
  timestamp: z.string(),
  parentCheckpoint: z.string().optional(),
  taskId: z.string(),
  executionId: z.string(),
  projectId: z.string(),
  filesChanged: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const CheckpointIndexSchema = z.object({
  projectId: z.string(),
  taskId: z.string(),
  checkpoints: z.array(
    z.object({
      id: z.string(),
      label: CheckpointLabelSchema,
      reason: z.string(),
      timestamp: z.string(),
      gitCommit: z.string(),
    })
  ),
  updatedAt: z.string(),
});
export type CheckpointIndex = z.infer<typeof CheckpointIndexSchema>;

// ============================================================================
// Error Classification for Auto-Rollback
// ============================================================================

export const ErrorTypeSchema = z.enum([
  "test_failure",
  "timeout",
  "agent_stuck",
  "tool_error",
  "network",
  "resource_exhausted",
  "unknown",
]);
export type ErrorType = z.infer<typeof ErrorTypeSchema>;

export const ErrorContextSchema = z.object({
  errorType: ErrorTypeSchema,
  location: z.string(), // file:line or tool:command
  checkpointAfter: z.string().optional(), // last checkpoint ID before error
  reversible: z.boolean(),
  fixStrategy: z.string().optional(),
  errorMessage: z.string(),
  stackTrace: z.string().optional(),
});
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

export const RollbackActionSchema = z.enum(["rollback", "escalate", "retry_same"]);
export type RollbackAction = z.infer<typeof RollbackActionSchema>;

export const RollbackDecisionSchema = z.object({
  action: RollbackActionSchema,
  targetCheckpoint: z.string().optional(),
  fixInstruction: z.string().optional(),
  reason: z.string(),
});
export type RollbackDecision = z.infer<typeof RollbackDecisionSchema>;

export const RollbackResultSchema = z.object({
  success: z.boolean(),
  newConversationId: z.string().optional(),
  checkpoint: CheckpointSchema.optional(),
  filesRestored: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type RollbackResult = z.infer<typeof RollbackResultSchema>;

export * from "./estimates";
export * from "./tasks";
export * from "./events";
export * from "./agentProfiles";
export * from "./jobs";
export * from "./openhands-compat";
export * from "./realtime-browser";
export * from "./budget-authorizations";
export * from "./task-provenance";
export * from "./usage-policies";
export * from "./project-funding";