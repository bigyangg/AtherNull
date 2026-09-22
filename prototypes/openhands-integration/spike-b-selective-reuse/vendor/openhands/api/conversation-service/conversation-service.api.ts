/**
 * SPIKE-B STUB (see MANIFEST.md "api/conversation-service" row). Upstream is
 * a real HTTP client for the Agent Server's conversation endpoints. The one
 * real vendored caller (`user-assistant-event-message.tsx`) only reads
 * `getCurrentConversation()` inside the (never-rendered, per the
 * active-backend-context stub) "branch from here" handler.
 */
interface CurrentConversation {
  id: string;
  title: string;
  workspace?: { working_dir?: string };
}

const ConversationService = {
  getCurrentConversation: (): CurrentConversation | null => null,
};

export default ConversationService;
