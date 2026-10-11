"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

// ADR-0016 — the org's canvas discussions, newest first.
export function useDiscussions() {
  return useQuery({
    queryKey: ["discussions"],
    queryFn: () => dashboardApi.listDiscussions(),
  });
}

// "Turn into a build": plan from a discussion's transcript.
export function usePlanFromDiscussion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, discussionId }: { projectId: string; discussionId: string }) =>
      dashboardApi.generateEstimateFromDiscussion(projectId, discussionId),
    onSuccess: (_estimate, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ["project-estimates", projectId] });
    },
  });
}
