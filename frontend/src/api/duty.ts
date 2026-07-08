import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { DutyAssignment, DutyIn } from "./types";

export const dutyKeys = {
  all: ["duty"] as const,
  list: () => [...dutyKeys.all, "list"] as const,
};

/**
 * No filtering per the M4 plan's Task 6 scope ("table of assignments per
 * the duty API") - unlike Leave, no doctor/date filter was called for.
 */
export function useDuty() {
  return useQuery({
    queryKey: dutyKeys.list(),
    queryFn: () => apiClient.get<DutyAssignment[]>("/duty"),
  });
}

export function useCreateDuty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: DutyIn) => apiClient.post<DutyAssignment>("/duty", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dutyKeys.all });
    },
  });
}

export function useDeleteDuty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/duty/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dutyKeys.all });
    },
  });
}