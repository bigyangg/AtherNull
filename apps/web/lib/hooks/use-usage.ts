"use client";

import { useQuery } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

export function useUsageSummary() {
  return useQuery({
    queryKey: ["usage-summary"],
    queryFn: () => dashboardApi.getUsageSummary(),
  });
}
