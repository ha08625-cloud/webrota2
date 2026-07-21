import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import type { DutyAssignment, DutyIn, DutyCount } from "./types";

export interface DutyCountsRange {
  from: string;
  to: string;
}

export const dutyKeys = {
  all: ["duty"] as const,
  list: () => [...dutyKeys.all, "list"] as const,
  counts: (range?: DutyCountsRange) =>
    range
      ? ([...dutyKeys.all, "counts", range.from, range.to] as const)
      : ([...dutyKeys.all, "counts"] as const),
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

/**
 * When `range` is omitted, fetches unfiltered (all-time) counts. The
 * 4-weekly duty periods feature (see lib/date.ts) always passes a range
 * scoped to the selected period; the unranged form is kept only so any
 * other caller/test relying on the old behaviour is not silently changed.
 */
export function useDutyCounts(range?: DutyCountsRange) {
  return useQuery({
    queryKey: dutyKeys.counts(range),
    queryFn: () =>
      apiClient.get<DutyCount[]>(
        range ? `/duty/counts?from_date=${range.from}&to_date=${range.to}` : "/duty/counts",
      ),
  });
}