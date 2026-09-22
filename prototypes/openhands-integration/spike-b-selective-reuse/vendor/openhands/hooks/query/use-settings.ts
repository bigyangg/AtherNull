/**
 * SPIKE-B STUB (see MANIFEST.md "hooks/query/use-settings" row). Upstream is
 * a TanStack Query hook fetching `/api/settings` from a live Agent Server.
 * `critic-result-display.tsx` (the only vendored caller) reads only
 * `data.agent_settings.verification.enable_iterative_refinement`, so this
 * returns a static shape with that path present but null (renders the same
 * as "unknown" upstream — no iterative-refinement hint shown).
 */
export function useSettings() {
  return {
    data: { agent_settings: { verification: { enable_iterative_refinement: null } } },
    isLoading: false,
    isError: false,
  } as const;
}
