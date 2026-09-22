/**
 * SPIKE-B STUB (see MANIFEST.md "hooks/use-agent-state" row — explicitly
 * called out in the task brief as a stub candidate, alongside the zustand
 * stores). Upstream's version reads a live REST fallback
 * (`useActiveConversation`) plus a real-time `conversation-state-store`
 * zustand store fed by the Agent Server's websocket, keyed by
 * `useOptionalConversationId()`. None of that exists in this
 * presentation-only harness, so this returns a fixed, harness-local
 * `AgentState` (no live backend, no websocket) — same return shape as
 * upstream (`{ curAgentState, executionStatus }` /
 * `{ localPlanningConversationId, curPlanningAgentState,
 * isPlanningAgentRunning }`) so every real vendored caller
 * (`event-message.tsx`, `terminal.tsx`) is unmodified.
 */
import { AgentState } from "#/types/agent-state";

export interface UseAgentStateResult {
  curAgentState: AgentState;
  executionStatus?: string | null;
}

export function useAgentState(_conversationId?: string): UseAgentStateResult {
  return { curAgentState: AgentState.FINISHED, executionStatus: "finished" };
}

export interface UsePlanningAgentStateResult {
  localPlanningConversationId: string | null;
  curPlanningAgentState: AgentState;
  isPlanningAgentRunning: boolean;
}

export function usePlanningAgentState(): UsePlanningAgentStateResult {
  return {
    localPlanningConversationId: null,
    curPlanningAgentState: AgentState.FINISHED,
    isPlanningAgentRunning: false,
  };
}
