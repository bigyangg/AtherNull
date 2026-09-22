/**
 * SPIKE-B STUB (see MANIFEST.md "hooks/use-conversation-id" row). Upstream
 * reads the conversation id from the React Router route params. This harness
 * has one static route (`app/harness/page.tsx`) and no conversation routing,
 * so this returns a fixed id.
 */
export function useOptionalConversationId(): { conversationId: string | null } {
  return { conversationId: "spike-b-harness-conversation" };
}

export function useConversationId(): { conversationId: string } {
  return { conversationId: "spike-b-harness-conversation" };
}
