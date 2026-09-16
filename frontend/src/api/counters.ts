import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { ClinicCounter, SystemCounter } from "./types";

export const counterKeys = {
  all: ["counters"] as const,
  clinic: () => [...counterKeys.all, "clinic"] as const,
  system: () => [...counterKeys.all, "system"] as const,
};

/**
 * Counters are readable, resettable, and carry an admin-set adjustment.
 * Rows are updated, never deleted, per routers_counters.py's own docstring.
 * All other mutation happens through generation and swap-roles.
 *
 * Reset clears the adjustment alongside the count (after a reset every
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
 * has none, and a doctor with no count at all is exactly the case an
 * adjustment exists for. The upsert
 * creates the row at raw_count=0 when it is missing.
 *
 * `target_count` is the *effective total* the counter should read, not the
 * adjustment: the server stores `target_count - raw_count` as raw stands when
 * it saves, so the admin edits the number they can see and the delta behind it
 * is derived rather than typed. It is sent as a string, matching the Decimal
 * the API returns; at most one decimal place, or the backend rejects the body.
 */
export interface ClinicAdjustmentIn {
  doctor_id: number;
  clinic_type_id: number;
  target_count: string;
}

export function useSetClinicAdjustment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClinicAdjustmentIn) =>
      apiClient.put<ClinicCounter>("/counters/clinic/adjustment", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.clinic() });
    },
  });
}

/** Keyed on the counter id, which is always available for system counters -
 * create_doctor seeds a ROOM_MOVE and a SUPERVISION row per doctor.
 *
 * `target_count` is an effective total, as above. */
export function useSetSystemAdjustment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ counterId, target_count }: { counterId: number; target_count: string }) =>
      apiClient.put<SystemCounter>(`/counters/system/${counterId}/adjustment`, { target_count }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: counterKeys.system() });
    },
  });
}
