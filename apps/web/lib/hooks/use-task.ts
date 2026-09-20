"use client";

import { useQuery } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";
import { isTaskActive } from "@/lib/types";

// No event stream exists yet (Phase 2's usage_events capture isn't built) —
// polling is the only option, same pattern as use-workspace-state.ts.
export function useTask(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId],
    queryFn: () => dashboardApi.getTask(taskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isTaskActive(status) ? 4000 : false;
    },
  });
}
