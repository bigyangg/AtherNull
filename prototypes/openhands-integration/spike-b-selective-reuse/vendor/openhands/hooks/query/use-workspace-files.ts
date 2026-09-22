/**
 * SPIKE-B STUB (see MANIFEST.md "hooks/query/use-workspace-files" row).
 * Upstream lists the live workspace's files via a TanStack Query hook
 * chained through `AgentServerRuntimeService` / a cloud file-listing API /
 * an active-backend registry — three more layers of real backend
 * integration. Returns no files, which makes
 * `chat-markdown-path-code.tsx`'s workspace-path-linking in chat markdown a
 * no-op (paths render as plain text instead of clickable links) — it does
 * not affect whether a message renders.
 */
export interface WorkspaceFilesResult {
  data: string[] | undefined;
  isLoading: boolean;
}

export function useWorkspaceFiles(): WorkspaceFilesResult {
  return { data: undefined, isLoading: false };
}
