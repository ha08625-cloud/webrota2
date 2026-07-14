import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ClinicCounter, SystemCounter } from "./types";

export const counterKeys = {
  all: ["counters"] as const,
  clinic: () => [...counterKeys.all, "clinic"] as const,
  system: () => [...counterKeys.all, "system"] as const,
};

/**
 * Counters are readable and resettable. Reset-to-zero is the only mutation
 * -- rows are updated, never deleted, per routers_counters.py's own
 * docstring. All other mutation happens through generation and swap-roles.
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

export function useResetClinicCounter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.post<ClinicCounter>(`/counters/clinic/${id}/reset`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.clinic() });
    },
  });
}

export function useResetSystemCounter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.post<SystemCounter>(`/counters/system/${id}/reset`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.system() });
    },
  });
}

export function useResetAllClinicCounters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<void>("/counters/clinic/reset-all"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.clinic() });
    },
  });
}

export function useResetAllSystemCounters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<void>("/counters/system/reset-all"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.system() });
    },
  });
}