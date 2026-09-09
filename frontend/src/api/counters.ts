import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ClinicCounter, SystemCounter } from "./types";

export const counterKeys = {
  all: ["counters"] as const,
  clinic: () => [...counterKeys.all, "clinic"] as const,
  system: () => [...counterKeys.all, "system"] as const,
};

/**
 * Counters are readable, resettable, and carry an admin-set opening balance.
 * Rows are updated, never deleted, per routers_counters.py's own docstring.
 * All other mutation happens through generation and swap-roles.
 *
 * Reset clears the opening balance alongside the count (after a reset every
 * doctor is level by definition), so both mutations invalidate the same key.
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
/**
 * Keyed on (doctor, clinic type) rather than on a counter id: the row may
 * not exist yet - clinic counter rows are created lazily, so a new joiner
 * has none, and a joiner is exactly who a balance exists for. The upsert
 * creates the row at raw_count=0 when it is missing.
 *
 * `sessions` is sent as a string, matching the Decimal the API returns; at
 * most one decimal place, or the backend rejects the body.
 */
export interface ClinicOpeningBalanceIn {
  doctor_id: number;
  clinic_type_id: number;
  sessions: string;
}

export function useSetClinicOpeningBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClinicOpeningBalanceIn) =>
      apiClient.put<ClinicCounter>("/counters/clinic/opening-balance", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.clinic() });
    },
  });
}

/** Keyed on the counter id, which is always available for system counters -
 * create_doctor seeds a ROOM_MOVE and a SUPERVISION row per doctor. */
export function useSetSystemOpeningBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ counterId, sessions }: { counterId: number; sessions: string }) =>
      apiClient.put<SystemCounter>(`/counters/system/${counterId}/opening-balance`, { sessions }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.system() });
    },
  });
}
