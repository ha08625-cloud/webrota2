import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "./client";
import { extraSessionKeys } from "./extraSessions";
import { leaveKeys } from "./leave";
import { rotaKeys } from "./rota";
import type { BlockedEntry, CoverageSlot, PlanningBulkIn, PlanningBulkOut } from "./types";

export const leavePlanningKeys = {
  all: ["leave-planning"] as const,
  coverage: (fromDate: string, toDate: string) =>
    [...leavePlanningKeys.all, "coverage", fromDate, toDate] as const,
  blocked: ["leave-planning", "blocked"] as const,
};

/**
 * All `BlockedEntry` rows, unfiltered - mirrors `useLeave(null)` /
 * `useExtraSessions(null)`, the two sibling reads the Annual Planner grid
 * already fetches whole. There is no ad-hoc write surface for blocked
 * entries; the only writer is `useApplyPlanningBulk` below.
 */
export function useBlockedEntries() {
  return useQuery({
    queryKey: leavePlanningKeys.blocked,
    queryFn: () => apiClient.get<BlockedEntry[]>("/leave-planning/blocked"),
  });
}

/**
 * Clinical headcount per (date, period) across a weekday range. Both
 * bounds are inclusive "YYYY-MM-DD"; the server omits weekends entirely
 * rather than returning them as zero, and caps the range at 62 days.
 *
 * Read-only and deliberately live - closures, leave, extra sessions and
 * the employment window are all read from their current tables, since
 * this is forward planning rather than the rendering of an existing
 * rota. The planning page recomputes the same numbers client-side for
 * unsaved edits (see lib/planningMonth.ts), so this query is the
 * baseline, not the whole answer on screen.
 */
export function useCoverage(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: leavePlanningKeys.coverage(fromDate, toDate),
    queryFn: () =>
      apiClient.get<CoverageSlot[]>(
        `/leave-planning/coverage?from_date=${fromDate}&to_date=${toDate}`,
      ),
  });
}

/**
 * Applies a whole grid's worth of edits in one transaction. Invalidates
 * leave and extra sessions (both of which it writes) plus the coverage
 * baseline, and - like useBulkCreateLeave - the rota prefix too: adding
 * leave releases the matching rooms on the active draft, so a rota view
 * open elsewhere needs to refetch.
 */
export function useApplyPlanningBulk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PlanningBulkIn) =>
      apiClient.post<PlanningBulkOut>("/leave-planning/bulk", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leaveKeys.all });
      queryClient.invalidateQueries({ queryKey: extraSessionKeys.all });
      queryClient.invalidateQueries({ queryKey: leavePlanningKeys.all });
      queryClient.invalidateQueries({ queryKey: rotaKeys.all });
    },
  });
}
