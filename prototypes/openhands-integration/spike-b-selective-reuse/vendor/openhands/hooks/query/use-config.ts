/**
 * SPIKE-B STUB (see MANIFEST.md "hooks/query/use-config" row). Upstream is a
 * TanStack Query hook (`useQuery`) fetching `/api/options/config` from a live
 * Agent Server. No backend exists in this harness, so this returns a static
 * shape matching the subset `event-message.tsx` reads (`config` is passed
 * through to child components as an opaque value; no vendored file destructures
 * specific fields from it).
 */
export function useConfig() {
  return { data: undefined, isLoading: false, isError: false } as const;
}
