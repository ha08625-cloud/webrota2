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

/** Unfiltered - unlike leave, no doctor/date filter was called for. */
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
/**
 * Year-scoped, because the duty count it adjusts is: the grid reads a whole
 * calendar year, and by the next 1 January the count restarts and every
 * doctor is level again.
 *
 * `target_count` is the *effective total* the counter should read for that
 * year, not the adjustment: the server stores `target_count - raw_count`
 * derived against the 1 Jan-31 Dec count. The total sent must therefore be a
 * whole-year total - `GET /duty/counts` will happily count a narrower range,
 * and a total typed against one of those would store a delta the caller did
 * not mean. Sending a total equal to the raw count deletes the row
 * server-side, so the table holds only real deviations.
 *
 * Invalidates every duty key, not just the counts for this year: the counts
 * query key includes the range, and the adjustment applies to whichever range
 * starts in `year`.
 */
export interface DutyAdjustmentIn {
  doctor_id: number;
  year: number;
  target_count: string;
}

export function useSetDutyAdjustment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: DutyAdjustmentIn) =>
      apiClient.put<DutyCount>("/duty/adjustment", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dutyKeys.all });
    },
  });
}
