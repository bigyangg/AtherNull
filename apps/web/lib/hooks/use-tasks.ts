"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { dashboardApi, type CreateTaskInput, type EstimateTaskInput } from "@/lib/api";

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

// Read-only cost preview, no task affected — no cache invalidation needed.
export function useEstimateTask() {
  return useMutation({
    mutationFn: (input: EstimateTaskInput) => dashboardApi.estimateTask(input),
  });
}

export function useVerifyTask(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (outcome: "PASS" | "FAIL") => dashboardApi.verifyTask(taskId, outcome),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useAcceptTask(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dashboardApi.acceptTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useRejectTask(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => dashboardApi.rejectTask(taskId, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
