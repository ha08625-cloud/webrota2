import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { LeaveEntry, LeaveIn } from "./types";

export const leaveKeys = {
  all: ["leave"] as const,
  list: (doctorId: number | null) => [...leaveKeys.all, "list", doctorId] as const,
};

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
    },
  });
}

export function useDeleteLeave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/leave/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    },
  });
}