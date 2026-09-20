"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { dashboardApi, type CreateRepoProjectInput } from "@/lib/api";

export function useRepoProjects() {
  return useQuery({
    queryKey: ["repo-projects"],
    queryFn: () => dashboardApi.listRepoProjects(),
  });
}

export function useCreateRepoProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRepoProjectInput) => dashboardApi.createRepoProject(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repo-projects"] });
    },
  });
}
