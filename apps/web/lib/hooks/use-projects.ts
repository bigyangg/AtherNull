"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, type CreateProjectInput } from "@/lib/api";

// Backs the mocked "Create New" flow only (lib/api/mock.ts) — the main
// project list now reads from lib/hooks/use-repo-projects.ts instead.
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
