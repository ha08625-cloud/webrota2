import { useQuery } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ClinicCounter, SystemCounter } from "./types";

export const counterKeys = {
  all: ["counters"] as const,
  clinic: () => [...counterKeys.all, "clinic"] as const,
  system: () => [...counterKeys.all, "system"] as const,
};

/**
 * Read-only, per routers_counters.py's own docstring: "mutation happens
 * only through generation and swap-roles" - there is no create/update/
 * delete for either counter type, so no mutation hooks belong in this
 * file.
 */
export function useClinicCounters() {
  return useQuery({
    queryKey: counterKeys.clinic(),
    queryFn: () => apiClient.get<ClinicCounter[]>("/counters/clinic"),
  });
}

export function useSystemCounters() {
  return useQuery({
    queryKey: counterKeys.system(),
    queryFn: () => apiClient.get<SystemCounter[]>("/counters/system"),
  });
}