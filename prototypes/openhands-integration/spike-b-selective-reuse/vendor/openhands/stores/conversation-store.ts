/**
 * SPIKE-B STUB (see MANIFEST.md "stores/conversation-store" row — zustand
 * store, explicitly called out in the task brief as a stub candidate).
 * Upstream tracks live per-conversation UI state (composer draft, plan
 * preview content, local planner conversation id) synced with the Agent
 * Server. This harness has no backend, so it's a small static zustand store
 * (harness-local, not wired to anything live) seeded with a null plan and a
 * no-op `setMessageToSend`, matching the two fields real vendored callers
 * read: `event-message.tsx`'s `{ planContent }` and
 * `user-assistant-event-message.tsx`'s `state.setMessageToSend`.
 */
import { create } from "zustand";

interface ConversationStoreState {
  planContent: string | null;
  localPlanningConversationId: string | null;
  setMessageToSend: (message: string) => void;
}

export const useConversationStore = create<ConversationStoreState>((set) => ({
  planContent: null,
  localPlanningConversationId: null,
  setMessageToSend: (message: string) => {
    // eslint-disable-next-line no-console
    console.info(`[spike-b stub] setMessageToSend(${message.slice(0, 40)}...)`);
  },
}));
