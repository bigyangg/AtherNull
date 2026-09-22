/**
 * SPIKE-B STUB (see MANIFEST.md "hooks/mutation/use-fork-conversation" row).
 * Upstream is a TanStack Mutation calling the Agent Server's fork-conversation
 * endpoint. No backend exists here, and — per the `active-backend-context`
 * stub above — this harness always reports "cloud", so the one real caller
 * (`user-assistant-event-message.tsx`'s "branch from here" button) never
 * renders and this `mutate` is never actually invoked.
 */
export interface ForkConversationVariables {
  sourceConversationId: string;
  eventId: string;
  editText?: string;
  title?: string;
}

export interface ForkConversationResult {
  info: { id: string; title: string };
  excluded: boolean;
}

export function useForkConversation() {
  return {
    mutate: (
      _vars: ForkConversationVariables,
      _opts?: {
        onSuccess?: (result: ForkConversationResult) => void;
        onError?: (error: unknown) => void;
        onSettled?: () => void;
      },
    ) => undefined,
    isPending: false,
  };
}
