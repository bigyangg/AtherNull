/**
 * SPIKE-B STUB (see MANIFEST.md "contexts/active-backend-context" row).
 * Upstream tracks whether the app is talking to OpenHands Cloud or a local
 * agent-server. Fixed to "cloud" here, which is the value
 * `user-assistant-event-message.tsx` uses to gate its "branch from here"
 * button — cloud disables local-only forking, so that button (and its
 * `useForkConversation` / `ConversationService` call path) never actually
 * fires in this harness. Those modules still needed real (typed) stubs since
 * they're referenced at module scope, just never invoked.
 */
export function useActiveBackend(): { backend: { kind: "cloud" | "local" } } {
  return { backend: { kind: "cloud" } };
}
