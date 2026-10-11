// Agent canvas — pure derivations over data the API already returns. Nothing
// here decides anything the server owns: the stage is a *display* reading of
// estimate/authorization/task status, and every action a stage offers is
// still enforced (and can still be refused) by apps/api.
import {
  pairActionsWithObservations,
  parseMessage,
  parseToolCall,
  type ParsedToolCall,
} from "@/lib/execution-events";
import type {
  BudgetAuthorization,
  ExecutionEvent,
  ProjectEstimate,
  TaskStatus,
} from "@/lib/types";

export type CanvasStage =
  | "describe"
  | "planning"
  | "plan-review"
  | "authorize"
  | "prepare"
  | "fund"
  | "queued"
  | "building"
  | "paused"
  | "verifying"
  | "review"
  | "settled"
  | "refunded"
  | "failed";

export const CANVAS_STEPS = ["Plan", "Budget", "Fund", "Build", "Verify", "Review", "Settle"] as const;

// Index into CANVAS_STEPS of the step the stage is currently on.
export function stageStepIndex(stage: CanvasStage): number {
  switch (stage) {
    case "describe":
    case "planning":
    case "plan-review":
      return 0;
    case "authorize":
    case "prepare":
      return 1;
    case "fund":
      return 2;
    case "queued":
    case "building":
    case "paused":
      return 3;
    case "verifying":
      return 4;
    case "review":
      return 5;
    case "settled":
    case "refunded":
    case "failed":
      return 6;
  }
}

export function taskStage(status: TaskStatus): CanvasStage {
  switch (status) {
    case "CREATED":
    case "AWAITING_FUNDING":
      return "fund";
    case "FUNDED":
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "building";
    case "PAUSED_USAGE_LIMIT":
      return "paused";
    case "VERIFYING":
      return "verifying";
    case "AWAITING_ACCEPTANCE":
      return "review";
    case "ACCEPTED":
    case "SETTLING":
    case "SETTLED":
      return "settled";
    case "REJECTED":
    case "REFUNDING":
    case "REFUNDED":
      return "refunded";
    case "FAILED":
    case "CANCELLED":
    case "DISPUTED":
      return "failed";
  }
}

// Stage for a planning lineage that has not produced a task yet.
export function lineageStage(
  head: ProjectEstimate | null,
  authorizations: BudgetAuthorization[],
  planning: boolean,
): CanvasStage {
  if (planning) return "planning";
  if (!head) return "describe";
  if (head.status !== "APPROVED") return "plan-review";
  const active = authorizations.some((a) => a.estimateId === head.id && a.status === "ACTIVE");
  return active ? "prepare" : "authorize";
}

export function lineageVersions(estimates: ProjectEstimate[], lineageId: string | null): ProjectEstimate[] {
  if (!lineageId) return [];
  return estimates.filter((e) => e.lineageId === lineageId).sort((a, b) => a.version - b.version);
}

// --- Conversation timeline -------------------------------------------------

export type TimelineItem =
  | { type: "message"; id: string; role: "user" | "agent"; text: string; reasoning: string | null; at: string }
  | { type: "tool"; id: string; call: ParsedToolCall; pending: boolean; at: string }
  | { type: "error"; id: string; text: string; at: string };

function errorText(event: ExecutionEvent): string | null {
  if (!/Error/.test(event.kind)) return null;
  const payload = event.payload;
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of ["error", "detail", "message", "code"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return event.kind;
}

// Walks events in order, the way OpenHands' chat does: messages as turns,
// each action as one compact row carrying its paired observation, errors
// inline. Observations themselves never get a row of their own.
export function buildTimeline(events: ExecutionEvent[]): TimelineItem[] {
  const pairs = new Map(pairActionsWithObservations(events).map((p) => [p.action.id, p.observation]));
  const items: TimelineItem[] = [];
  for (const event of events) {
    const message = parseMessage(event);
    if (message) {
      items.push({ type: "message", id: event.id, at: event.occurredAt, ...message });
      continue;
    }
    if (event.kind === "ActionEvent") {
      const observation = pairs.get(event.id);
      const call = parseToolCall(event, observation);
      if (call) items.push({ type: "tool", id: event.id, call, pending: !observation, at: event.occurredAt });
      continue;
    }
    const error = errorText(event);
    if (error) items.push({ type: "error", id: event.id, text: error, at: event.occurredAt });
  }
  return items;
}

export function countFileEdits(events: ExecutionEvent[]): number {
  const paths = new Set<string>();
  for (const { action, observation } of pairActionsWithObservations(events)) {
    const call = parseToolCall(action, observation);
    if (call?.tool === "file_editor" && call.command !== "view") paths.add(call.path);
  }
  return paths.size;
}

export function countCommands(events: ExecutionEvent[]): number {
  return pairActionsWithObservations(events).filter(
    ({ action }) => parseToolCall(action)?.tool === "terminal",
  ).length;
}
