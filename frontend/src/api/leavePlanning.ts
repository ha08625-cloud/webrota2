import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { weekdaysInMonth } from "@/lib/planningMonth";

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
 * `useExtraSessions(null, null)`, the two sibling reads the Annual Planner grid
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
  return useQuery(coverageQuery(fromDate, toDate));
}

/**
 * The key and fetcher for one coverage range, shared by `useCoverage` and
 * `fetchYearCoverage` so the two cannot drift: the export's twelve
 * imperative fetches must land on exactly the cache entries the mounted
 * hook reads, or the month already on screen is fetched twice.
 */
function coverageQuery(fromDate: string, toDate: string) {
  return {
    queryKey: leavePlanningKeys.coverage(fromDate, toDate),
    queryFn: () =>
      apiClient.get<CoverageSlot[]>(
        `/leave-planning/coverage?from_date=${fromDate}&to_date=${toDate}`,
      ),
  };
}

/**
 * How long a coverage range fetched for the export counts as fresh. The
 * point is only that the twelve `fetchQuery` calls resolve from cache
 * where one is already there (and are not immediately refetched by the
 * mounted `useCoverage`); five minutes is long enough for one export and
 * short enough that it never becomes the page's effective policy.
 */
const EXPORT_COVERAGE_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * The server's coverage baseline for a whole leave year, month by month,
 * for the Excel export.
 *
 * Twelve calls rather than one: `GET /leave-planning/coverage` caps a
 * range at 62 days (MAX_COVERAGE_RANGE_DAYS), and the cap is there to stop
 * the endpoint being used as an unbounded scan of the leave table, so it
 * is worked with rather than widened. Each range is the *padded* month -
 * `weekdaysInMonth` end to end, borrowed lead-in/lead-out days included -
 * for two reasons: those columns are on the sheet and need totals like any
 * other, and it is the exact range the page's own `useCoverage` is keyed
 * on, so the month currently on screen is served from cache. Adjacent
 * months therefore overlap by up to four days, and January's range can
 * start in the previous December; that is correct, those cells are drawn.
 *
 * This is the frontend's only use of `fetchQuery`: everything else here is
 * a mounted hook, but an export is a one-off imperative read of twelve
 * ranges that no component displays, which is precisely what `fetchQuery`
 * is for.
 */
export async function fetchYearCoverage(
  queryClient: QueryClient,
  year: number,
): Promise<Map<number, CoverageSlot[]>> {
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const results = await Promise.all(
    months.map((month) => {
      const dates = weekdaysInMonth(year, month);
      return queryClient.fetchQuery({
        ...coverageQuery(dates[0], dates[dates.length - 1]),
        staleTime: EXPORT_COVERAGE_STALE_TIME_MS,
      });
    }),
  );
  return new Map(months.map((month, index) => [month, results[index]]));
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
