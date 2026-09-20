"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isTaskActive } from "@/lib/types";

export function useWorkspaceState(projectId: string) {
  return useQuery({
    queryKey: ["workspace-state", projectId],
    queryFn: () => api.getWorkspaceState(projectId),
    refetchInterval: (query) => {
      const status = query.state.data?.project.status;
      return status && isTaskActive(status) ? 2000 : false;
    },
  });
}
