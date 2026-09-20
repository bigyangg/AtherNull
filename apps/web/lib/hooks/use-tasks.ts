"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { dashboardApi, type CreateTaskInput } from "@/lib/api";

// GET /v1/jobs returns every task in the org (apps/api has no per-project
// filter yet) — filtered client-side here rather than adding a query param
// the backend doesn't support, fine at MVP scale.
export function useTasks(projectId: string) {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => dashboardApi.listTasks(),
    select: (tasks) => tasks.filter((task) => task.projectId === projectId),
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => dashboardApi.createTask(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useFundTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => dashboardApi.fundTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
