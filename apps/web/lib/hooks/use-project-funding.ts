"use client";

import type { PrepareFundingRequest } from "@athernull/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

// Phase 4E.1 — Solana devnet project funding. The server (apps/api) is the
// only authority on funding state: these hooks only call it. Nothing here
// sees an RPC key or a private key.

const key = (taskId: string) => ["project-funding", taskId] as const;

export function useProjectFunding(taskId: string) {
  return useQuery({
    queryKey: key(taskId),
    queryFn: () => dashboardApi.getProjectFunding(taskId),
  });
}

export function useCreateProjectFunding(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dashboardApi.createProjectFunding(taskId),
    onSuccess: (view) => queryClient.setQueryData(key(taskId), view),
  });
}

export function usePrepareProjectFunding(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PrepareFundingRequest) => dashboardApi.prepareProjectFunding(taskId, input),
    onSuccess: (res) => queryClient.setQueryData(key(taskId), res.funding),
  });
}

export function useVerifyProjectFunding(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (signature?: string) => dashboardApi.verifyProjectFunding(taskId, signature),
    onSuccess: (res) => queryClient.setQueryData(key(taskId), res.funding),
  });
}
