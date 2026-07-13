import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { Closure, ClosureIn } from "./types";

export const closureKeys = {
  all: ["closures"] as const,
  list: () => [...closureKeys.all, "list"] as const,
};

/**
 * Unfiltered, mirroring useDuty(): volume is a handful of dates per year
 * (M5 plan, Task 2 - no bulk UK-bank-holiday import either, for the same
 * reason), so there's no need for a date-range query param on the frontend
 * even though the backend supports one.
 */
export function useClosures() {
  return useQuery({
    queryKey: closureKeys.list(),
    queryFn: () => apiClient.get<Closure[]>("/closures"),
  });
}

export function useCreateClosure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClosureIn) => apiClient.post<Closure>("/closures", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: closureKeys.all });
    },
  });
}

export function useDeleteClosure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiClient.delete<void>(`/closures/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: closureKeys.all });
    },
  });
}