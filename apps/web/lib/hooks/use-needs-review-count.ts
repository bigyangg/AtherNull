"use client";

import { useMemo } from "react";

import { useAllTasks } from "@/lib/hooks/use-tasks";

// Shared by the sidebar badge and the dashboard's "Needs your review" list —
// a task counts once it's sitting in AWAITING_ACCEPTANCE, same status the
// per-project page already sorts/flags on.
export function useNeedsReviewCount(): number {
  const { data: tasks } = useAllTasks();
  return useMemo(
    () => tasks?.filter((task) => task.status === "AWAITING_ACCEPTANCE").length ?? 0,
    [tasks],
  );
}
