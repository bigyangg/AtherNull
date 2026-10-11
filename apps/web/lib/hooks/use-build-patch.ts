"use client";

import { useQuery } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

// ADR-0017 — the build's captured change. Re-checked while the build is still
// running/verifying, since the patch lands when the agent finishes.
export function useBuildPatch(taskId: string, pending: boolean) {
  return useQuery({
    queryKey: ["build-patch", taskId],
    queryFn: () => dashboardApi.getBuildPatch(taskId),
    refetchInterval: (query) => (pending && !query.state.data ? 5000 : false),
  });
}
