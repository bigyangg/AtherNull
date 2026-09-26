"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";
import type { AuthorizeBudgetInput } from "@/lib/api/types";

// Phase 4B — mirrors use-project-estimates.ts's shape exactly: plain
// queries, invalidated on mutation, no polling/realtime stream (authorizing
// a budget is a single request/response action, not a long-running
// execution — see routes/budget-authorizations.ts's header comment for why
// this can never reach dispatch).
export function useBudgetAuthorizations(projectId: string, estimateId: string | null) {
  return useQuery({
    queryKey: ["budget-authorizations", projectId, estimateId],
    queryFn: () => dashboardApi.listBudgetAuthorizations(projectId, estimateId as string),
    enabled: Boolean(projectId) && Boolean(estimateId),
  });
}

export function useAuthorizeBudget(projectId: string, estimateId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AuthorizeBudgetInput) => {
      if (!estimateId) throw new Error("No estimate to authorize a budget against");
      return dashboardApi.authorizeBudget(projectId, estimateId, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budget-authorizations", projectId, estimateId] });
    },
  });
}
