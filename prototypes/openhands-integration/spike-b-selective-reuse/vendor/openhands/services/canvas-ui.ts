/**
 * SPIKE-B STUB (see MANIFEST.md "services/canvas-ui" row). Upstream opens the
 * Files drawer to a specific workspace path by writing into
 * `conversation-store` and `files-tab-store` (real app-shell panel state,
 * neither of which exists in this harness). The one real vendored caller
 * (`path-component.tsx`) only needs the click handler to exist and be
 * callable.
 */
export function openWorkspaceFile(
  path: string,
  conversationId?: string | null,
): void {
  // eslint-disable-next-line no-console
  console.info(
    `[spike-b stub] openWorkspaceFile(${path}, conversationId=${conversationId ?? "null"}) — no Files drawer wired`,
  );
}
