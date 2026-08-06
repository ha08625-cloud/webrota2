import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import { rotaKeys } from "./rota";
import type {
  LeaveBulkDeleteIn,
  LeaveBulkDeleteOut,
  LeaveBulkIn,
  LeaveBulkOut,
  LeaveEntitlementYear,
  LeaveEntry,
  LeaveIn,
} from "./types";

export const leaveKeys = {
  all: ["leave"] as const,
  list: (doctorId: number | null) => [...leaveKeys.all, "list", doctorId] as const,
  entitlement: (year: number) => [...leaveKeys.all, "entitlement", year] as const,
};

/**
 * Balances for every doctor the practice tracks leave for, in `year`.
 *
 * Under `leaveKeys.all` on purpose: `used_sessions` is derived from the
 * same rows the list hook returns, so every leave mutation below already
 * invalidates this without needing a second key added to each of them.
 */
export function useLeaveEntitlements(year: number) {
  return useQuery({
    queryKey: leaveKeys.entitlement(year),
    queryFn: () =>
      apiClient.get<LeaveEntitlementYear>(`/leave/entitlement?year=${year}`),
  });
}

/** doctorId=null means unfiltered (the "all doctors" option in the filter select). */
export function useLeave(doctorId: number | null) {
  return useQuery({
    queryKey: leaveKeys.list(doctorId),
    queryFn: () =>
      apiClient.get<LeaveEntry[]>(doctorId === null ? "/leave" : `/leave?doctor_id=${doctorId}`),
  });
}

export function useCreateLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LeaveIn) => apiClient.post<LeaveEntry>("/leave", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.all });
      // Leave creation may clear a room on the active draft; a rota view open
      // in another tab/route needs to refetch to see it. No response payload
      // to splice from here, so invalidate the whole rota prefix.
      queryClient.invalidateQueries({ queryKey: rotaKeys.all });
    },
  });
}

export function useDeleteLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/leave/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.all });
      // Leave removal changes the derived is_on_leave rendering on the rota
      // grid (rooms are not restored, but the leave badge disappears).
      queryClient.invalidateQueries({ queryKey: rotaKeys.all });
    },
  });
}

export function useBulkCreateLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LeaveBulkIn) => apiClient.post<LeaveBulkOut>("/leave/bulk", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.all });
      queryClient.invalidateQueries({ queryKey: rotaKeys.all });
    },
  });
}

export function useBulkDeleteLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LeaveBulkDeleteIn) =>
      apiClient.post<LeaveBulkDeleteOut>("/leave/bulk-delete", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.all });
      queryClient.invalidateQueries({ queryKey: rotaKeys.all });
    },
  });
}
