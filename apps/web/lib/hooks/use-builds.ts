"use client";

import { useQuery } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

const ACTIVE = new Set(["QUEUED", "RUNNING", "VERIFYING", "SETTLING", "REFUNDING"]);

// Everything in flight for the org; refreshes while something is moving.
export function useBuilds() {
  return useQuery({
    queryKey: ["builds"],
    queryFn: () => dashboardApi.listBuilds(),
    refetchInterval: (query) => (query.state.data?.some((b) => ACTIVE.has(b.status)) ? 5000 : 15000),
  });
}
