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
  list: (doctorId: number | null, year: number | null) =>
    [...leaveKeys.all, "list", doctorId, year] as const,
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

/**
 * Leave entries, optionally narrowed to one doctor and one calendar year -
 * the year shared by the Session Management tabs, see
 * SessionManagementTabs.tsx. Either argument being null means "unfiltered on
 * that axis": doctorId=null is the "all doctors" option in the filter
 * select, year=null is every entry regardless of date (what the planner and
 * the overlap preview need, since neither is bounded by the selected year).
 */
export function useLeave(doctorId: number | null, year: number | null) {
  return useQuery({
    queryKey: leaveKeys.list(doctorId, year),
    queryFn: () => {
      const params = new URLSearchParams();
      if (doctorId !== null) params.set("doctor_id", String(doctorId));
      if (year !== null) {
        params.set("from_date", `${year}-01-01`);
        params.set("to_date", `${year}-12-31`);
      }
      const query = params.toString();
      return apiClient.get<LeaveEntry[]>(query ? `/leave?${query}` : "/leave");
    },
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
