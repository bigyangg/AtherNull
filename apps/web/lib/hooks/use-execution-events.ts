"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

// Replace the snapshot so late replays and equal timestamps cannot leave gaps
// or duplicates. Each attempt has its own query cache.
export function useExecutionEvents(taskId: string, executionId: string | undefined, active: boolean) {
  const query = useQuery({
    queryKey: ["execution-events", taskId, executionId],
    enabled: Boolean(executionId),
    queryFn: () => dashboardApi.getExecutionEvents(taskId, executionId!),
    refetchInterval: active ? 2000 : false,
  });

  const { refetch } = query;
  useEffect(() => {
    // Completion may precede the next event poll. Fetch the final flush even
    // though periodic polling has stopped.
    if (executionId && !active) void refetch();
  }, [executionId, active, refetch]);

  return query;
}
