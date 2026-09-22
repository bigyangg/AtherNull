/**
 * SPIKE-B STUB (see MANIFEST.md "GoalStatusContent" row). Upstream renders
 * the terminal status of a finished `/goal` loop, reading a live
 * `useGoalStore` zustand store, `useOptionalConversationId`, and dispatching
 * toasts on retry. No fixture in this harness represents a
 * `GoalConversationStateUpdate` event (not one of the 9 required synthetic
 * fixtures, nor present in the upstream-real set), so `event-message.tsx`
 * never actually mounts this in practice — kept as a minimal same-signature
 * stand-in so that real vendored file needs no edits.
 */
export function GoalStatusContent({ status }: { status: unknown }) {
  return (
    <div className="text-xs text-muted" data-testid="goal-status-content-stub">
      Goal status: {String(status)}
    </div>
  );
}
