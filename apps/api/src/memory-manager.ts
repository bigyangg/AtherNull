import type { ProjectMemory, TodoItem, ProjectOverallStatus, ProjectPhases, Checkpoint, ThreadMeta, ThreadMessage, AgentMemory, AgentRunningState } from "@athernull/contracts";
import { randomUUID } from "node:crypto";

/**
 * API Memory Manager
 * 
 * Provides a server-side interface for reading/writing hierarchical memory
 * to the sandbox volume. In production, this would use the actual filesystem
 * at /workspace/.athernull/<project-id>/.
 */

interface MemoryStore {
  projectMemory: Map<string, ProjectMemory>;
  runningMemory: Map<string, any>;
  checkpoints: Map<string, Map<string, Checkpoint>>; // projectId -> checkpointId -> Checkpoint
  threads: Map<string, Map<string, ThreadMeta>>; // projectId -> threadId -> ThreadMeta
  threadMessages: Map<string, ThreadMessage[]>; // threadId -> messages
  agentMemory: Map<string, Map<string, AgentMemory>>; // projectId -> agentId -> AgentMemory
  agentRunning: Map<string, Map<string, AgentRunningState>>; // projectId -> agentId -> AgentRunningState
}

const memoryStore: MemoryStore = {
  projectMemory: new Map(),
  runningMemory: new Map(),
  checkpoints: new Map(),
  threads: new Map(),
  threadMessages: new Map(),
  agentMemory: new Map(),
  agentRunning: new Map(),
};

export class APIMemoryManager {
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
    this.ensureProjectStructures();
  }

  private ensureProjectStructures() {
    if (!memoryStore.checkpoints.has(this.projectId)) {
      memoryStore.checkpoints.set(this.projectId, new Map());
    }
    if (!memoryStore.threads.has(this.projectId)) {
      memoryStore.threads.set(this.projectId, new Map());
    }
    if (!memoryStore.agentMemory.has(this.projectId)) {
      memoryStore.agentMemory.set(this.projectId, new Map());
    }
    if (!memoryStore.agentRunning.has(this.projectId)) {
      memoryStore.agentRunning.set(this.projectId, new Map());
    }
  }

  // ============================================================================
  // Project Memory
  // ============================================================================

  getProjectMemory(): ProjectMemory | undefined {
    return memoryStore.projectMemory.get(this.projectId);
  }

  setProjectMemory(memory: ProjectMemory): void {
    memoryStore.projectMemory.set(this.projectId, memory);
  }

  createProjectMemory(name: string, owner: string): ProjectMemory {
    const now = new Date().toISOString();
    const phases: ProjectPhases = {
      planning: { status: "pending" },
      implementation: { status: "pending" },
      verification: { status: "pending" },
      acceptance: { status: "pending" },
    };

    const memory: ProjectMemory = {
      projectId: this.projectId,
      name,
      createdAt: now,
      owner,
      overallStatus: "PLANNING",
      phases,
      todoList: [],
      decisions: [],
      artifacts: {},
      metadata: {},
    };

    memoryStore.projectMemory.set(this.projectId, memory);
    return memory;
  }

  ensureProjectMemory(name: string, owner: string): ProjectMemory {
    let memory = this.getProjectMemory();
    if (!memory) {
      memory = this.createProjectMemory(name, owner);
    }
    return memory;
  }

  addTodo(title: string, deliverable?: string, assignee?: string): TodoItem | undefined {
    const memory = this.getProjectMemory();
    if (!memory) return undefined;

    const todo: TodoItem = {
      id: `todo-${Date.now()}-${randomUUID().slice(0, 6)}`,
      title,
      status: "pending",
      deliverable,
      assignee,
      dependsOn: [],
    };

    memory.todoList.push(todo);
    this.setProjectMemory(memory);
    return todo;
  }

  updateTodo(todoId: string, status?: "pending" | "in_progress" | "done" | "blocked", updates?: Partial<TodoItem>): boolean {
    const memory = this.getProjectMemory();
    if (!memory) return false;

    const todo = memory.todoList.find(t => t.id === todoId);
    if (!todo) return false;

    if (status) todo.status = status;
    if (updates) Object.assign(todo, updates);

    this.setProjectMemory(memory);
    return true;
  }

  addDecision(question: string, decision: string, rationale?: string, threadRef?: string) {
    const memory = this.getProjectMemory();
    if (!memory) return;

    memory.decisions.push({
      id: `dec-${Date.now()}-${randomUUID().slice(0, 6)}`,
      question,
      decision,
      rationale,
      threadRef,
      timestamp: new Date().toISOString(),
    });

    this.setProjectMemory(memory);
  }

  updateProjectPhase(
    phase: keyof ProjectPhases,
    status: "pending" | "in_progress" | "done" | "blocked",
    threadId?: string,
  ): ProjectMemory | undefined {
    const memory = this.getProjectMemory();
    if (!memory) return undefined;

    memory.phases[phase].status = status;
    if (threadId) memory.phases[phase].threadId = threadId;
    if (status === "in_progress" && !memory.phases[phase].startedAt) {
      memory.phases[phase].startedAt = new Date().toISOString();
    }
    if (status === "done" && !memory.phases[phase].completedAt) {
      memory.phases[phase].completedAt = new Date().toISOString();
    }

    memory.overallStatus = this.computeOverallStatus(memory.phases);
    this.setProjectMemory(memory);
    return memory;
  }

  private computeOverallStatus(phases: ProjectPhases): ProjectOverallStatus {
    if (phases.planning.status === "in_progress" || phases.planning.status === "pending") {
      return "PLANNING";
    }
    if (phases.implementation.status === "in_progress") {
      return "BUILDING";
    }
    if (phases.verification.status === "in_progress" || phases.verification.status === "pending") {
      return "VERIFYING";
    }
    if (phases.acceptance.status === "in_progress" || phases.acceptance.status === "pending") {
      return "AWAITING_ACCEPTANCE";
    }
    if (phases.acceptance.status === "done") {
      return "SETTLED";
    }
    if (phases.verification.status === "blocked" || phases.implementation.status === "blocked") {
      return "FAILED";
    }
    return "PLANNING";
  }

  // ============================================================================
  // Running Memory
  // ============================================================================

  getRunningMemory(): any {
    let running = memoryStore.runningMemory.get(this.projectId);
    if (!running) {
      running = {
        activeTaskId: undefined,
        activeThreadId: undefined,
        currentCheckpoint: undefined,
        checkpointHistory: [],
        agentAssignments: {},
        openIssues: [],
        resourceUsage: {
          tokensUsed: 0,
          wallTimeSec: 0,
          checkpointsCreated: 0,
          rollbacksPerformed: 0,
          apiCalls: 0,
        },
        lastSyncAt: new Date().toISOString(),
      };
      memoryStore.runningMemory.set(this.projectId, running);
    }
    return running;
  }

  setRunningMemory(running: any): void {
    running.lastSyncAt = new Date().toISOString();
    memoryStore.runningMemory.set(this.projectId, running);
  }

  // ============================================================================
  // Checkpoints
  // ============================================================================

  saveCheckpoint(checkpoint: Checkpoint): void {
    const projectCheckpoints = memoryStore.checkpoints.get(this.projectId)!;
    projectCheckpoints.set(checkpoint.id, checkpoint);
  }

  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    const projectCheckpoints = memoryStore.checkpoints.get(this.projectId);
    if (!projectCheckpoints) return undefined;
    return projectCheckpoints.get(checkpointId);
  }

  listCheckpoints(taskId?: string): Checkpoint[] {
    const projectCheckpoints = memoryStore.checkpoints.get(this.projectId);
    if (!projectCheckpoints) return [];

    const checkpoints = Array.from(projectCheckpoints.values());
    if (taskId) {
      return checkpoints.filter(cp => cp.taskId === taskId);
    }
    return checkpoints;
  }

  // ============================================================================
  // Threads
  // ============================================================================

  createThread(meta: ThreadMeta): ThreadMeta {
    const projectThreads = memoryStore.threads.get(this.projectId)!;
    projectThreads.set(meta.id, meta);
    
    if (!memoryStore.threadMessages.has(meta.id)) {
      memoryStore.threadMessages.set(meta.id, []);
    }
    
    return meta;
  }

  getThread(threadId: string): ThreadMeta | undefined {
    const projectThreads = memoryStore.threads.get(this.projectId);
    if (!projectThreads) return undefined;
    return projectThreads.get(threadId);
  }

  listThreads(taskId?: string): ThreadMeta[] {
    const projectThreads = memoryStore.threads.get(this.projectId);
    if (!projectThreads) return [];

    const threads = Array.from(projectThreads.values());
    if (taskId) {
      return threads.filter(t => t.taskId === taskId);
    }
    return threads;
  }

  updateThread(threadId: string, updates: Partial<ThreadMeta>): ThreadMeta | undefined {
    const projectThreads = memoryStore.threads.get(this.projectId);
    if (!projectThreads) return undefined;

    const meta = projectThreads.get(threadId);
    if (!meta) return undefined;

    const updated = { ...meta, ...updates, updatedAt: new Date().toISOString() };
    projectThreads.set(threadId, updated);
    return updated;
  }

  appendMessage(threadId: string, message: ThreadMessage): void {
    let messages = memoryStore.threadMessages.get(threadId);
    if (!messages) {
      messages = [];
      memoryStore.threadMessages.set(threadId, messages);
    }
    messages.push(message);

    // Update thread metadata
    const meta = this.getThread(threadId);
    if (meta) {
      meta.messageCount = messages.length;
      meta.lastMessageAt = message.createdAt;
      this.updateThread(threadId, { messageCount: meta.messageCount, lastMessageAt: meta.lastMessageAt });
    }
  }

  getMessages(threadId: string, limit?: number): ThreadMessage[] {
    const messages = memoryStore.threadMessages.get(threadId) || [];
    if (limit) {
      return messages.slice(-limit);
    }
    return messages;
  }

  // ============================================================================
  // Agent Memory
  // ============================================================================

  getAgentMemory(agentId: string): AgentMemory | undefined {
    const projectAgents = memoryStore.agentMemory.get(this.projectId);
    if (!projectAgents) return undefined;
    return projectAgents.get(agentId);
  }

  setAgentMemory(memory: AgentMemory): void {
    const projectAgents = memoryStore.agentMemory.get(this.projectId)!;
    projectAgents.set(memory.agentId, memory);
  }

  getAgentRunning(agentId: string): AgentRunningState | undefined {
    const projectAgents = memoryStore.agentRunning.get(this.projectId);
    if (!projectAgents) return undefined;
    return projectAgents.get(agentId);
  }

  setAgentRunning(agentId: string, running: AgentRunningState): void {
    const projectAgents = memoryStore.agentRunning.get(this.projectId)!;
    projectAgents.set(agentId, running);
  }
}

export function getAPIMemoryManager(projectId: string): APIMemoryManager {
  return new APIMemoryManager(projectId);
}