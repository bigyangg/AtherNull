"use client";

import { useQuery } from "@tanstack/react-query";

import { dashboardApi } from "@/lib/api";

export function useAgentProfiles() {
  return useQuery({
    queryKey: ["agent-profiles"],
    queryFn: () => dashboardApi.listAgentProfiles(),
  });
}
