"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

// Phase 4A — no realtime/polling event stream exists for estimates (nor
// should one: generation is a single request/response LLM call, not a
// long-running execution) — plain queries, invalidated on mutation, same
// pattern as use-tasks.ts's non-polling mutations.
export function useProjectEstimates(projectId: string) {
  return useQuery({
    queryKey: ["project-estimates", projectId],
    queryFn: () => dashboardApi.listEstimates(projectId),
    enabled: Boolean(projectId),
  });
}

export function useGenerateEstimate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prompt: string) => dashboardApi.generateEstimate(projectId, prompt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-estimates", projectId] });
    },
  });
}

export function useReviseEstimate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ estimateId, prompt }: { estimateId: string; prompt: string }) =>
      dashboardApi.reviseEstimate(projectId, estimateId, prompt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-estimates", projectId] });
    },
  });
}

export function useApproveEstimate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (estimateId: string) => dashboardApi.approveEstimate(projectId, estimateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-estimates", projectId] });
    },
  });
}
