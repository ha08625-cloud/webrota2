import { QueryClient } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type { CoverageSlot } from "@/api/types";
import { weekdaysInMonth } from "@/lib/planningMonth";
import { server } from "@/test/msw/server";

import { fetchYearCoverage, leavePlanningKeys } from "./leavePlanning";

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Records every coverage range the network was actually asked for, and
 * answers each with one slot naming its own range - enough to tell the
 * twelve months apart without building real coverage data. */
function captureCoverageRanges() {
  const ranges: string[] = [];
  server.use(
    http.get("/api/v1/leave-planning/coverage", ({ request }) => {
      const params = new URL(request.url).searchParams;
      const from = params.get("from_date") ?? "";
      const to = params.get("to_date") ?? "";
      ranges.push(`${from}..${to}`);
      return HttpResponse.json([
        { date: from, period: "AM", headcount: 1, is_closed: false },
      ] satisfies CoverageSlot[]);
    }),
  );
  return ranges;
}

describe("fetchYearCoverage", () => {
  it("returns all twelve months, each over its padded weekday range", async () => {
    const ranges = captureCoverageRanges();

    const byMonth = await fetchYearCoverage(freshClient(), 2026);

    expect(byMonth.size).toBe(12);
    for (let month = 1; month <= 12; month++) {
      const dates = weekdaysInMonth(2026, month);
      const expected = `${dates[0]}..${dates[dates.length - 1]}`;
      expect(ranges).toContain(expected);
      // The month's slots are the ones fetched for that month's range,
      // not a neighbour's - adjacent padded ranges overlap by up to four
      // days, so keying them off by range is the only honest check.
      expect(byMonth.get(month)?.[0].date).toBe(dates[0]);
    }
    expect(ranges).toHaveLength(12);
  });

  it("uses the padded range, not the calendar month", async () => {
    const ranges = captureCoverageRanges();

    await fetchYearCoverage(freshClient(), 2026);

    // January 2026 opens on a Thursday, so the grid borrows the Monday and
    // Tuesday of the previous December to complete the first week. It ends
    // on Friday the 30th, January's last weekday, with nothing borrowed.
    expect(ranges).toContain("2025-12-29..2026-01-30");
  });

  it("serves a range already in the cache without refetching it", async () => {
    const queryClient = freshClient();
    const augustDates = weekdaysInMonth(2026, 8);
    const cached: CoverageSlot[] = [
      { date: augustDates[0], period: "PM", headcount: 9, is_closed: false },
    ];
    // Exactly what a mounted useCoverage leaves behind for the month on
    // screen. If the key construction in fetchYearCoverage ever drifts
    // from useCoverage's, this entry is missed and August is refetched.
    queryClient.setQueryData(
      leavePlanningKeys.coverage(augustDates[0], augustDates[augustDates.length - 1]),
      cached,
    );

    const ranges = captureCoverageRanges();
    const byMonth = await fetchYearCoverage(queryClient, 2026);

    expect(ranges).toHaveLength(11);
    expect(ranges).not.toContain(
      `${augustDates[0]}..${augustDates[augustDates.length - 1]}`,
    );
    expect(byMonth.get(8)).toEqual(cached);
  });
});
