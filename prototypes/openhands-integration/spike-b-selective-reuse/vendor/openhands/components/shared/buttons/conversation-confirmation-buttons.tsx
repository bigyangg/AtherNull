/**
 * SPIKE-B STUB (see MANIFEST.md "ConversationConfirmationButtons" row).
 * Upstream renders an approve/reject bar for actions awaiting live
 * confirmation, reading `useEventMessageStore`, `useEventStore`,
 * `useActiveConversation`, `useAgentState`, and a real
 * `useRespondToConfirmation` mutation. No fixture in this harness represents
 * a pending-confirmation state, and upstream's own component already
 * returns `null` in that case — this stub reproduces exactly that (the safe,
 * always-taken branch), so `messages.tsx`'s unconditional
 * `<ConversationConfirmationButtons />` needs no edits.
 */
export function ConversationConfirmationButtons() {
  return null;
}
